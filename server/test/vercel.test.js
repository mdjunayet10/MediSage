import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import test from "node:test";
import { createVercelApp } from "../src/vercelApp.js";
import { loadConfig } from "../src/config.js";
import { HF_DATASET_NAME, HF_DATASET_URL } from "../src/knowledge.js";

function config(overrides = {}) {
  return loadConfig({
    OPENROUTER_API_KEY: "test-key",
    FIREBASE_PROJECT_ID: "medi-sage",
    RATE_LIMIT_REQUESTS: "1000",
    ...overrides,
  });
}

function knowledgeBase() {
  const record = {
    id: "HF-MED-TEST-1",
    recordId: "HF-MED-TEST-1",
    question: "What is hypertension?",
    context:
      "Hypertension is persistent elevation of blood pressure and requires reliable measurement.",
    score: 0.91,
  };
  return {
    name: HF_DATASET_NAME,
    loaded: true,
    records: { length: 50_000 },
    search: (query) => (/hypertension/i.test(query) ? [record] : []),
    toSource: (item, id) => ({
      id,
      stableId: item.id,
      type: "dataset",
      title: "AI Medical Dataset",
      dataset: HF_DATASET_NAME,
      recordId: item.recordId,
      excerpt: item.context,
      score: item.score,
      url: HF_DATASET_URL,
    }),
  };
}

const provider = async ({ messages }) => {
  const prompt = messages.at(-1)?.content || "";
  if (/Translate the supplied/i.test(messages[0]?.content || "")) {
    return {
      answer:
        "উচ্চ রক্তচাপ হলো দীর্ঘ সময় ধরে রক্তচাপ স্বাভাবিকের চেয়ে বেশি থাকা।",
      model: "openrouter/free",
    };
  }
  if (/attachment without text/i.test(prompt)) {
    return {
      answer:
        "The local attachment explains that blood pressure can remain elevated over time [DOC1].",
      model: "openrouter/free",
    };
  }
  return {
    answer:
      "Hypertension means blood pressure remains elevated over time and may increase cardiovascular risk [HF1].",
    model: "openrouter/free",
  };
};

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function chatPayload(overrides = {}) {
  return {
    message: "Explain hypertension.",
    messageId: "message-1",
    conversationId: "conversation-1",
    requestId: "request-1",
    messages: [],
    attachmentIds: [],
    attachmentContext: [],
    responseMode: "balanced",
    outputLanguage: "en",
    ...overrides,
  };
}

test("Vercel health is JSON and reports the real prepared dataset count", async () => {
  const { app } = await createVercelApp({
    config: config(),
    provider,
    knowledgeBase: knowledgeBase(),
    authVerifier: async (token) => ({
      uid: token,
      firebase: { sign_in_provider: "anonymous" },
    }),
  });
  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/health`, {
      headers: { Origin: "https://medi-sage.web.app" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "https://medi-sage.web.app",
    );
    const body = await response.json();
    assert.deepEqual(body.data.dataset, {
      name: HF_DATASET_NAME,
      loaded: true,
      records: 50_000,
    });
    assert.deepEqual(body.data.attachments, {
      processing: "browser-local",
      fileUploadsAccepted: false,
    });
  });
});

test("Vercel chat verifies auth and returns genuine HF sources", async () => {
  const verifiedTokens = [];
  const { app } = await createVercelApp({
    config: config(),
    provider,
    knowledgeBase: knowledgeBase(),
    authVerifier: async (token) => {
      verifiedTokens.push(token);
      return {
        uid: token === "anonymous-token" ? "guest-uid" : "registered-uid",
        firebase: {
          sign_in_provider:
            token === "anonymous-token" ? "anonymous" : "google.com",
        },
      };
    },
  });
  await withServer(app, async (url) => {
    const missing = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatPayload()),
    });
    assert.equal(missing.status, 401);

    for (const token of ["anonymous-token", "registered-token"]) {
      const response = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(chatPayload()),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.groundingType, "dataset");
      assert.equal(body.data.sources[0].id, "HF1");
      assert.equal(body.data.sources[0].recordId, "HF-MED-TEST-1");
      assert.equal(body.data.sources[0].url, HF_DATASET_URL);
    }
    assert.deepEqual(verifiedTokens, [
      "anonymous-token",
      "registered-token",
    ]);
  });
});

test("attachment-only chat accepts bounded local chunks and never a file body", async () => {
  let providerMessages;
  const { app } = await createVercelApp({
    config: config(),
    provider: async (params) => {
      providerMessages = params.messages;
      return provider(params);
    },
    knowledgeBase: knowledgeBase(),
    authVerifier: async () => ({
      uid: "guest-uid",
      firebase: { sign_in_provider: "anonymous" },
    }),
  });
  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer anonymous-token",
      },
      body: JSON.stringify(
        chatPayload({
          message: "",
          attachmentIds: ["att_local_pdf_123456"],
          attachmentContext: [
            {
              attachmentId: "att_local_pdf_123456",
              chunkId: "att_local_pdf_123456:chunk:0",
              filename: "lesson.pdf",
              text: "Blood pressure can remain elevated over time.",
              location: { page: 2 },
              score: 1,
            },
          ],
        }),
      ),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.groundingType, "document");
    assert.equal(body.data.sources[0].id, "DOC1");
    assert.deepEqual(body.data.sources[0].location, { page: 2 });
    const serializedPrompt = JSON.stringify(providerMessages);
    assert.match(serializedPrompt, /Blood pressure can remain elevated/);
    assert.doesNotMatch(serializedPrompt, /base64|data:application|%PDF/i);
  });
});

test("translate and unknown Vercel endpoints remain authenticated JSON APIs", async () => {
  const { app } = await createVercelApp({
    config: config(),
    provider,
    knowledgeBase: knowledgeBase(),
    authVerifier: async () => ({
      uid: "registered-uid",
      firebase: { sign_in_provider: "password" },
    }),
  });
  await withServer(app, async (url) => {
    const translated = await fetch(`${url}/api/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer registered-token",
      },
      body: JSON.stringify({
        text: "Hypertension means persistently elevated blood pressure.",
        targetLanguage: "bn",
        requestId: "translate-1",
      }),
    });
    assert.equal(translated.status, 200);
    assert.match((await translated.json()).data.translation, /উচ্চ রক্তচাপ/);

    const missing = await fetch(`${url}/api/attachments`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type"), /application\/json/);
    assert.equal((await missing.json()).error.code, "API_NOT_FOUND");
  });
});

test("Vercel configuration includes the prepared dataset and catch-all API rewrite", () => {
  const configuration = JSON.parse(
    fs.readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
  );
  assert.equal(
    configuration.functions["api/index.js"].includeFiles,
    "server/data/hf_medical_knowledge.jsonl",
  );
  assert.deepEqual(configuration.rewrites[0], {
    source: "/api/(.*)",
    destination: "/api",
  });
  assert.equal(configuration.outputDirectory, "vercel-public");
  assert.match(configuration.buildCommand, /MediSage API function/);
  assert.equal(
    fs.existsSync(new URL("../../api/index.js", import.meta.url)),
    true,
  );
  assert.equal(
    fs.existsSync(new URL("../../vercel-public/service.json", import.meta.url)),
    true,
  );
});
