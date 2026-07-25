import { isFreeModel } from "./config.js";
import {
  AppError,
  extractAssistantText,
  validateAssistantAnswer,
} from "./aiResponse.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function buildOpenRouterPayload({
  model,
  messages,
  temperature = 0.2,
  maxTokens = 1600,
}) {
  if (!isFreeModel(model))
    throw new AppError(
      "MODEL_NOT_ALLOWED",
      "The assistant configuration is invalid.",
      500,
    );
  return {
    model,
    messages: messages.map((message) => ({
      role: message.role,
      content: messageText(message.content),
    })),
    temperature,
    max_tokens: maxTokens,
  };
}

function providerError(status, payload) {
  const message =
    status === 401
      ? "The assistant is not configured correctly."
      : [429, 502, 503, 504].includes(status)
        ? "The assistant is temporarily unavailable. Please try again shortly."
        : "The assistant could not complete this request.";
  return new AppError(
    status === 401 ? "INVALID_API_KEY" : "AI_SERVICE_ERROR",
    message,
    status,
    { retryable: status === 408 || status === 429 || status >= 500 },
  );
}

function diagnostic(config, event) {
  if (config.diagnostics)
    console.info("[ai-diagnostic]", JSON.stringify(event));
}

async function requestModel({
  model,
  messages,
  temperature,
  maxTokens,
  config,
  fetchImpl,
  timeoutMs,
  requestId,
  attempt,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.appUrl,
        "X-OpenRouter-Title": config.appName,
      },
      body: JSON.stringify(
        buildOpenRouterPayload({ model, messages, temperature, maxTokens }),
      ),
    });
    const raw = await response.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    diagnostic(config, {
      requestId,
      attempt,
      route: "chat/completions",
      configuredModel: model,
      status: response.status,
      hasChoices: Array.isArray(payload?.choices),
      choiceContentType: Array.isArray(payload?.choices?.[0]?.message?.content)
        ? "array"
        : typeof payload?.choices?.[0]?.message?.content,
    });
    if (!response.ok) throw providerError(response.status, payload);
    const answer = validateAssistantAnswer(extractAssistantText(payload));
    diagnostic(config, {
      requestId,
      attempt,
      selectedModel: payload.model || model,
      finalAnswerLength: answer.length,
    });
    return {
      answer,
      content: answer,
      model: payload.model || model,
      usage: payload.usage || null,
      attempts: attempt,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError(
        "AI_TIMEOUT",
        "The assistant is temporarily unavailable. Please try again shortly.",
        504,
        { retryable: true },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callOpenRouter({
  messages,
  temperature = 0.2,
  maxTokens = 1600,
  config,
  fetchImpl = fetch,
  requestId,
}) {
  if (!config.apiKey)
    throw new AppError(
      "AI_NOT_CONFIGURED",
      "The assistant is not configured correctly.",
      503,
    );
  const startedAt = Date.now();
  let lastError;
  for (let index = 0; index < config.fallbackModels.length; index += 1) {
    const remaining = config.aiOverallTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    try {
      return await requestModel({
        model: config.fallbackModels[index],
        messages,
        temperature,
        maxTokens,
        config,
        fetchImpl,
        timeoutMs: Math.min(config.aiAttemptTimeoutMs, remaining),
        requestId,
        attempt: index + 1,
      });
    } catch (error) {
      lastError = error;
      diagnostic(config, {
        requestId,
        attempt: index + 1,
        errorCode: error.code || "UNKNOWN",
        retryable: Boolean(error.retryable),
      });
      if (!error.retryable || index === config.fallbackModels.length - 1)
        throw error;
    }
  }
  throw (
    lastError ||
    new AppError(
      "AI_TIMEOUT",
      "The assistant is temporarily unavailable. Please try again shortly.",
      504,
    )
  );
}
