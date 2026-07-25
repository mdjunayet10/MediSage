import { z } from "zod";

const contentPartSchema = z
  .object({ type: z.string(), text: z.string().optional() })
  .passthrough();
const providerPayloadSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.union([z.string(), z.array(contentPartSchema)]),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
    usage: z.unknown().optional(),
  })
  .passthrough();

const CLASSIFIER_ONLY =
  /^(?:user\s+safety\s*:\s*)?(?:safe|unsafe|medical_safe|medical_unsafe|classification passed|moderation result|emergency\s*(?:true|false)|normal|caution|urgent)[.!\s]*$/i;

export class AppError extends Error {
  constructor(code, message, status = 502, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
  }
}

export function extractAssistantText(payload) {
  const parsed = providerPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "INVALID_AI_RESPONSE",
      "The assistant returned an incomplete response.",
      502,
      { retryable: true },
    );
  }
  const content = parsed.data.choices[0].message.content;
  const text =
    typeof content === "string"
      ? content.trim()
      : content
          .filter((item) => item.type === "text" && item.text)
          .map((item) => item.text.trim())
          .filter(Boolean)
          .join("\n")
          .trim();
  if (!text)
    throw new AppError(
      "INVALID_AI_RESPONSE",
      "The assistant returned an incomplete response.",
      502,
      { retryable: true },
    );
  return text;
}

export function validateAssistantAnswer(value, { minimumLength = 30 } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(
      "INVALID_AI_RESPONSE",
      "The assistant returned an incomplete response.",
      502,
      { retryable: true },
    );
  }
  const answer = value.trim();
  if (CLASSIFIER_ONLY.test(answer) || /^user\s+safety\s*:/i.test(answer)) {
    throw new AppError(
      "INVALID_AI_RESPONSE",
      "The assistant returned an internal status instead of an answer.",
      502,
      { retryable: true },
    );
  }
  if (answer.length < minimumLength) {
    throw new AppError(
      "INVALID_AI_RESPONSE",
      "The assistant response was incomplete.",
      502,
      { retryable: true },
    );
  }
  return answer;
}

export function isInternalClassifierText(value) {
  return (
    typeof value === "string" &&
    (CLASSIFIER_ONLY.test(value.trim()) ||
      /^user\s+safety\s*:/i.test(value.trim()))
  );
}
