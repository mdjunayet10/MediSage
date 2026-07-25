import path from "node:path";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import mammoth from "mammoth";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { createWorker } from "tesseract.js";
import { imageSize } from "image-size";
import { LexicalIndex } from "./retrieval.js";
import { extractPdf } from "./pdf.js";

export const ATTACHMENT_TYPES = Object.freeze({
  ".pdf": { kind: "pdf", mimes: ["application/pdf"] },
  ".docx": {
    kind: "docx",
    mimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
    ],
  },
  ".txt": { kind: "text", mimes: ["text/plain"] },
  ".md": { kind: "markdown", mimes: ["text/markdown", "text/plain"] },
  ".csv": { kind: "csv", mimes: ["text/csv", "text/plain", "application/csv"] },
  ".json": { kind: "json", mimes: ["application/json", "text/plain"] },
  ".xlsx": {
    kind: "xlsx",
    mimes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
    ],
  },
  ".png": { kind: "image", mimes: ["image/png"] },
  ".jpg": { kind: "image", mimes: ["image/jpeg"] },
  ".jpeg": { kind: "image", mimes: ["image/jpeg"] },
  ".webp": { kind: "image", mimes: ["image/webp"] },
});

function attachmentError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readableText(buffer) {
  const text = normalizeText(buffer.toString("utf8"));
  if (!text || text.includes("\uFFFD"))
    throw attachmentError(
      "INVALID_TEXT_FILE",
      "The text file is not valid UTF-8 or contains no readable text.",
    );
  return text;
}

function chunkText(
  text,
  {
    attachmentId,
    filename,
    section = "Document",
    targetSize = 900,
    overlap = 100,
    location = {},
  },
) {
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + targetSize, text.length);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf(". ", end),
        text.lastIndexOf("\n", end),
        text.lastIndexOf(" ", end),
      );
      if (boundary > cursor + Math.floor(targetSize * 0.55)) end = boundary + 1;
    }
    const value = text.slice(cursor, end).trim();
    if (value)
      chunks.push({
        id: `ATT-${attachmentId}-${chunks.length + 1}`,
        attachmentId,
        filename,
        text: value,
        excerpt: value.slice(0, 240),
        location: { section, ...location },
      });
    if (end >= text.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return chunks;
}

function finalize(result) {
  const chunks = result.chunks
    .filter((chunk) => chunk.text?.trim())
    .map((chunk, index) => ({
      ...chunk,
      id: `ATT-${chunk.attachmentId}-${index + 1}`,
    }));
  if (!chunks.length)
    throw attachmentError(
      "NO_READABLE_CONTENT",
      "No readable content was found in this attachment.",
    );
  return {
    ...result,
    chunks,
    characterCount: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    index: new LexicalIndex(chunks),
  };
}

async function parsePdf(buffer, options) {
  const extracted = await (options.pdfExtractor || extractPdf)(buffer, {
    documentId: options.attachmentId,
    filename: options.filename,
    maxPages: options.maxPages,
    maxCharacters: options.maxCharacters,
  });
  return finalize({
    kind: "pdf",
    pageCount: extracted.pageCount,
    chunks: extracted.chunks.map((chunk) => ({
      ...chunk,
      attachmentId: options.attachmentId,
      location: { page: chunk.page },
    })),
  });
}

async function parseDocx(buffer, options) {
  const { value, messages } = await mammoth.extractRawText({ buffer });
  const text = normalizeText(value);
  return finalize({
    kind: "docx",
    warnings: messages
      .filter((message) => message.type === "warning")
      .map((message) => message.message)
      .slice(0, 5),
    chunks: chunkText(text, options),
  });
}

function parseStructuredText(buffer, options) {
  const text = readableText(buffer);
  const sectionPattern =
    options.kind === "markdown" ? /^(#{1,6})\s+(.+)$/gm : null;
  if (!sectionPattern)
    return finalize({ kind: options.kind, chunks: chunkText(text, options) });
  const matches = [...text.matchAll(sectionPattern)];
  if (!matches.length)
    return finalize({ kind: options.kind, chunks: chunkText(text, options) });
  const chunks = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const sectionText = text.slice(
      match.index,
      matches[index + 1]?.index ?? text.length,
    );
    chunks.push(
      ...chunkText(sectionText, { ...options, section: match[2].trim() }),
    );
  }
  return finalize({ kind: options.kind, chunks });
}

function tableChunks(rows, options, { sheet = null } = {}) {
  const chunks = [];
  const batchSize = 25;
  for (let start = 0; start < rows.length; start += batchSize) {
    const subset = rows.slice(start, start + batchSize);
    const text = subset
      .map((row) => row.map((cell) => String(cell ?? "")).join(" | "))
      .join("\n");
    chunks.push(
      ...chunkText(text, {
        ...options,
        section: sheet ? `Sheet: ${sheet}` : "Rows",
        location: {
          ...(sheet ? { sheet } : {}),
          rowStart: start + 1,
          rowEnd: start + subset.length,
        },
        overlap: 0,
        targetSize: 1800,
      }),
    );
  }
  return chunks;
}

function parseCsvFile(buffer, options) {
  let rows;
  try {
    rows = parseCsv(readableText(buffer), {
      relax_column_count: true,
      skip_empty_lines: true,
      bom: true,
    });
  } catch {
    throw attachmentError(
      "INVALID_CSV",
      "The CSV file could not be parsed. Check its delimiter and quoting.",
    );
  }
  if (rows.length > options.maxSpreadsheetRows)
    throw attachmentError(
      "SPREADSHEET_ROW_LIMIT",
      `The spreadsheet exceeds the ${options.maxSpreadsheetRows.toLocaleString()} row limit.`,
      413,
    );
  return finalize({
    kind: "csv",
    rowCount: rows.length,
    chunks: tableChunks(rows, options),
  });
}

function parseJsonFile(buffer, options) {
  let parsed;
  try {
    parsed = JSON.parse(readableText(buffer));
  } catch {
    throw attachmentError("INVALID_JSON", "The JSON file is not valid JSON.");
  }
  const text = JSON.stringify(parsed, null, 2);
  return finalize({
    kind: "json",
    chunks: chunkText(text, { ...options, section: "JSON data" }),
  });
}

async function parseXlsx(buffer, options) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw attachmentError(
      "INVALID_XLSX",
      "The Excel workbook could not be parsed.",
    );
  }
  const chunks = [];
  let rowCount = 0;
  workbook.eachSheet((worksheet) => {
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      rows.push(
        row.values
          .slice(1)
          .map((cell) =>
            typeof cell === "object" && cell !== null
              ? (cell.text ?? cell.result ?? JSON.stringify(cell))
              : cell,
          ),
      );
    });
    rowCount += rows.length;
    if (rowCount <= options.maxSpreadsheetRows)
      chunks.push(...tableChunks(rows, options, { sheet: worksheet.name }));
  });
  if (rowCount > options.maxSpreadsheetRows)
    throw attachmentError(
      "SPREADSHEET_ROW_LIMIT",
      `The workbook exceeds the ${options.maxSpreadsheetRows.toLocaleString()} row limit.`,
      413,
    );
  return finalize({
    kind: "xlsx",
    rowCount,
    sheetCount: workbook.worksheets.length,
    chunks,
  });
}

async function parseImage(buffer, options) {
  let dimensions;
  try {
    dimensions = imageSize(buffer);
  } catch {
    throw attachmentError(
      "INVALID_IMAGE",
      "The image file could not be decoded.",
    );
  }
  if (
    !dimensions.width ||
    !dimensions.height ||
    dimensions.width * dimensions.height > options.maxImagePixels
  ) {
    throw attachmentError(
      "IMAGE_PIXEL_LIMIT",
      `The image exceeds the ${options.maxImagePixels.toLocaleString()} pixel limit.`,
      413,
    );
  }
  const worker = await (options.ocrWorkerFactory || createWorker)("eng");
  let text;
  let confidence = 0;
  try {
    const result = await worker.recognize(buffer);
    text = normalizeText(result.data.text);
    confidence = Number(result.data.confidence || 0);
  } finally {
    await worker.terminate();
  }
  return finalize({
    kind: "image",
    width: dimensions.width,
    height: dimensions.height,
    warnings:
      confidence < 60
        ? ["Some text could not be read clearly from this image."]
        : [],
    chunks: chunkText(text, {
      ...options,
      section: "OCR text",
      location: { image: 1 },
    }),
  });
}

export const parserRegistry = Object.freeze({
  pdf: parsePdf,
  docx: parseDocx,
  text: parseStructuredText,
  markdown: parseStructuredText,
  csv: parseCsvFile,
  json: parseJsonFile,
  xlsx: parseXlsx,
  image: parseImage,
});

function validateInspectedType(filename, declaredMime, detected) {
  const extension = path.extname(filename).toLowerCase();
  const definition = ATTACHMENT_TYPES[extension];
  if (!definition)
    throw attachmentError(
      "UNSUPPORTED_ATTACHMENT",
      "Supported files are PDF, DOCX, TXT, MD, CSV, JSON, XLSX, PNG, JPG, and WEBP.",
      415,
    );
  if (detected && !definition.mimes.includes(detected.mime)) {
    throw attachmentError(
      "ATTACHMENT_TYPE_MISMATCH",
      "The file content does not match its filename extension.",
      415,
    );
  }
  if (
    !detected &&
    !["text", "markdown", "csv", "json"].includes(definition.kind)
  ) {
    throw attachmentError(
      "INVALID_ATTACHMENT",
      "The file signature is missing or unsupported.",
      415,
    );
  }
  if (
    declaredMime &&
    !definition.mimes.includes(declaredMime) &&
    declaredMime !== "application/octet-stream"
  ) {
    throw attachmentError(
      "ATTACHMENT_TYPE_MISMATCH",
      "The uploaded content type does not match its filename.",
      415,
    );
  }
  return {
    extension,
    kind: definition.kind,
    detectedMime: detected?.mime || declaredMime || "text/plain",
  };
}

export async function inspectAttachment(buffer, filename, declaredMime = "") {
  return validateInspectedType(filename, declaredMime, await fileTypeFromBuffer(buffer));
}

export async function inspectAttachmentFile(filePath, filename, declaredMime = "") {
  return validateInspectedType(filename, declaredMime, await fileTypeFromFile(filePath));
}

export async function parseAttachment(buffer, options) {
  const inspected = await inspectAttachment(
    buffer,
    options.filename,
    options.mimeType,
  );
  const parser = parserRegistry[inspected.kind];
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          attachmentError(
            "ATTACHMENT_TIMEOUT",
            "Attachment processing timed out.",
            408,
          ),
        ),
      options.timeoutMs,
    );
    timer.unref?.();
  });
  const parsed = await Promise.race([
    parser(buffer, { ...options, kind: inspected.kind }),
    timeout,
  ]);
  return {
    ...parsed,
    mimeType: inspected.detectedMime,
    extension: inspected.extension,
  };
}
