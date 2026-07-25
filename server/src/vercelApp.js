import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { z } from "zod";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { validateAssistantAnswer } from "./aiResponse.js";
import { loadConfig } from "./config.js";
import { chatDataSchema, errorEnvelope, successEnvelope } from "./contracts.js";
import {
  HF_DATASET_NAME,
  HF_DATASET_URL,
  MedicalKnowledgeBase,
} from "./knowledge.js";
import {
  buildMedicalSystemPrompt,
  PDF_SUMMARY_PROMPT,
} from "./medicalPrompt.js";
import { callOpenRouter } from "./openrouter.js";
import { evaluateSafety } from "./safety.js";
import { relatedQuestions } from "./suggestions.js";

const responseModeSchema = z.enum([
  "balanced",
  "concise",
  "detailed",
  "simple",
  "study-notes",
  "comparison",
  "qa",
]);
const outputLanguageSchema = z.enum(["auto", "en", "bn"]);
const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(12_000),
});
const locationSchema = z
  .object({
    page: z.number().int().positive().optional(),
    sheet: z.string().trim().max(120).optional(),
    rowStart: z.number().int().positive().optional(),
    rowEnd: z.number().int().positive().optional(),
    section: z.string().trim().max(160).optional(),
    image: z.number().int().positive().optional(),
  })
  .passthrough();
const attachmentChunkSchema = z.object({
  attachmentId: z.string().trim().min(8).max(120),
  chunkId: z.string().trim().min(8).max(180),
  filename: z.string().trim().min(1).max(180),
  text: z.string().trim().min(1).max(5_000),
  location: locationSchema,
  score: z.number().min(0).max(1).optional(),
});
const chatRequestSchema = z
  .object({
    message: z.string().trim().max(12_000).default(""),
    messageId: z.string().trim().min(1).max(120),
    conversationId: z.string().trim().min(1).max(120),
    requestId: z.string().trim().min(1).max(120).optional(),
    messages: z.array(messageSchema).max(19).default([]),
    attachmentIds: z
      .array(z.string().trim().min(8).max(120))
      .max(5)
      .default([]),
    attachmentContext: z.array(attachmentChunkSchema).max(12).default([]),
    responseMode: responseModeSchema.default("balanced"),
    outputLanguage: outputLanguageSchema.default("auto"),
  })
  .superRefine((value, context) => {
    if (!value.message && !value.attachmentContext.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A message or extracted attachment context is required.",
      });
    }
    const allowed = new Set(value.attachmentIds);
    if (
      value.attachmentContext.some(
        (chunk) => !allowed.has(chunk.attachmentId),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Attachment context does not match the selected attachments.",
      });
    }
  });

const translateRequestSchema = z.object({
  text: z.string().trim().min(20).max(12_000),
  targetLanguage: z.enum(["en", "bn"]),
  requestId: z.string().trim().min(1).max(120).optional(),
});

const DEFAULT_ALLOWED_ORIGINS = [
  "https://medi-sage.web.app",
  "https://medi-sage.firebaseapp.com",
  "http://localhost:5173",
];

function isDatasetProvenanceQuestion(message) {
  return /hugging\s*face|ruslanmv\s+ai\s+medical\s+dataset|(?:which|what|your|medical|use|using|used).{0,45}dataset|dataset.{0,45}(?:using|used|source|name|your)|ডেটাসেট|হাগিং\s*ফেস/iu.test(
    message,
  );
}

function provenanceAnswer(outputLanguage, message) {
  const bangla =
    outputLanguage === "bn" ||
    (outputLanguage === "auto" && /[\u0980-\u09ff]/u.test(message));
  return bangla
    ? `MediSage Hugging Face-এর ${HF_DATASET_NAME} dataset-কে retrieval knowledge source হিসেবে ব্যবহার করে। কেবল সত্যিই retrieve করা record-ই source হিসেবে দেখানো হয়। Dataset page: ${HF_DATASET_URL}`
    : `MediSage uses ${HF_DATASET_NAME} from Hugging Face as a retrieval knowledge source. Only records actually retrieved for the request are shown as sources. Dataset page: ${HF_DATASET_URL}`;
}

function wantsSupplementalDataset(message) {
  return /\b(compare|comparison|outside (?:the )?attachment|broader|general medical context|supplement(?:al)?)\b/i.test(
    message,
  );
}

function contextFromDataset(records) {
  return records
    .map(
      (record, index) =>
        `[HF${index + 1}]\nDataset: ${HF_DATASET_NAME}\nRecord: ${record.recordId}\nQuestion: ${record.question}\nContext: ${record.context}`,
    )
    .join("\n\n");
}

function documentSources(chunks) {
  return chunks.map((chunk, index) => ({
    id: `DOC${index + 1}`,
    stableId: chunk.chunkId,
    attachmentId: chunk.attachmentId,
    type: "document",
    title: chunk.filename,
    location: chunk.location,
    ...(chunk.location.page ? { page: chunk.location.page } : {}),
    excerpt: chunk.text.slice(0, 360),
    score: chunk.score ?? 1,
  }));
}

function contextFromAttachments(chunks) {
  return chunks
    .map(
      (chunk, index) =>
        `[DOC${index + 1}]\nFile: ${chunk.filename}\nLocation: ${JSON.stringify(chunk.location)}\nContent: ${chunk.text}`,
    )
    .join("\n\n");
}

function ensureGroundedCitation(answer, sources) {
  const allowed = new Set(sources.map((source) => source.id));
  const clean = answer
    .replace(/【([A-Za-z]+\d+)】/g, "[$1]")
    .replace(/\[([A-Za-z]+\d+)\]/g, (match, id) =>
      allowed.has(id) ? match : "",
    )
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!sources.length || /\[(?:DOC|HF)\d+\]/.test(clean)) return clean;
  return `${clean}\n\nSource: [${sources[0].id}]`;
}

function outputDirective(outputLanguage, message) {
  if (outputLanguage === "bn")
    return "Write the entire answer in clear, natural Bangla.";
  if (outputLanguage === "en") return "Write the answer in English.";
  return /[\u0980-\u09ff]/u.test(message)
    ? "Match the Bangla or Bangla-English style of the request."
    : "Match the English language of the request.";
}

export async function createVercelApp(options = {}) {
  const config = options.config || loadConfig();
  const provider =
    options.provider || ((params) => callOpenRouter({ ...params, config }));
  const knowledgeBase =
    options.knowledgeBase ||
    new MedicalKnowledgeBase({
      filePath: config.hfDatasetFile,
      required: true,
      datasetName: config.hfDatasetName,
      minScore: config.hfRetrievalMinScore,
    });
  if (!knowledgeBase.loaded) await knowledgeBase.load();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, _res, next) => {
    req.requestId = randomUUID();
    next();
  });
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(
    cors({
      credentials: false,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      optionsSuccessStatus: 204,
      origin(origin, callback) {
        const allowedOrigins = config.allowedOrigins.length
          ? config.allowedOrigins
          : DEFAULT_ALLOWED_ORIGINS;
        if (!origin || allowedOrigins.includes(origin)) callback(null, true);
        else {
          const error = new Error(
            "This website is not allowed to access the API.",
          );
          error.code = "CORS_ORIGIN_DENIED";
          error.status = 403;
          callback(error);
        }
      },
    }),
  );
  app.use(express.json({ limit: "256kb" }));

  const requireAuth = createRequireAuth({
    verifyIdToken: options.authVerifier,
    projectId: config.firebaseProjectId || "medi-sage",
  });

  app.get("/", (_req, res) => {
    res.json({ success: true, service: "MediSage Vercel API" });
  });

  app.get("/api/health", (req, res) => {
    res.json(
      successEnvelope(
        {
          service: "medisage-vercel-api",
          status: "ready",
          runtime: "vercel-node",
          aiProvider: { configured: Boolean(config.apiKey) },
          dataset: {
            name: knowledgeBase.name,
            loaded: knowledgeBase.loaded,
            records: knowledgeBase.records.length,
          },
          attachments: {
            processing: "browser-local",
            fileUploadsAccepted: false,
          },
        },
        req.requestId,
      ),
    );
  });

  app.post("/api/chat", requireAuth, async (req, res, next) => {
    const candidateConversationId =
      typeof req.body?.conversationId === "string"
        ? req.body.conversationId
        : undefined;
    try {
      const parsed = chatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json(
          errorEnvelope(
            "INVALID_CHAT_REQUEST",
            "The message, extracted attachment context, or response settings are invalid.",
            req.body?.requestId || req.requestId,
            { conversationId: candidateConversationId },
          ),
        );
      }
      const {
        message,
        messageId,
        messages,
        conversationId,
        requestId,
        attachmentIds,
        attachmentContext,
        outputLanguage,
        responseMode,
      } = parsed.data;
      const correlationId = requestId || req.requestId;
      const safetyResult = evaluateSafety({
        message: message || "Attachment overview",
      });

      if (message && isDatasetProvenanceQuestion(message)) {
        const data = chatDataSchema.parse({
          answer: provenanceAnswer(outputLanguage, message),
          groundingType: "general",
          sources: [],
          relatedQuestions: [],
          safety: {
            level: "normal",
            requiresUrgentCare: false,
            warning: null,
          },
        });
        return res.json(
          successEnvelope(data, correlationId, {
            conversationId,
            messageId,
            attachmentIds,
            authenticatedUid: req.user.uid,
          }),
        );
      }

      let groundingType = "general";
      let sources = [];
      let groundingContext = "";
      if (attachmentContext.length) {
        groundingType = "document";
        sources = documentSources(attachmentContext);
        groundingContext = contextFromAttachments(attachmentContext);
        if (message && wantsSupplementalDataset(message)) {
          const records = knowledgeBase.search(
            message,
            config.hfRetrievalTopK,
            config.hfRetrievalMinScore,
          );
          if (records.length) {
            groundingType = "hybrid";
            sources.push(
              ...records.map((record, index) =>
                knowledgeBase.toSource(record, `HF${index + 1}`),
              ),
            );
            groundingContext += `\n\nSUPPLEMENTAL DATASET CONTEXT\n${contextFromDataset(records)}`;
          }
        }
      } else {
        const records = knowledgeBase.search(
          message,
          config.hfRetrievalTopK,
          config.hfRetrievalMinScore,
        );
        if (records.length) {
          groundingType = "dataset";
          sources = records.map((record, index) =>
            knowledgeBase.toSource(record, `HF${index + 1}`),
          );
          groundingContext = contextFromDataset(records);
        }
      }

      const userRequest =
        message ||
        `${PDF_SUMMARY_PROMPT.replaceAll("PDF", "ATTACHMENT").replaceAll("page numbers", "locations")}\n\nThe user sent an attachment without text. Confirm receipt and provide a concise structured overview using only the supplied attachment chunks.`;
      const result = await provider({
        requestId: correlationId,
        messages: [
          {
            role: "system",
            content: buildMedicalSystemPrompt({
              outputLanguage,
              groundingType,
              hasDocumentContext: Boolean(attachmentContext.length),
              safetyGuidance: safetyResult.guidance,
              responseMode,
            }),
          },
          ...(groundingContext
            ? [
                {
                  role: "user",
                  content: `GROUNDING CONTEXT\n${groundingContext}`,
                },
              ]
            : []),
          ...messages,
          {
            role: "user",
            content: `${userRequest}\n\n${outputDirective(outputLanguage, message || attachmentContext.map((chunk) => chunk.filename).join(" "))}`,
          },
        ],
        temperature: 0.2,
        maxTokens: 1700,
      });
      const answer = ensureGroundedCitation(
        validateAssistantAnswer(result.answer || result.content),
        sources,
      );
      const data = chatDataSchema.parse({
        answer,
        groundingType,
        sources,
        relatedQuestions: relatedQuestions({
          question: message || "Overview of the selected attachment",
          groundingType,
          outputLanguage,
        }),
        safety: {
          level: safetyResult.level,
          requiresUrgentCare: safetyResult.requiresUrgentCare,
          warning: safetyResult.warning,
        },
      });
      return res.json(
        successEnvelope(data, correlationId, {
          conversationId,
          messageId,
          attachmentIds,
          authenticatedUid: req.user.uid,
          selectedModel:
            config.diagnostics && result.model ? result.model : undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/translate", requireAuth, async (req, res, next) => {
    try {
      const parsed = translateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json(
          errorEnvelope(
            "INVALID_TRANSLATE_REQUEST",
            "Translation text and target language are required.",
            req.body?.requestId || req.requestId,
          ),
        );
      }
      const requestId = parsed.data.requestId || req.requestId;
      const language =
        parsed.data.targetLanguage === "bn" ? "natural Bangla" : "English";
      const result = await provider({
        requestId,
        messages: [
          {
            role: "system",
            content: `Translate the supplied medical educational text into ${language}. Preserve citation IDs such as [DOC1] and [HF1]. Return only the translation.`,
          },
          { role: "user", content: parsed.data.text },
        ],
        temperature: 0,
        maxTokens: 1800,
      });
      return res.json(
        successEnvelope(
          {
            translation: validateAssistantAnswer(
              result.answer || result.content,
              { minimumLength: 10 },
            ),
            targetLanguage: parsed.data.targetLanguage,
          },
          requestId,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", (req, res) => {
    res.status(404).json(
      errorEnvelope(
        "API_NOT_FOUND",
        "The requested API endpoint does not exist.",
        req.requestId,
      ),
    );
  });
  app.use((req, res) => {
    res.status(404).json(
      errorEnvelope(
        "NOT_FOUND",
        "The requested service endpoint does not exist.",
        req.requestId,
      ),
    );
  });
  app.use((error, req, res, _next) => {
    const status = Number(error?.status) || 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    const code = error?.code || "SERVER_ERROR";
    const message =
      safeStatus >= 500 && code === "SERVER_ERROR"
        ? "Something went wrong. Please try again."
        : error?.message || "Something went wrong. Please try again.";
    res.status(safeStatus).json(
      errorEnvelope(code, message, req.body?.requestId || req.requestId, {
        conversationId:
          typeof req.body?.conversationId === "string"
            ? req.body.conversationId
            : undefined,
      }),
    );
  });

  return { app, config, knowledgeBase };
}
