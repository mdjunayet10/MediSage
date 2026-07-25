import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HF_DATASET_NAME,
  HF_DATASET_URL,
  MedicalKnowledgeBase,
} from "../src/knowledge.js";

test("dataset loader accepts only exact, non-empty Hugging Face records and returns real sources", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "medisage-hf-"));
  const filePath = path.join(directory, "medical.jsonl");
  const rows = [
    {
      id: "HF-MED-VALID",
      dataset: HF_DATASET_NAME,
      question: "What are common diabetes symptoms?",
      context: "Thirst and frequent urination can occur.",
      sourceUrl: HF_DATASET_URL,
    },
    {
      id: "HF-MED-EMPTY-Q",
      dataset: HF_DATASET_NAME,
      question: "",
      context: "Excluded",
      sourceUrl: HF_DATASET_URL,
    },
    {
      id: "HF-MED-EMPTY-C",
      dataset: HF_DATASET_NAME,
      question: "Excluded",
      context: "",
      sourceUrl: HF_DATASET_URL,
    },
    {
      id: "HF-MED-WRONG",
      dataset: "another/dataset",
      question: "Diabetes",
      context: "Excluded",
      sourceUrl: HF_DATASET_URL,
    },
  ];
  await fs.writeFile(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n"),
  );
  const knowledge = new MedicalKnowledgeBase({
    filePath,
    required: true,
    datasetName: HF_DATASET_NAME,
    minScore: 0.18,
  });
  await knowledge.load();
  assert.equal(knowledge.records.length, 1);
  const result = knowledge.search("diabetes symptoms", 2);
  assert.equal(result[0].recordId, "HF-MED-VALID");
  assert.deepEqual(knowledge.toSource(result[0], "HF1"), {
    id: "HF1",
    stableId: "HF-MED-VALID",
    type: "dataset",
    title: "AI Medical Dataset",
    dataset: HF_DATASET_NAME,
    recordId: "HF-MED-VALID",
    question: "What are common diabetes symptoms?",
    excerpt: "Thirst and frequent urination can occur.",
    score: result[0].score,
    url: HF_DATASET_URL,
  });
  await fs.rm(directory, { recursive: true, force: true });
});

test("a missing required dataset fails with the exact preparation guidance", async () => {
  const knowledge = new MedicalKnowledgeBase({
    filePath: `/tmp/missing-${Date.now()}.jsonl`,
    required: true,
  });
  await assert.rejects(
    knowledge.load(),
    (error) =>
      error.code === "HF_DATASET_REQUIRED" &&
      /prepare_medical_dataset\.py/.test(error.message),
  );
  assert.equal(knowledge.loaded, false);
});
