import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  createApp as createServerApp,
  listenForRequests,
} from "../src/index.js";
import { loadConfig } from "../src/config.js";
import { LexicalIndex } from "../src/retrieval.js";

function config(overrides = {}) {
  return loadConfig({
    OPENROUTER_API_KEY: "test-key",
    RATE_LIMIT_REQUESTS: "1000",
    ...overrides,
  });
}
function knowledgeBase() {
  return { loaded: true, records: [], search: () => [], toSource: () => null };
}
function createApp(options = {}) {
  return createServerApp({
    ...options,
    authVerifier:
      options.authVerifier ||
      (async (token) => ({ uid: token, email: `${token}@test.local` })),
  });
}
async function withServer(app, callback) {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
function extractedDocument(documentId, filename) {
  const subject = filename.includes("kidney")
    ? "kidney filtration and renal monitoring"
    : "glucose regulation and pancreatic hormone function";
  const chunks = [
    {
      id: "PDF-S1",
      documentId,
      filename,
      page: 4,
      text: `Page four explains ${subject}.`,
      excerpt: `Page four explains ${subject}.`,
    },
    {
      id: "PDF-S2",
      documentId,
      filename,
      page: 7,
      text: `Page seven of ${filename} discusses treatment limitations.`,
      excerpt: `Page seven of ${filename} discusses treatment limitations.`,
    },
  ];
  return {
    pageCount: 7,
    characterCount: 160,
    chunks,
    index: new LexicalIndex(chunks),
  };
}
function answerFor(messages) {
  const prompt = messages.at(-1)?.content || "";
  if (prompt.includes("ATTACHMENT CONTEXT"))
    return "This document explains its main educational subject and important limitations [DOC1] [DOC2].";
  if (/high blood pressure/i.test(prompt))
    return "High blood pressure, or hypertension, means blood pushes against artery walls with greater force than normal over time. It often has no obvious symptoms and can increase long-term heart, stroke and kidney risks.";
  if (/angina and heart attack/i.test(prompt))
    return "| Angina | Heart attack |\n|---|---|\n| Temporary reduced blood flow | Prolonged blockage causing heart muscle injury |\n\nNew or severe chest pain needs urgent assessment.";
  if (/symptoms of dengue/i.test(prompt))
    return "Common dengue symptoms can include fever, headache, body aches, nausea and rash, but symptoms vary. Severe abdominal pain, persistent vomiting, bleeding or unusual drowsiness require urgent medical care.";
  if (/severe chest pain/i.test(prompt))
    return "Call local emergency services now. Severe chest pain with difficulty breathing can be life-threatening, and an online assistant cannot determine the cause.";
  if (/page 4/i.test(prompt))
    return "Page 4 discusses the subject described in the active document [S1].";
  if (/insulin resistance/i.test(prompt))
    return "The retrieved document does not contain enough information to confirm that insulin resistance is discussed.";
  if (/বাংলা/.test(prompt))
    return "উচ্চ রক্তচাপ (Hypertension) হলো দীর্ঘ সময় ধরে ধমনিতে রক্তের চাপ স্বাভাবিকের চেয়ে বেশি থাকা। নিয়মিত মাপা এবং চিকিৎসকের পরামর্শ নেওয়া গুরুত্বপূর্ণ।";
  return `A complete educational answer for: ${prompt}. It directly addresses the current request without using unrelated conversation content.`;
}
const provider = async ({ messages }) => ({
  answer: answerFor(messages),
  model: "openai/gpt-oss-20b:free",
  attempts: 1,
});
const pdfExtractor = async (_buffer, options) =>
  extractedDocument(options.documentId, options.filename);

async function postChat(url, message, extra = {}) {
  const payload = {
    message,
    messageId: extra.messageId || randomUUID(),
    conversationId: extra.conversationId || "conversation-a",
    requestId: extra.requestId || randomUUID(),
    messages: extra.messages || [],
    documentId: extra.documentId ?? null,
    attachmentIds: extra.attachmentIds || [],
    responseMode: extra.responseMode || "balanced",
    outputLanguage: extra.outputLanguage || "en",
  };
  const response = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${extra.userId || "user-a"}`,
    },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json(), payload };
}

async function uploadDocument(url, name = "lecture.pdf", extra = {}) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([Buffer.from("%PDF-test")], { type: "application/pdf" }),
    name,
  );
  form.append("conversationId", extra.conversationId || "conversation-a");
  form.append("requestId", extra.requestId || randomUUID());
  form.append("responseMode", extra.responseMode || "balanced");
  form.append("outputLanguage", extra.outputLanguage || "en");
  const response = await fetch(`${url}/api/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${extra.userId || "user-a"}` },
    body: form,
  });
  return { response, body: await response.json() };
}

test("legacy Express HTTP contracts stay JSON-only and use the production allowlist", async () => {
  const { app } = await createApp({
    config: config({ OPENROUTER_API_KEY: "" }),
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const root = await fetch(url);
    assert.equal(root.headers.get("content-type")?.includes("application/json"), true);
    assert.deepEqual(await root.json(), {
      success: true,
      service: "MediSage API",
    });

    const health = await fetch(`${url}/api/health`, {
      headers: { Origin: "https://medi-sage.web.app" },
    });
    assert.equal(
      health.headers.get("access-control-allow-origin"),
      "https://medi-sage.web.app",
    );
    const healthBody = await health.json();
    assert.equal(healthBody.success, true);
    assert.deepEqual(healthBody.data.aiProvider, { configured: false });
    assert.deepEqual(healthBody.data.dataset, {
      name: "ruslanmv/ai-medical-dataset",
      loaded: true,
      records: 0,
    });

    const missing = await fetch(`${url}/api/not-real`);
    assert.equal(missing.status, 404);
    assert.equal(
      missing.headers.get("content-type")?.includes("application/json"),
      true,
    );
    assert.equal((await missing.json()).error.code, "API_NOT_FOUND");

    const denied = await fetch(`${url}/api/health`, {
      headers: { Origin: "https://example.invalid" },
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, "CORS_ORIGIN_DENIED");
  });
});

test("legacy Express port and host are passed to a single production listener", () => {
  const configured = loadConfig({ PORT: "9123" });
  assert.equal(configured.port, 9123);
  const calls = [];
  const expectedServer = {};
  const fakeApp = {
    listen(...args) {
      calls.push(args);
      return expectedServer;
    },
  };
  const server = listenForRequests(fakeApp, {
    port: configured.port,
    host: "0.0.0.0",
  });
  assert.equal(server, expectedServer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 9123);
  assert.equal(calls[0][1], "0.0.0.0");
});

test("quality answers use the nested contract and echo request and conversation IDs", async () => {
  const { app } = await createApp({
    config: config(),
    provider,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    for (const [prompt, expected] of [
      ["Explain high blood pressure in simple language.", /artery walls/i],
      ["Compare angina and heart attack.", /heart muscle injury/i],
      ["What are the common symptoms of dengue?", /symptoms vary/i],
    ]) {
      const result = await postChat(url, prompt, {
        conversationId: "clinical-conversation",
      });
      assert.equal(result.response.status, 200);
      assert.match(result.body.data.answer, expected);
      assert.equal(
        result.body.meta.conversationId,
        result.payload.conversationId,
      );
      assert.equal(result.body.meta.requestId, result.payload.requestId);
      assert.doesNotMatch(
        result.body.data.answer,
        /user safety|medical_safe|^safe$/i,
      );
    }
  });
});

test("responseMode and outputLanguage are validated with professional errors", async () => {
  const { app } = await createApp({
    config: config(),
    provider,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const badMode = await postChat(url, "Explain hypertension.", {
      responseMode: "decorative-mode",
    });
    assert.equal(badMode.response.status, 400);
    assert.equal(badMode.body.error.code, "INVALID_CHAT_REQUEST");
    const badLanguage = await postChat(url, "Explain hypertension.", {
      outputLanguage: "fr",
    });
    assert.equal(badLanguage.response.status, 400);
    assert.equal(badLanguage.body.meta.conversationId, "conversation-a");
  });
});

test("selected mode and language instructions reach the provider prompt", async () => {
  const prompts = [];
  const capturingProvider = async ({ messages }) => {
    prompts.push(messages[0].content);
    return {
      answer: /natural Bangla/i.test(messages[0].content)
        ? "এটি নির্বাচিত সেটিং অনুযায়ী তৈরি একটি সম্পূর্ণ ও পরিষ্কার শিক্ষামূলক বাংলা উত্তর।"
        : "This is a sufficiently complete educational response generated for the requested settings.",
    };
  };
  const { app } = await createApp({
    config: config(),
    provider: capturingProvider,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    await postChat(url, "Explain hypertension.", {
      responseMode: "study-notes",
      outputLanguage: "bn",
    });
    assert.match(
      prompts[0],
      /definitions, key points, exam-important information/i,
    );
    assert.match(prompts[0], /Always answer in clear, natural Bangla/i);
    await postChat(url, "Compare arteries and veins.", {
      responseMode: "comparison",
      outputLanguage: "en",
    });
    assert.match(prompts[1], /comparison table/i);
    assert.match(prompts[1], /Always answer in clear, natural English/i);
  });
});

test("safety classification remains separate and cannot replace the answer", async () => {
  const { app } = await createApp({
    config: config(),
    provider,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const { body } = await postChat(
      url,
      "I have severe chest pain and difficulty breathing.",
    );
    assert.match(body.data.answer, /emergency services/i);
    assert.equal(body.data.safety.level, "urgent");
    assert.notEqual(body.data.answer, body.data.safety.level);
  });
});

test("PDF retrieval and page sources stay scoped to the selected active document", async () => {
  const { app } = await createApp({
    config: config(),
    provider,
    pdfExtractor,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const first = await uploadDocument(url, "glucose.pdf");
    const second = await uploadDocument(url, "kidney.pdf");
    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 202);
    assert.ok(["uploaded", "processing"].includes(first.body.data.attachment.status));
    assert.ok(first.body.data.attachment.uploadedAt);
    const page = await postChat(url, "What is on page 4?", {
      attachmentIds: [first.body.data.attachment.id],
    });
    assert.ok(page.body.data.sources.length > 0);
    assert.ok(
      page.body.data.sources.every(
        (source) => source.title === "glucose.pdf" && source.page === 4,
      ),
    );
    assert.ok(
      page.body.data.sources.every((source) => source.title !== "kidney.pdf"),
    );
  });
});

test("unknown documents return the controlled expiry response", async () => {
  const { app } = await createApp({
    config: config(),
    provider,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const result = await postChat(url, "Summarize the document.", {
      documentId: randomUUID(),
    });
    assert.equal(result.response.status, 410);
    assert.equal(result.body.error.code, "ATTACHMENT_EXPIRED");
    assert.equal(
      result.body.error.message,
      "This temporary attachment is no longer available. Upload it again to continue.",
    );
    assert.equal(result.body.meta.conversationId, "conversation-a");
  });
});

test("current messages produce distinct answers and no unrelated cached response is reused", async () => {
  const { app } = await createApp({
    config: config(),
    provider,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const blood = await postChat(url, "Explain high blood pressure.", {
      conversationId: "blood",
    });
    const dengue = await postChat(
      url,
      "What are the common symptoms of dengue?",
      { conversationId: "dengue" },
    );
    assert.match(blood.body.data.answer, /artery walls/i);
    assert.match(dengue.body.data.answer, /fever/i);
    assert.doesNotMatch(blood.body.data.answer, /dengue|zoology/i);
  });
});

test("classifier output is rejected and PDF bytes are never included in provider messages", async () => {
  const seen = [];
  const observingProvider = async ({ messages }) => {
    seen.push(JSON.stringify(messages));
    return {
      answer: "User Safety: safe",
    };
  };
  const { app } = await createApp({
    config: config(),
    provider: observingProvider,
    pdfExtractor,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const uploaded = await uploadDocument(url);
    assert.equal(uploaded.response.status, 202);
    const broken = await postChat(url, "Explain high blood pressure.");
    assert.equal(broken.response.status, 502);
    assert.equal(broken.body.error.code, "INVALID_AI_RESPONSE");
    assert.doesNotMatch(JSON.stringify(broken.body), /"answer"/);
    assert.doesNotMatch(seen.join("\n"), /%PDF-|file_data|application\/pdf/i);
  });
});

test("oversized PDFs and provider failures use professional error contracts", async () => {
  const first = await createApp({
    config: config({ MAX_ATTACHMENT_MB: "1" }),
    provider,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(first.app, async (url) => {
    const bytes = Buffer.alloc(1024 * 1024 + 20, 1);
    bytes.write("%PDF-", 0, "ascii");
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: "application/pdf" }),
      "large.pdf",
    );
    const response = await fetch(`${url}/api/attachments`, {
      method: "POST",
      headers: { Authorization: "Bearer user-a" },
      body: form,
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.equal(body.error.code, "ATTACHMENT_TOO_LARGE");
  });
  const unavailable = async () => {
    const error = new Error("buy credits");
    error.status = 402;
    throw error;
  };
  const second = await createApp({
    config: config(),
    provider: unavailable,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(second.app, async (url) => {
    const { body } = await postChat(url, "Explain hypertension.");
    assert.equal(
      body.error.message,
      "The assistant is temporarily unavailable. Please try again shortly.",
    );
    assert.doesNotMatch(body.error.message, /buy|paid|credits|model/i);
  });
});

test("protected routes reject missing tokens and isolate attachments between users", async () => {
  const { app } = await createApp({
    config: config(),
    provider,
    pdfExtractor,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const unauthorized = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, "AUTH_REQUIRED");

    const uploaded = await uploadDocument(url, "private.pdf", {
      userId: "user-a",
    });
    const forbidden = await postChat(url, "What is on page 4?", {
      documentId: uploaded.body.data.attachment.id,
      userId: "user-b",
    });
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.body.error.code, "ATTACHMENT_FORBIDDEN");
  });
});

test("valid anonymous and registered Firebase identities can both use chat", async () => {
  const { app } = await createApp({
    config: config(),
    provider,
    knowledgeBase: knowledgeBase(),
    authVerifier: async (token) => token === "guest-token"
      ? { uid: "guest-uid", firebase: { sign_in_provider: "anonymous" } }
      : { uid: "registered-uid", email: "learner@example.com", firebase: { sign_in_provider: "password" } },
  });
  await withServer(app, async (url) => {
    const guest = await postChat(url, "Explain high blood pressure.", { userId: "guest-token" });
    const registered = await postChat(url, "Explain high blood pressure.", { userId: "registered-token" });
    assert.equal(guest.response.status, 200);
    assert.equal(registered.response.status, 200);
  });
});

test("server-issued guest cookies authorize chat and isolate temporary attachments", async () => {
  const { app } = await createApp({
    config: config({ GUEST_SESSION_SECRET: "test-guest-secret-with-sufficient-entropy" }),
    provider,
    pdfExtractor,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const firstSession = await fetch(`${url}/api/session/guest`, { method: "POST" });
    const secondSession = await fetch(`${url}/api/session/guest`, { method: "POST" });
    assert.equal(firstSession.status, 201);
    const firstCookie = firstSession.headers.get("set-cookie").split(";")[0];
    const secondCookie = secondSession.headers.get("set-cookie").split(";")[0];

    const form = new FormData();
    form.append("file", new Blob([Buffer.from("%PDF-test")], { type: "application/pdf" }), "guest.pdf");
    form.append("conversationId", "guest-conversation");
    const upload = await fetch(`${url}/api/attachments`, { method: "POST", headers: { Cookie: firstCookie }, body: form });
    const uploaded = await upload.json();
    assert.equal(upload.status, 202);

    const guestChat = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: firstCookie },
      body: JSON.stringify({ message: "Explain high blood pressure.", messageId: randomUUID(), conversationId: "guest-conversation", requestId: randomUUID(), attachmentIds: [], messages: [] }),
    });
    assert.equal(guestChat.status, 200);

    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: secondCookie },
      body: JSON.stringify({
        uid: "guest-controlled-identities-are-ignored",
        message: "Summarize this attachment.",
        messageId: randomUUID(),
        conversationId: "guest-conversation",
        requestId: randomUUID(),
        attachmentIds: [uploaded.data.attachment.id],
        messages: [],
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "ATTACHMENT_FORBIDDEN");
  });
});

test("dataset provenance is deterministic and never calls the model provider", async () => {
  let calls = 0;
  const neverProvider = async () => {
    calls += 1;
    throw new Error("Provider must not be called.");
  };
  const { app } = await createApp({
    config: config(),
    provider: neverProvider,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    for (const question of [
      "Is your dataset from Hugging Face?",
      "Which dataset do you use?",
      "Where does your medical knowledge come from?",
      "Do you use ruslanmv/ai-medical-dataset?",
      "Are you trained using the Hugging Face dataset?",
    ]) {
      const result = await postChat(url, question);
      assert.equal(result.response.status, 200);
      assert.match(result.body.data.answer, /ruslanmv\/ai-medical-dataset/);
      assert.match(result.body.data.answer, /underlying language model/);
      assert.match(result.body.data.answer, /huggingface\.co\/datasets\/ruslanmv\/ai-medical-dataset/);
      assert.doesNotMatch(result.body.data.answer, /curated by Google/i);
      assert.deepEqual(result.body.data.sources, []);
    }
    assert.equal(calls, 0);
  });
});

test("Bangla medical queries use a request-local English retrieval query without changing answer language", async () => {
  let searched = "";
  let calls = 0;
  const banglaKnowledge = {
    loaded: true,
    records: [{ id: "HF-MED-BP" }],
    search: (query) => {
      searched = query;
      return [{ id: "HF-MED-BP", recordId: "HF-MED-BP", dataset: "ruslanmv/ai-medical-dataset", question: "What is hypertension?", context: "Hypertension is persistently elevated blood pressure.", text: "hypertension blood pressure", score: 0.9 }];
    },
    toSource: (record, id) => ({ id, stableId: record.id, type: "dataset", title: "AI Medical Dataset", dataset: record.dataset, recordId: record.recordId, question: record.question, excerpt: record.context, score: record.score, url: "https://huggingface.co/datasets/ruslanmv/ai-medical-dataset" }),
  };
  const banglaProvider = async () => {
    calls += 1;
    return calls === 1
      ? { answer: "hypertension blood pressure explanation" }
      : { answer: "উচ্চ রক্তচাপ (Hypertension) হলো দীর্ঘ সময় ধরে রক্তচাপ স্বাভাবিকের চেয়ে বেশি থাকা। নিয়মিত পরীক্ষা ও চিকিৎসকের পরামর্শ গুরুত্বপূর্ণ [HF1]।" };
  };
  const { app } = await createApp({ config: config(), provider: banglaProvider, knowledgeBase: banglaKnowledge });
  await withServer(app, async (url) => {
    const result = await postChat(url, "উচ্চ রক্তচাপ কী?", { outputLanguage: "bn" });
    assert.equal(result.response.status, 200);
    assert.match(searched, /hypertension blood pressure/);
    assert.match(result.body.data.answer, /[\u0980-\u09FF]/);
    assert.equal(result.body.data.sources[0].id, "HF1");
  });
});

test("upload acknowledgement is independent of extraction and attachment-only chat waits for the same ID", async () => {
  let releaseExtraction;
  let extractionCalls = 0;
  const delayedExtractor = async (_buffer, options) => {
    extractionCalls += 1;
    await new Promise((resolve) => { releaseExtraction = resolve; });
    return extractedDocument(options.documentId, options.filename);
  };
  const { app } = await createApp({
    config: config(),
    provider,
    pdfExtractor: delayedExtractor,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const started = performance.now();
    const uploaded = await uploadDocument(url, "background.pdf");
    const acknowledgementMs = performance.now() - started;
    assert.equal(uploaded.response.status, 202);
    assert.ok(acknowledgementMs < 500, `upload acknowledgement took ${acknowledgementMs}ms`);
    assert.ok(["uploaded", "processing"].includes(uploaded.body.data.attachment.status));
    assert.ok(extractionCalls <= 1);

    const attachmentId = uploaded.body.data.attachment.id;
    const chatPromise = postChat(url, "", { attachmentIds: [attachmentId] });
    for (let attempt = 0; attempt < 20 && !releaseExtraction; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(extractionCalls, 1);
    releaseExtraction();
    const overview = await chatPromise;
    assert.equal(overview.response.status, 200);
    assert.equal(overview.body.meta.attachmentIds[0], attachmentId);
    assert.equal(extractionCalls, 1);

    const followUp = await postChat(url, "What does page 4 discuss?", { attachmentIds: [attachmentId] });
    assert.equal(followUp.response.status, 200);
    assert.equal(extractionCalls, 1);
  });
});

test("attachments cannot cross conversation boundaries", async () => {
  const { app } = await createApp({
    config: config(),
    provider,
    pdfExtractor,
    knowledgeBase: knowledgeBase(),
  });
  await withServer(app, async (url) => {
    const uploaded = await uploadDocument(url, "private-context.pdf", { conversationId: "conversation-a" });
    const result = await postChat(url, "Summarize it.", {
      conversationId: "conversation-b",
      attachmentIds: [uploaded.body.data.attachment.id],
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "ATTACHMENT_CONVERSATION_MISMATCH");
  });
});
