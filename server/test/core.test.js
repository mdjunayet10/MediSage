import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FREE_MODEL, loadConfig } from "../src/config.js";
import { buildOpenRouterPayload, callOpenRouter } from "../src/openrouter.js";
import {
  extractAssistantText,
  isInternalClassifierText,
  validateAssistantAnswer,
} from "../src/aiResponse.js";
import { chatDataSchema } from "../src/contracts.js";
import { evaluateSafety } from "../src/safety.js";
import { chunkPages } from "../src/pdf.js";
import { LexicalIndex } from "../src/retrieval.js";
import { DocumentStore } from "../src/documents.js";
import { ensureGroundedCitation, validateCitations } from "../src/index.js";
import { relatedQuestions } from "../src/suggestions.js";

test("default and fallback models remain strictly free-only", () => {
  const config = loadConfig({});
  assert.equal(config.model, DEFAULT_FREE_MODEL);
  assert.ok(
    config.fallbackModels.every(
      (model) => model === "openrouter/free" || model.endsWith(":free"),
    ),
  );
  assert.throws(
    () => loadConfig({ OPENROUTER_MODEL: "openai/gpt-4.1" }),
    /FREE_ONLY/,
  );
  assert.throws(
    () =>
      loadConfig({ OPENROUTER_FREE_MODELS: "openrouter/free,openai/gpt-4.1" }),
    /every OPENROUTER_FREE_MODELS/,
  );
});

test("one response extractor reads string and text-part content from the correct field", () => {
  assert.equal(
    extractAssistantText({
      choices: [{ message: { content: "  Actual answer  " } }],
    }),
    "Actual answer",
  );
  assert.equal(
    extractAssistantText({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "Part one" },
              { type: "text", text: "Part two" },
            ],
          },
        },
      ],
    }),
    "Part one\nPart two",
  );
  assert.throws(
    () => extractAssistantText({ choices: [] }),
    /incomplete response/,
  );
});

test("internal classifier output is rejected as an assistant answer", () => {
  for (const value of [
    "safe",
    "unsafe",
    "medical_safe",
    "User Safety: safe",
    "emergency false",
    "urgent",
  ]) {
    assert.equal(isInternalClassifierText(value), true);
    assert.throws(
      () => validateAssistantAnswer(value),
      /internal status|incomplete/,
    );
  }
});

test("retry moves from an invalid routed answer to a specific free model only", async () => {
  const requestedModels = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    requestedModels.push(request.model);
    const content =
      requestedModels.length === 1
        ? "User Safety: safe"
        : "High blood pressure means pressure in the arteries remains higher than normal over time.";
    return new Response(
      JSON.stringify({
        model: request.model,
        choices: [{ message: { content } }],
      }),
      { status: 200 },
    );
  };
  const config = loadConfig({
    OPENROUTER_API_KEY: "test",
    OPENROUTER_FREE_MODELS: "openrouter/free,openai/gpt-oss-20b:free",
  });
  const result = await callOpenRouter({
    config,
    fetchImpl,
    messages: [{ role: "user", content: "Explain hypertension." }],
  });
  assert.equal(requestedModels.length, 2);
  assert.ok(
    requestedModels.every(
      (model) => model === "openrouter/free" || model.endsWith(":free"),
    ),
  );
  assert.match(result.answer, /blood pressure/i);
  assert.equal(result.attempts, 2);
});

test("non-retryable authentication failure makes only one attempt", async () => {
  let attempts = 0;
  const config = loadConfig({
    OPENROUTER_API_KEY: "bad",
    OPENROUTER_FREE_MODELS: "openrouter/free,openai/gpt-oss-20b:free",
  });
  await assert.rejects(
    () =>
      callOpenRouter({
        config,
        fetchImpl: async () => {
          attempts += 1;
          return new Response(JSON.stringify({ error: {} }), { status: 401 });
        },
        messages: [{ role: "user", content: "hello" }],
      }),
    /not configured correctly/,
  );
  assert.equal(attempts, 1);
});

test("OpenRouter payload is text-only and contains no file parser fields", () => {
  const payload = buildOpenRouterPayload({
    model: "openrouter/free",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  assert.equal(payload.messages[0].content, "hello");
  assert.doesNotMatch(
    JSON.stringify(payload),
    /"type":"file"|file_data|file-parser/,
  );
});

test("safety analysis remains separate and produces an urgent warning", () => {
  const result = evaluateSafety({
    message: "I have severe chest pain and difficulty breathing.",
  });
  assert.equal(result.level, "urgent");
  assert.equal(result.requiresUrgentCare, true);
  assert.match(result.warning, /emergency/i);
  assert.equal("answer" in result, false);
});

test("chat contract rejects classifier labels and validates a real answer", () => {
  const base = {
    groundingType: "general",
    sources: [],
    relatedQuestions: [],
    safety: { level: "normal", requiresUrgentCare: false, warning: null },
  };
  assert.throws(() =>
    chatDataSchema.parse({ ...base, answer: "User Safety: safe" }),
  );
  assert.equal(
    chatDataSchema.parse({
      ...base,
      answer:
        "Hypertension means blood pressure remains elevated over time and can affect long-term health.",
    }).answer.length > 30,
    true,
  );
});

test("PDF chunks preserve pages and document-scoped retrieval", () => {
  const chunks = chunkPages(
    [
      { page: 2, text: "A".repeat(900) },
      { page: 7, text: "Kidney filtration ".repeat(60) },
    ],
    { documentId: "active", filename: "notes.pdf" },
  );
  assert.equal(chunks[0].page, 2);
  assert.equal(chunks.at(-1).page, 7);
  assert.equal(chunks[0].id, "PDF-S1");
  const results = new LexicalIndex(chunks).search("kidney filtration", 6);
  assert.ok(results.every((result) => result.documentId === "active"));
});

test("invalid citations are removed and expired documents cannot be read", () => {
  assert.equal(
    validateCitations("Supported [S1]. Invented [S99].", [{ id: "S1" }]),
    "Supported [S1]. Invented.",
  );
  assert.equal(
    ensureGroundedCitation("A grounded answer without an inline marker.", [
      { id: "S1" },
    ]),
    "A grounded answer without an inline marker.\n\nSource: [S1]",
  );
  assert.equal(
    ensureGroundedCitation("A general answer without sources.", []),
    "A general answer without sources.",
  );
  let now = 1000;
  const store = new DocumentStore({ ttlMs: 100, now: () => now });
  store.set({ id: "doc" });
  now = 1101;
  assert.equal(store.get("doc"), null);
});

test("related-question chains do not repeat their own prompt wording", () => {
  const questions = relatedQuestions({
    question: "What are the key points to remember about high blood pressure?",
    groundingType: "general",
  });
  assert.match(questions[0], /about high blood pressure/i);
  assert.doesNotMatch(
    questions[0],
    /key points to remember about the key points/i,
  );
});
