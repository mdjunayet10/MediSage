import { signOut } from "firebase/auth";
import { auth } from "./firebase.js";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(
  /\/$/,
  "",
);
const INTERNAL_LABEL =
  /^(?:user\s+safety\s*:\s*)?(?:safe|unsafe|medical_safe|medical_unsafe|classification passed|moderation result|emergency\s*(?:true|false)|normal|caution|urgent)[.!\s]*$/i;
const HTML_DOCUMENT =
  /(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>])/i;

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    Object.assign(this, options);
  }
}

export function buildApiUrl(resource) {
  return joinApiUrl(API_BASE_URL, resource);
}

export function joinApiUrl(baseUrl, resource) {
  const path = String(resource || "");
  if (/^https?:\/\//i.test(path)) return path;
  const base = String(baseUrl || "").replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function isHtmlDocument(value) {
  return typeof value === "string" && HTML_DOCUMENT.test(value.trim());
}

export async function authenticatedFetch(
  resource,
  options = {},
  currentUser = auth?.currentUser,
) {
  const request = async (forceRefresh = false) => {
    const token = currentUser
      ? await currentUser.getIdToken(forceRefresh)
      : null;
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(buildApiUrl(resource), {
      credentials: API_BASE_URL ? "omit" : "same-origin",
      ...options,
      headers,
    });
  };
  let response = await request(false);
  if (response.status === 401 && currentUser) {
    response = await request(true);
    if (response.status === 401 && auth) await signOut(auth).catch(() => {});
  }
  return response;
}

export function isValidAssistantAnswer(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= 30 &&
    !isHtmlDocument(value) &&
    !/^\s*[\[{][\s\S]*[\]}]\s*$/.test(value) &&
    !INTERNAL_LABEL.test(value.trim()) &&
    !/^user\s+safety\s*:/i.test(value.trim())
  );
}

export async function parseApiResponse(response) {
  const contentType = response.headers?.get?.("content-type") || "";
  let body = "";
  let payload;
  if (typeof response.text === "function") {
    body = await response.text();
  } else if (typeof response.json === "function") {
    payload = await response.json();
    body = JSON.stringify(payload);
  }
  if (contentType.includes("text/html") || isHtmlDocument(body)) {
    throw new ApiError(
      "The AI service is not connected correctly. Please try again shortly.",
      {
        status: response.status,
        code: "INVALID_API_RESPONSE",
        retryable: true,
      },
    );
  }
  if (payload === undefined) {
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {
      throw new ApiError(
        "The AI service returned an invalid response. Please try again.",
        {
          status: response.status,
          code: "INVALID_JSON_RESPONSE",
          retryable: true,
        },
      );
    }
  }
  if (!contentType.includes("application/json") && !payload) {
    throw new ApiError(
      "The AI service returned an invalid response. Please try again.",
      {
        status: response.status,
        code: "INVALID_JSON_RESPONSE",
        retryable: true,
      },
    );
  }
  if (!response.ok || payload?.success !== true) {
    throw new ApiError(
      payload?.error?.message ||
        `The request could not be completed (${response.status}).`,
      {
        status: response.status,
        code: payload?.error?.code || "REQUEST_FAILED",
        requestId: payload?.meta?.requestId,
        retryable:
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
      },
    );
  }
  return payload;
}

export function requireValidChatData(payload) {
  const data = payload?.data;
  if (!isValidAssistantAnswer(data?.answer)) {
    const error = new Error(
      "The assistant returned an incomplete response. Please retry.",
    );
    error.code = "INVALID_AI_RESPONSE";
    error.retryable = true;
    throw error;
  }
  if (
    !Array.isArray(data.sources) ||
    !Array.isArray(data.relatedQuestions) ||
    !data.safety
  ) {
    const error = new Error(
      "The assistant response was incomplete. Please retry.",
    );
    error.code = "INVALID_RESPONSE_CONTRACT";
    error.retryable = true;
    throw error;
  }
  return data;
}

export async function sendChat({
  message,
  messageId,
  conversationId,
  requestId,
  messages = [],
  attachmentIds = [],
  attachmentContext = [],
  responseMode,
  outputLanguage,
  signal,
}) {
  const response = await authenticatedFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      messageId,
      conversationId,
      requestId,
      messages,
      attachmentIds,
      attachmentContext,
      responseMode,
      outputLanguage,
    }),
    signal,
  });
  const payload = await parseApiResponse(response);
  if (
    payload.meta?.conversationId !== conversationId ||
    payload.meta?.requestId !== requestId
  ) {
    const error = new Error(
      "The response did not match the conversation request. Please retry.",
    );
    error.code = "CONVERSATION_MISMATCH";
    error.retryable = true;
    throw error;
  }
  return { ...requireValidChatData(payload), meta: payload.meta };
}

export async function translateText({
  text,
  targetLanguage,
  requestId = crypto.randomUUID(),
  signal,
}) {
  const response = await authenticatedFetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, targetLanguage, requestId }),
    signal,
  });
  return (await parseApiResponse(response)).data;
}
