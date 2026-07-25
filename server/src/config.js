import { z } from "zod";

export const DEFAULT_FREE_MODEL = "openrouter/free";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).optional(),
    PORT: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),
    CLIENT_ORIGIN: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().optional(),
    OPENROUTER_FREE_MODELS: z.string().optional(),
    FREE_ONLY: z.string().optional(),
    APP_NAME: z.string().optional(),
    APP_URL: z.string().optional(),
    FIREBASE_PROJECT_ID: z.string().optional(),
    HF_DATASET_NAME: z.string().optional(),
    HF_DATASET_FILE: z.string().optional(),
    HF_DATASET_REQUIRED: z.string().optional(),
    HF_RETRIEVAL_TOP_K: z.string().optional(),
    HF_RETRIEVAL_MIN_SCORE: z.string().optional(),
    MAX_PDF_MB: z.string().optional(),
    MAX_PDF_PAGES: z.string().optional(),
    MAX_EXTRACTED_CHARACTERS: z.string().optional(),
    DOCUMENT_TTL_MINUTES: z.string().optional(),
    MAX_CHAT_HISTORY: z.string().optional(),
    RATE_LIMIT_REQUESTS: z.string().optional(),
    RATE_LIMIT_WINDOW_MINUTES: z.string().optional(),
    AI_OVERALL_TIMEOUT_MS: z.string().optional(),
    AI_ATTEMPT_TIMEOUT_MS: z.string().optional(),
    DEBUG_AI: z.string().optional(),
    MAX_ATTACHMENT_MB: z.string().optional(),
    MAX_SPREADSHEET_ROWS: z.string().optional(),
    MAX_IMAGE_PIXELS: z.string().optional(),
    MAX_ATTACHMENTS_PER_USER: z.string().optional(),
    MAX_ATTACHMENTS_PER_MESSAGE: z.string().optional(),
    ATTACHMENT_WORKER_CONCURRENCY: z.string().optional(),
    ATTACHMENT_TIMEOUT_MS: z.string().optional(),
    GUEST_SESSION_SECRET: z.string().optional(),
    GUEST_SESSION_HOURS: z.string().optional(),
  })
  .passthrough();

const DEFAULT_CORS_ORIGINS = [
  "https://medi-sage.web.app",
  "https://medi-sage.firebaseapp.com",
  "http://localhost:5173",
];

export function isFreeModel(model) {
  return model === DEFAULT_FREE_MODEL || model.endsWith(":free");
}

function positiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

export function loadConfig(env = process.env) {
  const values = environmentSchema.parse(env);
  const model = (values.OPENROUTER_MODEL || DEFAULT_FREE_MODEL).trim();
  if (!isFreeModel(model)) {
    throw new Error(
      `FREE_ONLY configuration error: OPENROUTER_MODEL must be "${DEFAULT_FREE_MODEL}" or end with ":free". Received "${model}".`,
    );
  }

  if (values.FREE_ONLY && values.FREE_ONLY.toLowerCase() !== "true") {
    throw new Error(
      "FREE_ONLY configuration error: FREE_ONLY must be true. Paid mode is not supported.",
    );
  }

  const fallbackModels = (
    values.OPENROUTER_FREE_MODELS || `${model},openai/gpt-oss-20b:free`
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    !fallbackModels.length ||
    fallbackModels.some((item) => !isFreeModel(item))
  ) {
    throw new Error(
      'FREE_ONLY configuration error: every OPENROUTER_FREE_MODELS entry must be openrouter/free or end with ":free".',
    );
  }

  const firebaseProjectId = (values.FIREBASE_PROJECT_ID || "").trim();
  const allowedOrigins = (
    values.CORS_ORIGINS ||
    values.CLIENT_ORIGIN ||
    DEFAULT_CORS_ORIGINS.join(",")
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return Object.freeze({
    nodeEnv: values.NODE_ENV || "development",
    appName: values.APP_NAME || "MediSage",
    appUrl: values.APP_URL || "https://medi-sage.web.app",
    apiKey: (values.OPENROUTER_API_KEY || "").trim(),
    model,
    fallbackModels: [...new Set(fallbackModels)].slice(0, 3),
    freeOnly: true,
    port: positiveNumber(values.PORT, 8080),
    allowedOrigins: [...new Set(allowedOrigins)],
    maxPdfMb: positiveNumber(values.MAX_PDF_MB, 20),
    maxPdfPages: positiveNumber(values.MAX_PDF_PAGES, 300),
    maxExtractedCharacters: positiveNumber(
      values.MAX_EXTRACTED_CHARACTERS,
      2_000_000,
    ),
    documentTtlMinutes: positiveNumber(values.DOCUMENT_TTL_MINUTES, 60, 5),
    maxChatHistory: positiveNumber(values.MAX_CHAT_HISTORY, 20, 2),
    rateLimitRequests: positiveNumber(values.RATE_LIMIT_REQUESTS, 80, 5),
    rateLimitWindowMinutes: positiveNumber(values.RATE_LIMIT_WINDOW_MINUTES, 15),
    aiOverallTimeoutMs: positiveNumber(
      values.AI_OVERALL_TIMEOUT_MS,
      55_000,
      10_000,
    ),
    aiAttemptTimeoutMs: positiveNumber(
      values.AI_ATTEMPT_TIMEOUT_MS,
      45_000,
      5_000,
    ),
    diagnostics:
      values.DEBUG_AI === "true" && values.NODE_ENV !== "production",
    hfDatasetName: (
      values.HF_DATASET_NAME || "ruslanmv/ai-medical-dataset"
    ).trim(),
    hfDatasetFile: (
      values.HF_DATASET_FILE || "server/data/hf_medical_knowledge.jsonl"
    ).trim(),
    hfDatasetRequired: booleanValue(values.HF_DATASET_REQUIRED, true),
    hfRetrievalTopK: positiveNumber(values.HF_RETRIEVAL_TOP_K, 6, 1),
    hfRetrievalMinScore: Math.min(
      1,
      positiveNumber(values.HF_RETRIEVAL_MIN_SCORE, 0.18, 0),
    ),
    maxAttachmentMb: positiveNumber(values.MAX_ATTACHMENT_MB, 20),
    maxSpreadsheetRows: positiveNumber(values.MAX_SPREADSHEET_ROWS, 20_000),
    maxImagePixels: positiveNumber(values.MAX_IMAGE_PIXELS, 25_000_000),
    maxAttachmentsPerUser: positiveNumber(values.MAX_ATTACHMENTS_PER_USER, 10),
    maxAttachmentsPerMessage: positiveNumber(
      values.MAX_ATTACHMENTS_PER_MESSAGE,
      5,
      1,
    ),
    attachmentWorkerConcurrency: positiveNumber(
      values.ATTACHMENT_WORKER_CONCURRENCY,
      2,
      1,
    ),
    attachmentTimeoutMs: positiveNumber(
      values.ATTACHMENT_TIMEOUT_MS,
      120_000,
      10_000,
    ),
    firebaseProjectId,
    guestSessionSecret: (values.GUEST_SESSION_SECRET || "").trim(),
    guestSessionHours: positiveNumber(values.GUEST_SESSION_HOURS, 24, 1),
  });
}
