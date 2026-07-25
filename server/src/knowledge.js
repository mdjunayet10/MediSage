import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { LexicalIndex, tokenize } from "./retrieval.js";

export const HF_DATASET_NAME = "ruslanmv/ai-medical-dataset";
export const HF_DATASET_URL = `https://huggingface.co/datasets/${HF_DATASET_NAME}`;

function safeText(value, max) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function resolveDatasetFile(configured) {
  const candidates = [
    path.resolve(process.cwd(), configured),
    path.resolve(process.cwd(), "..", configured),
    path.resolve(process.cwd(), "data", path.basename(configured)),
  ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]
  );
}

export class MedicalKnowledgeBase {
  constructor({
    filePath,
    limit,
    required = true,
    datasetName = HF_DATASET_NAME,
    minScore = 0.18,
  } = {}) {
    this.records = [];
    this.index = new LexicalIndex([]);
    this.filePath = filePath;
    this.limit = limit;
    this.required = required;
    this.name = datasetName;
    this.minScore = minScore;
    this.loaded = false;
    this.loadError = null;
  }

  async load() {
    if (this.name !== HF_DATASET_NAME) {
      throw new Error(
        `HF dataset configuration error: HF_DATASET_NAME must be ${HF_DATASET_NAME}.`,
      );
    }
    const configured =
      this.filePath || "server/data/hf_medical_knowledge.jsonl";
    const filePath = resolveDatasetFile(configured);
    if (!fs.existsSync(filePath)) {
      this.loadError = "PREPARED_DATASET_MISSING";
      this.loaded = false;
      if (this.required) {
        const error = new Error(
          `Required Hugging Face dataset file is missing. Prepare it with: python3 scripts/prepare_medical_dataset.py --dataset ${HF_DATASET_NAME} --rows 50000 --output server/data/hf_medical_knowledge.jsonl`,
        );
        error.code = "HF_DATASET_REQUIRED";
        throw error;
      }
      return;
    }

    const maximum = Number(this.limit || Number.MAX_SAFE_INTEGER);
    const records = [];
    const reader = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of reader) {
      if (records.length >= maximum) break;
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const question = safeText(row.question, 1200);
        const context = safeText(row.context, 5000);
        if (!question || !context || row.dataset !== HF_DATASET_NAME) continue;
        const recordId = safeText(row.id, 80);
        if (!recordId) continue;
        records.push({
          id: recordId,
          recordId,
          dataset: HF_DATASET_NAME,
          sourceUrl:
            row.sourceUrl === HF_DATASET_URL ? row.sourceUrl : HF_DATASET_URL,
          question,
          context,
          text: `${question}\n${context}`,
        });
      } catch {
        /* A malformed line is excluded without fabricating a replacement. */
      }
    }
    if (!records.length) {
      this.loaded = false;
      this.loadError = "NO_VALID_DATASET_RECORDS";
      if (this.required)
        throw new Error(
          "The required Hugging Face dataset file contained no valid prepared records.",
        );
      return;
    }
    this.records = records;
    this.index = new LexicalIndex(records);
    this.loaded = true;
    this.loadError = null;
  }

  search(query, count = 6, minimumScore = this.minScore) {
    const queryTokens = [...new Set(tokenize(query))];
    if (!this.loaded || !queryTokens.length) return [];
    const raw = this.index.search(query, Math.max(count * 4, 20));
    const maximum = raw[0]?.score || 1;
    return raw
      .map((record) => {
        const recordTokens = new Set(tokenize(record.text));
        const coverage =
          queryTokens.filter((token) => recordTokens.has(token)).length /
          queryTokens.length;
        const score = Number(((record.score / maximum) * coverage).toFixed(3));
        return { ...record, score, coverage };
      })
      .filter((record) => {
        const minimumCoverage =
          queryTokens.length <= 3 ? Math.min(1, 2 / queryTokens.length) : 0;
        return (
          record.score >= minimumScore && record.coverage >= minimumCoverage
        );
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, count);
  }

  toSource(record, citationId) {
    return {
      id: citationId,
      stableId: record.id,
      type: "dataset",
      title: "AI Medical Dataset",
      dataset: HF_DATASET_NAME,
      recordId: record.recordId,
      question: record.question,
      excerpt: record.context.slice(0, 320),
      score: record.score,
      url: HF_DATASET_URL,
    };
  }
}
