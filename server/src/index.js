import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import dotenv from "dotenv";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { callOpenRouter } from "./openrouter.js";
import { validateAssistantAnswer } from "./aiResponse.js";
import { chatDataSchema, errorEnvelope, successEnvelope } from "./contracts.js";
import { evaluateSafety } from "./safety.js";
import {
  buildMedicalSystemPrompt,
  PDF_SUMMARY_PROMPT,
} from "./medicalPrompt.js";
import {
  HF_DATASET_NAME,
  HF_DATASET_URL,
  MedicalKnowledgeBase,
} from "./knowledge.js";
import { DocumentStore } from "./documents.js";
import { buildSummaryContext, extractPdf } from "./pdf.js";
import { inspectAttachmentFile, parseAttachment } from "./attachments.js";
import { normalizeScores } from "./retrieval.js";
import {
  detectedLanguage,
  documentSuggestions,
  relatedQuestions,
} from "./suggestions.js";
import { createRequireAuth } from "../middleware/requireAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env"), quiet: true });
dotenv.config({ quiet: true });

export function sanitizeFilename(value = "document.pdf") {
  const basename = path.basename(value).normalize("NFKC");
  const safe = basename
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (safe || "document.pdf").slice(0, 160);
}

export function hasPdfSignature(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  );
}

export function validateCitations(answer, sources) {
  const allowed = new Set(sources.map((source) => source.id));
  return answer
    .replace(/【([A-Za-z]+\d+)】/g, "[$1]")
    .replace(/\[([A-Za-z]+\d+)\]/g, (match, id) =>
      allowed.has(id) ? match : "",
    )
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function ensureGroundedCitation(answer, sources) {
  const validated = validateCitations(answer, sources);
  if (!sources.length || /\[(?:DOC|HF)\d+\]/.test(validated)) return validated;
  return `${validated}\n\nSource: [${sources[0].id}]`;
}

function documentSources(chunks) {
  return chunks.map((chunk, index) => ({
    id: `DOC${index + 1}`,
    stableId: chunk.id,
    type: "document",
    title: chunk.filename,
    ...(chunk.page ? { page: chunk.page } : {}),
    location:
      chunk.location ||
      (chunk.page ? { page: chunk.page } : { section: "Document" }),
    excerpt: chunk.excerpt,
    score: chunk.score ?? 1,
  }));
}

function contextFromDocument(chunks) {
  return chunks
    .map(
      (chunk, index) =>
        `[DOC${index + 1}]\nFile: ${chunk.filename}\nLocation: ${JSON.stringify(chunk.location || { page: chunk.page })}\nContent: ${chunk.text}`,
    )
    .join("\n\n");
}

function contextFromDataset(records) {
  return records
    .map(
      (record, index) =>
        `[HF${index + 1}]\nDataset: ${HF_DATASET_NAME}\nRecord: ${record.recordId}\nQuestion: ${record.question}\nContext: ${record.context}`,
    )
    .join("\n\n");
}

export function retrieveDocument(document, question) {
  const requestedPage = question.match(/\bpage\s+(\d{1,4})\b/i)?.[1];
  if (requestedPage) {
    return document.chunks
      .filter((chunk) => chunk.page === Number(requestedPage))
      .slice(0, 6)
      .map((chunk) => ({ ...chunk, score: 1 }));
  }
  return normalizeScores(
    document.index
      .search(question, 6)
      .filter(
        (chunk) =>
          chunk.documentId === document.id || chunk.attachmentId === document.id,
      ),
  );
}

// Compatibility alias retained for existing integrations.
export const retrievePdf = retrieveDocument;

function isDatasetProvenanceQuestion(message) {
  const normalized = message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /hugging\s*face|ruslanmv\s+ai\s+medical\s+dataset|(?:which|what|your|medical|use|using|used).{0,45}dataset|dataset.{0,45}(?:using|used|source|name|your)|where.{0,30}medical knowledge|training data|ডেটাসেট|হাগিং\s*ফেস/u.test(
    normalized,
  );
}

function provenanceAnswer(outputLanguage, message) {
  const bangla = detectedLanguage(message, outputLanguage) === "bn";
  return bangla
    ? `MediSage Hugging Face-এর ${HF_DATASET_NAME} dataset-কে retrieval knowledge source হিসেবে ব্যবহার করে। প্রাসঙ্গিক record উত্তর তৈরির model-কে supporting context হিসেবে দেওয়া হতে পারে। এর অর্থ এই নয় যে underlying language model-টি MediSage এই dataset দিয়ে train করেছে। Dataset page: ${HF_DATASET_URL}`
    : `MediSage uses ${HF_DATASET_NAME} from Hugging Face as a retrieval knowledge source. Relevant records may be supplied to the answer-generation model as supporting context. This does not mean the underlying language model was trained by MediSage on that dataset. Dataset page: ${HF_DATASET_URL}`;
}

function wantsSupplementalDataset(message) {
  return /\b(compare|comparison|outside (?:the )?document|broader|general medical context|supplement(?:al)?)\b/i.test(
    message,
  );
}

function createRateLimiter(config, keyResolver = (req) => req.ip || req.socket.remoteAddress || "unknown") {
  const clients = new Map();
  const windowMs = config.rateLimitWindowMinutes * 60_000;
  return (req, res, next) => {
    const key = keyResolver(req);
    const now = Date.now();
    const entry = clients.get(key);
    if (!entry || entry.resetAt <= now) {
      clients.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > config.rateLimitRequests) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      res
        .status(429)
        .json(
          errorEnvelope(
            "RATE_LIMITED",
            "You’ve reached the temporary usage limit. Please try again later.",
            req.requestId,
          ),
        );
      return;
    }
    next();
  };
}

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(12_000),
});
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

export function chatRequestSchema(maxHistory = 20, maxAttachments = 5) {
  return z
    .object({
      message: z.string().trim().max(12_000).default(""),
      messageId: z.string().trim().min(1).max(120),
      conversationId: z.string().trim().min(1).max(120),
      requestId: z.string().trim().min(1).max(120).optional(),
      messages: z.array(messageSchema).max(Math.max(0, maxHistory - 1)).default([]),
      attachmentIds: z.array(z.string().uuid()).max(maxAttachments).default([]),
      documentId: z.string().uuid().nullable().optional(),
      responseMode: responseModeSchema.default("balanced"),
      outputLanguage: outputLanguageSchema.default("auto"),
    })
    .superRefine((value, context) => {
      if (!value.message && !value.attachmentIds.length && !value.documentId) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "A message or attachment is required." });
      }
    });
}

function providerAnswer(result) {
  return validateAssistantAnswer(result?.answer ?? result?.content);
}

function providerMeta(config, result) {
  return config.diagnostics
    ? { selectedModel: result.model, attempts: result.attempts || 1 }
    : {};
}

function outputDirective(outputLanguage, message = "") {
  if (outputLanguage === "bn")
    return "Mandatory output requirement: write the entire explanatory answer in clear, natural Bangla. Keep only helpful medical English terms in parentheses.";
  if (outputLanguage === "en")
    return "Mandatory output requirement: write the explanatory answer in English.";
  return detectedLanguage(message, "auto") === "bn"
    ? "Mandatory output requirement: match the Bangla or Bangla-English style of the question naturally and include Bangla text in the answer."
    : "Mandatory output requirement: match the English language of the question.";
}

function languageNeedsCorrection(answer, outputLanguage, message = "") {
  const banglaCharacters = (answer.match(/[\u0980-\u09FF]/g) || []).length;
  const latinCharacters = (answer.match(/[A-Za-z]/g) || []).length;
  const target = detectedLanguage(message, outputLanguage);
  if (target === "bn") return banglaCharacters < 12;
  return (
    outputLanguage === "en" &&
    banglaCharacters > 20 &&
    banglaCharacters > latinCharacters
  );
}

async function generateLanguageCompliantAnswer({
  provider,
  providerParams,
  outputLanguage,
  message,
}) {
  let result = await provider(providerParams);
  let answer = providerAnswer(result);
  if (languageNeedsCorrection(answer, outputLanguage, message)) {
    result = await provider({
      ...providerParams,
      messages: [
        ...providerParams.messages,
        {
          role: "user",
          content: `Rewrite the answer to the original request so it obeys this requirement exactly:\n${outputDirective(outputLanguage, message)}\n\nOriginal request:\n${message}\n\nAnswer to rewrite:\n${answer}`,
        },
      ],
    });
    answer = providerAnswer(result);
    if (languageNeedsCorrection(answer, outputLanguage, message)) {
      const error = new Error(
        "The assistant could not produce the answer in the selected language. Please retry.",
      );
      error.code = "INVALID_AI_RESPONSE";
      error.status = 502;
      error.retryable = true;
      throw error;
    }
  }
  return { result, answer };
}

export async function createApp(options = {}) {
  const config = options.config || loadConfig();
  const provider =
    options.provider || ((params) => callOpenRouter({ ...params, config }));
  const pdfExtractor = options.pdfExtractor || extractPdf;
  const attachmentParser = options.attachmentParser || parseAttachment;
  const knowledgeBase =
    options.knowledgeBase ||
    new MedicalKnowledgeBase({
      filePath: config.hfDatasetFile,
      required: config.hfDatasetRequired,
      datasetName: config.hfDatasetName,
      minScore: config.hfRetrievalMinScore,
    });
  if (!knowledgeBase.loaded) await knowledgeBase.load();
  const store =
    options.documentStore ||
    new DocumentStore({
      ttlMs: config.documentTtlMinutes * 60_000,
      maxDocuments: Math.max(20, config.maxAttachmentsPerUser * 20),
      onDelete: (attachment) => {
        if (attachment.tempPath) unlink(attachment.tempPath).catch(() => {});
      },
    });
  const guestSecret = config.guestSessionSecret || randomBytes(32).toString("base64url");
  const signGuestToken = (guest) => {
    const payload = Buffer.from(JSON.stringify(guest)).toString("base64url");
    const signature = createHmac("sha256", guestSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  };
  const verifyGuestToken = (token) => {
    if (!token || !token.includes(".")) return null;
    const [payload, signature] = token.split(".");
    const expected = createHmac("sha256", guestSecret).update(payload).digest("base64url");
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
    const guest = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!guest.uid || guest.type !== "guest" || guest.expiresAt <= Date.now()) return null;
    return guest;
  };
  const requireAuth = createRequireAuth({
    verifyIdToken: options.authVerifier,
    verifyGuestToken,
    projectId: config.firebaseProjectId,
  });
  const uidRateLimiter = createRateLimiter(config, (req) => `uid:${req.user.uid}`);
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
      credentials: true,
      methods: ["GET", "POST", "DELETE", "PATCH", "PUT", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      optionsSuccessStatus: 204,
      origin(origin, callback) {
        if (
          !origin ||
          config.allowedOrigins.includes(origin)
        )
          callback(null, true);
        else {
          const error = new Error("This website is not allowed to access the API.");
          error.code = "CORS_ORIGIN_DENIED";
          error.status = 403;
          callback(error);
        }
      },
    }),
  );
  app.use("/api", createRateLimiter(config));
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (req, res) => {
    res.json({ success: true, service: "MediSage API" });
  });

  app.post("/api/session/guest", (req, res) => {
    const now = Date.now();
    const existingToken = String(req.get("cookie") || "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("medisage_guest="))
      ?.slice("medisage_guest=".length);
    const existingGuest = verifyGuestToken(existingToken ? decodeURIComponent(existingToken) : null);
    const guest = existingGuest || {
      uid: `guest_${randomUUID()}`,
      type: "guest",
      createdAt: now,
      expiresAt: now + config.guestSessionHours * 60 * 60_000,
    };
    res.cookie("medisage_guest", signGuestToken(guest), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: config.guestSessionHours * 60 * 60_000,
      path: "/",
    });
    return res.status(201).json(successEnvelope({
      sessionId: guest.uid,
      type: "guest",
      createdAt: new Date(guest.createdAt).toISOString(),
      expiresAt: new Date(guest.expiresAt).toISOString(),
    }, req.requestId));
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, os.tmpdir()),
      filename: (_req, _file, callback) => callback(null, `medisage-${randomUUID()}.upload`),
    }),
    limits: {
      fileSize: config.maxAttachmentMb * 1024 * 1024,
      files: 1,
      fields: 8,
    },
  });

  const processingQueue = [];
  let activeAttachmentJobs = 0;

  function attachmentMetadata(attachment) {
    return {
      id: attachment.id,
      name: attachment.filename,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      extension: attachment.extension,
      size: attachment.size,
      type: attachment.kind || attachment.extension,
      kind: attachment.kind || attachment.extension,
      status: attachment.status,
      processingStatus: attachment.stage,
      stage: attachment.stage,
      progress: attachment.progress,
      scope: attachment.scope,
      pageCount: attachment.pageCount ?? null,
      rowCount: attachment.rowCount ?? null,
      sheetCount: attachment.sheetCount ?? null,
      topics: attachment.topics || [],
      warnings: attachment.warnings || [],
      error: attachment.publicError || null,
      createdAt: new Date(attachment.createdAt).toISOString(),
      expiresAt: new Date(attachment.expiresAt).toISOString(),
      uploadedAt: new Date(attachment.createdAt).toISOString(),
    };
  }

  function runNextAttachmentJob() {
    while (
      activeAttachmentJobs < config.attachmentWorkerConcurrency &&
      processingQueue.length
    ) {
      const job = processingQueue.shift();
      activeAttachmentJobs += 1;
      job()
        .catch(() => {})
        .finally(() => {
          activeAttachmentJobs -= 1;
          runNextAttachmentJob();
        });
    }
  }

  function enqueueAttachmentProcessing(attachmentId) {
    const attachment = store.get(attachmentId, { refresh: false });
    if (!attachment || attachment.status === "ready")
      return attachment?.processingPromise || Promise.resolve(attachment);
    if (attachment.processingPromise) return attachment.processingPromise;

    const processingPromise = new Promise((resolve) => {
      processingQueue.push(async () => {
        const current = store.get(attachmentId, { refresh: false });
        if (!current) return resolve(null);
        const startedAt = performance.now();
        let buffer;
        try {
          store.update(attachmentId, {
            status: "processing",
            stage: "extracting",
            progress: 20,
            publicError: null,
            processingAttempts: (current.processingAttempts || 0) + 1,
          });
          buffer = await readFile(current.tempPath);
          const extracted = await attachmentParser(buffer, {
            attachmentId,
            filename: current.filename,
            mimeType: current.mimeType,
            maxPages: config.maxPdfPages,
            maxCharacters: config.maxExtractedCharacters,
            maxSpreadsheetRows: config.maxSpreadsheetRows,
            maxImagePixels: config.maxImagePixels,
            timeoutMs: config.attachmentTimeoutMs,
            pdfExtractor,
          });
          buffer.fill(0);
          const live = store.get(attachmentId, { refresh: false });
          if (!live) return resolve(null);
          store.update(attachmentId, { stage: "indexing", progress: 85 });
          for (const chunk of extracted.chunks) {
            chunk.ownerId = live.ownerId;
            chunk.conversationId = live.conversationId;
            if (chunk.location?.rowStart) {
              chunk.location.rowRange = {
                start: chunk.location.rowStart,
                end: chunk.location.rowEnd,
              };
            }
          }
          const completed = store.update(attachmentId, {
            status: "ready",
            stage: "complete",
            progress: 100,
            kind: extracted.kind,
            mimeType: extracted.mimeType,
            extension:
              extracted.extension?.replace(/^\./, "") || live.extension,
            pageCount: extracted.pageCount ?? null,
            rowCount: extracted.rowCount ?? null,
            sheetCount: extracted.sheetCount ?? null,
            characterCount: extracted.characterCount,
            chunks: extracted.chunks,
            index: extracted.index,
            warnings: extracted.warnings || [],
            topics: documentSuggestions(
              { ...live, chunks: extracted.chunks },
              live.outputLanguage,
            ).slice(0, 3),
            extractionMs: Math.round(performance.now() - startedAt),
            processingPromise: null,
            tempPath: null,
          });
          await unlink(current.tempPath).catch(() => {});
          if (config.diagnostics) {
            console.info(
              JSON.stringify({
                requestId: current.requestId,
                attachmentId,
                extractionMs: completed?.extractionMs,
                processingAttempts: completed?.processingAttempts,
              }),
            );
          }
          resolve(completed);
        } catch (error) {
          const failed = store.update(attachmentId, {
            status: "failed",
            stage: "failed",
            progress: 100,
            publicError:
              error?.status && error.status < 500
                ? error.message
                : "Attachment processing failed. Retry or choose another file.",
            processingPromise: null,
            extractionMs: Math.round(performance.now() - startedAt),
          });
          resolve(failed);
        } finally {
          buffer?.fill(0);
        }
      });
      runNextAttachmentJob();
    });
    store.update(attachmentId, { processingPromise });
    return processingPromise;
  }

  app.get("/api/health", (req, res) => {
    res.json(
      successEnvelope(
        {
          service: "medisage-api",
          status: "ready",
          aiProvider: {
            configured: Boolean(config.apiKey),
          },
          dataset: {
            name: config.hfDatasetName,
            loaded: Boolean(knowledgeBase.loaded),
            records: knowledgeBase.records.length,
          },
        },
        req.requestId,
        { timestamp: new Date().toISOString() },
      ),
    );
  });

  const uploadAttachment = async (req, res, next) => {
    const requestStartedAt = performance.now();
    try {
      if (!req.file)
        return res
          .status(400)
          .json(
            errorEnvelope(
              "FILE_REQUIRED",
              "Choose a supported attachment first.",
              req.requestId,
            ),
          );
      if (store.countForOwner(req.user.uid) >= config.maxAttachmentsPerUser) {
        return res
          .status(429)
          .json(
            errorEnvelope(
              "ATTACHMENT_LIMIT",
              `You can keep up to ${config.maxAttachmentsPerUser} temporary attachments. Remove one and try again.`,
              req.requestId,
            ),
          );
      }
      const uploadOptions = z
        .object({
          conversationId: z.string().trim().min(1).max(120),
          requestId: z.string().trim().min(1).max(120).optional(),
          outputLanguage: outputLanguageSchema.default("auto"),
          responseMode: responseModeSchema.default("balanced"),
          scope: z.enum(["message", "conversation"]).default("conversation"),
        })
        .safeParse(req.body || {});
      if (!uploadOptions.success)
        return res
          .status(400)
          .json(
            errorEnvelope(
              "INVALID_DOCUMENT_REQUEST",
              "The document options are invalid. Review them and try again.",
              req.requestId,
            ),
          );
      const {
        conversationId,
        outputLanguage,
        responseMode,
        requestId,
        scope,
      } = uploadOptions.data;
      const correlationId = requestId || req.requestId;
      const id = randomUUID();
      const filename = sanitizeFilename(req.file.originalname);
      const size = req.file.size;
      const validationStartedAt = performance.now();
      const inspected = await inspectAttachmentFile(
        req.file.path,
        filename,
        req.file.mimetype,
      );
      const attachment = store.set({
        id,
        ownerId: req.user.uid,
        conversationId,
        filename,
        size,
        kind: inspected.kind,
        mimeType: inspected.detectedMime,
        extension: inspected.extension.replace(/^\./, ""),
        status: "uploaded",
        stage: "queued",
        progress: 100,
        scope,
        pageCount: null,
        rowCount: null,
        sheetCount: null,
        topics: [],
        warnings: [],
        chunks: [],
        tempPath: req.file.path,
        requestId: correlationId,
        outputLanguage,
        responseMode,
        validationMs: Math.round(performance.now() - validationStartedAt),
        uploadAcknowledgementMs: Math.round(performance.now() - requestStartedAt),
      });
      enqueueAttachmentProcessing(id);
      if (config.diagnostics) {
        console.info(
          JSON.stringify({
            requestId: correlationId,
            attachmentId: id,
            uploadAcknowledgementMs: attachment.uploadAcknowledgementMs,
            validationMs: attachment.validationMs,
          }),
        );
      }
      return res.status(202).json(
        successEnvelope(
          { attachment: attachmentMetadata(attachment) },
          correlationId,
          { conversationId },
        ),
      );
    } catch (error) {
      if (req.file?.path) await unlink(req.file.path).catch(() => {});
      next(error);
    }
  };

  app.post(
    "/api/attachments",
    requireAuth,
    uidRateLimiter,
    upload.single("file"),
    uploadAttachment,
  );
  app.post(
    "/api/documents",
    requireAuth,
    uidRateLimiter,
    upload.single("file"),
    uploadAttachment,
  );

  app.get("/api/attachments/:id/status", requireAuth, uidRateLimiter, (req, res) => {
    const existing = store.get(req.params.id, { refresh: false });
    if (existing && existing.ownerId !== req.user.uid) {
      return res.status(403).json(
        errorEnvelope(
          "ATTACHMENT_FORBIDDEN",
          "You do not have access to this attachment.",
          req.requestId,
        ),
      );
    }
    const attachment = store.get(req.params.id, { ownerId: req.user.uid });
    if (!attachment) {
      return res.status(410).json(
        errorEnvelope(
          "ATTACHMENT_EXPIRED",
          "This temporary attachment is no longer available.",
          req.requestId,
        ),
      );
    }
    return res.json(
      successEnvelope(attachmentMetadata(attachment), req.requestId, {
        conversationId: attachment.conversationId,
      }),
    );
  });

  app.post("/api/attachments/:id/retry", requireAuth, uidRateLimiter, (req, res) => {
    const existing = store.get(req.params.id, { refresh: false });
    if (existing && existing.ownerId !== req.user.uid) {
      return res.status(403).json(
        errorEnvelope(
          "ATTACHMENT_FORBIDDEN",
          "You do not have access to this attachment.",
          req.requestId,
        ),
      );
    }
    if (!existing) {
      return res.status(410).json(
        errorEnvelope(
          "ATTACHMENT_EXPIRED",
          "This temporary attachment is no longer available.",
          req.requestId,
        ),
      );
    }
    if (existing.status !== "failed" || !existing.tempPath || !fs.existsSync(existing.tempPath)) {
      return res.status(409).json(
        errorEnvelope(
          "ATTACHMENT_NOT_RETRYABLE",
          "This attachment does not require processing retry.",
          req.requestId,
        ),
      );
    }
    const retried = store.update(existing.id, {
      status: "uploaded",
      stage: "queued",
      progress: 100,
      publicError: null,
      processingPromise: null,
    });
    enqueueAttachmentProcessing(existing.id);
    return res.status(202).json(
      successEnvelope(attachmentMetadata(retried), req.requestId, {
        conversationId: existing.conversationId,
      }),
    );
  });

  const deleteAttachment = (req, res) => {
    if (
      store.has(req.params.id) &&
      !store.get(req.params.id, { refresh: false, ownerId: req.user.uid })
    ) {
      return res
        .status(403)
        .json(
          errorEnvelope(
            "ATTACHMENT_FORBIDDEN",
            "You do not have access to this attachment.",
            req.requestId,
          ),
        );
    }
    store.delete(req.params.id, { ownerId: req.user.uid });
    return res.json(
      successEnvelope(
        { deleted: true, attachmentId: req.params.id },
        req.requestId,
      ),
    );
  };
  app.delete("/api/attachments/:id", requireAuth, uidRateLimiter, deleteAttachment);
  app.delete("/api/documents/:id", requireAuth, uidRateLimiter, deleteAttachment);

  app.post("/api/chat", requireAuth, uidRateLimiter, async (req, res, next) => {
    try {
      const parsed = chatRequestSchema(
        config.maxChatHistory,
        config.maxAttachmentsPerMessage,
      ).safeParse(req.body);
      const candidateConversationId =
        typeof req.body?.conversationId === "string"
          ? req.body.conversationId
          : undefined;
      if (!parsed.success)
        return res
          .status(400)
          .json(
            errorEnvelope(
              "INVALID_CHAT_REQUEST",
              "The message or response settings are invalid. Review them and try again.",
              req.body?.requestId || req.requestId,
              { conversationId: candidateConversationId },
            ),
          );
      const {
        message,
        messageId,
        messages,
        conversationId,
        requestId,
        attachmentIds,
        documentId,
        outputLanguage,
        responseMode,
      } = parsed.data;
      const correlationId = requestId || req.requestId;
      const effectiveAttachmentIds = [
        ...new Set([...attachmentIds, ...(documentId ? [documentId] : [])]),
      ];
      const safetyResult = evaluateSafety({
        message: message || "Attachment overview",
        conversationContext: [
          ...messages.slice(-5),
          { role: "user", content: message },
        ],
      });
      if (message && isDatasetProvenanceQuestion(message)) {
        const data = chatDataSchema.parse({
          answer: provenanceAnswer(outputLanguage, message),
          groundingType: "general",
          sources: [],
          relatedQuestions: [],
          safety: { level: "normal", requiresUrgentCare: false, warning: null },
        });
        return res.json(
          successEnvelope(data, correlationId, {
            conversationId,
            deterministic: true,
          }),
        );
      }

      const documents = [];
      for (const attachmentId of effectiveAttachmentIds) {
        let attachment = store.get(attachmentId, { refresh: false });
        if (attachment && attachment.ownerId !== req.user.uid) {
          return res.status(403).json(
            errorEnvelope(
              "ATTACHMENT_FORBIDDEN",
              "You do not have access to this attachment.",
              correlationId,
              { conversationId },
            ),
          );
        }
        if (attachment && attachment.conversationId !== conversationId) {
          return res.status(403).json(
            errorEnvelope(
              "ATTACHMENT_CONVERSATION_MISMATCH",
              "This attachment does not belong to the selected conversation.",
              correlationId,
              { conversationId },
            ),
          );
        }
        if (!attachment) {
          return res.status(410).json(
            errorEnvelope(
              "ATTACHMENT_EXPIRED",
              "This temporary attachment is no longer available. Upload it again to continue.",
              correlationId,
              { conversationId },
            ),
          );
        }
        if (["uploaded", "processing"].includes(attachment.status)) {
          await attachment.processingPromise;
          attachment = store.get(attachmentId, { ownerId: req.user.uid });
        }
        if (!attachment || attachment.status === "failed") {
          return res.status(422).json(
            errorEnvelope(
              "ATTACHMENT_PROCESSING_FAILED",
              attachment?.publicError || "The attachment could not be processed.",
              correlationId,
              { conversationId },
            ),
          );
        }
        documents.push(attachment);
      }

      let groundingType = "general";
      let sources = [];
      let groundingContext = "";
      if (documents.length) {
        groundingType = "document";
        const retrieved = message
          ? documents
              .flatMap((document) => retrieveDocument(document, message))
              .slice(0, 12)
          : documents.flatMap(
              (document) =>
                buildSummaryContext(document.chunks, 12_000).selected,
            );
        sources = documentSources(retrieved);
        groundingContext = retrieved.length
          ? contextFromDocument(retrieved)
          : "No passage in the active document matched this question. State that the document does not contain enough evidence; do not invent a source.";
        if (message && retrieved.length && wantsSupplementalDataset(message)) {
          const datasetRecords = knowledgeBase.search(
            message,
            config.hfRetrievalTopK,
            config.hfRetrievalMinScore,
          );
          if (datasetRecords.length) {
            groundingType = "hybrid";
            sources.push(
              ...datasetRecords.map((record, index) =>
                knowledgeBase.toSource(record, `HF${index + 1}`),
              ),
            );
            groundingContext += `\n\nSUPPLEMENTAL DATASET CONTEXT\n${contextFromDataset(datasetRecords)}`;
          }
        }
      } else {
        let retrievalQuery = message;
        if (
          detectedLanguage(message, "auto") === "bn" &&
          knowledgeBase.records.length
        ) {
          try {
            const translation = await provider({
              requestId: correlationId,
              temperature: 0,
              maxTokens: 120,
              messages: [
                {
                  role: "system",
                  content:
                    "Translate the user medical query into concise English search keywords. Return only the English query.",
                },
                { role: "user", content: message },
              ],
            });
            const translated = String(
              translation?.answer ?? translation?.content ?? "",
            ).trim();
            if (translated && translated.length < 500)
              retrievalQuery = `${message} ${translated}`;
          } catch {
            /* The original query remains usable if translation is unavailable. */
          }
        }
        const retrieved = knowledgeBase.search(
          retrievalQuery,
          config.hfRetrievalTopK,
          config.hfRetrievalMinScore,
        );
        if (retrieved.length) {
          groundingType = "dataset";
          sources = retrieved.map((record, index) =>
            knowledgeBase.toSource(record, `HF${index + 1}`),
          );
          groundingContext = contextFromDataset(retrieved);
        }
      }

      const providerParams = {
        requestId: correlationId,
        messages: [
          {
            role: "system",
            content: buildMedicalSystemPrompt({
              outputLanguage,
              groundingType,
              hasDocumentContext: Boolean(documents.length),
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
            content: message
              ? `${message}\n\n${outputDirective(outputLanguage, message)}`
              : `${PDF_SUMMARY_PROMPT.replaceAll("PDF", "ATTACHMENT").replaceAll("page numbers", "locations")}\n\nThe user sent attachment files without text. Confirm receipt, provide a concise structured overview, identify main topics and format-specific details, and suggest useful next actions. Do not claim the user typed an instruction.\n\n${outputDirective(outputLanguage, documents.map((item) => item.filename).join(" "))}`,
          },
        ],
        temperature: 0.2,
        maxTokens: 1700,
      };
      const generated = await generateLanguageCompliantAnswer({
        provider,
        providerParams,
        outputLanguage,
        message: message || documents.map((item) => item.filename).join(" "),
      });
      const generationResult = generated.result;
      const answer = ensureGroundedCitation(generated.answer, sources);
      const data = chatDataSchema.parse({
        answer,
        groundingType,
        sources,
        relatedQuestions: relatedQuestions({
          question:
            message ||
            `Overview of ${documents.map((item) => item.filename).join(", ")}`,
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
          attachmentIds: effectiveAttachmentIds,
          ...providerMeta(config, generationResult),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", (req, res) => {
    return res.status(404).json(
      errorEnvelope(
        "API_NOT_FOUND",
        "The requested API endpoint does not exist.",
        req.requestId,
      ),
    );
  });

  app.use((req, res) => {
    return res.status(404).json(
      errorEnvelope(
        "NOT_FOUND",
        "The requested service endpoint does not exist.",
        req.requestId,
      ),
    );
  });

  app.use((error, req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res
        .status(tooLarge ? 413 : 400)
        .json(
          errorEnvelope(
            tooLarge ? "ATTACHMENT_TOO_LARGE" : "UPLOAD_ERROR",
            tooLarge
              ? `The attachment is too large. The limit is ${config.maxAttachmentMb} MB.`
              : "The file could not be uploaded.",
            req.requestId,
          ),
        );
    }
    const status = Number(error?.status) || 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    const code = error?.code || "SERVER_ERROR";
    const message =
      safeStatus === 402
        ? "The assistant is temporarily unavailable. Please try again shortly."
        : safeStatus >= 500 && code === "SERVER_ERROR"
          ? "Something went wrong. Please try again."
          : error?.message || "Something went wrong. Please try again.";
    const conversationId =
      typeof req.body?.conversationId === "string"
        ? req.body.conversationId
        : undefined;
    return res.status(safeStatus).json(
      errorEnvelope(code, message, req.body?.requestId || req.requestId, {
        conversationId,
      }),
    );
  });

  return { app, config, store, knowledgeBase };
}

export function listenForRequests(
  app,
  { port, host = "0.0.0.0", onListening = () => {} },
) {
  return app.listen(port, host, onListening);
}

export async function startServer(options = {}) {
  try {
    const created = await createApp(options);
    const server = listenForRequests(created.app, {
      port: created.config.port,
      host: "0.0.0.0",
      onListening: () => {
        console.log(`MediSage API listening on ${created.config.port}`);
      },
    });
    server.on("listening", () => {
      console.log(
        `Medical knowledge records loaded: ${created.knowledgeBase.records.length}`,
      );
    });
    return { ...created, server };
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startServer().catch(() => {});
