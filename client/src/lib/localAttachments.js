const MAX_EXTRACTED_CHARACTERS = 300_000;
const CHUNK_SIZE = 1_600;
const CHUNK_OVERLAP = 160;
const MAX_API_CHUNKS = 12;

function normalizeText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extensionOf(filename) {
  return filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
}

async function stableAttachmentId(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hex = [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `att_${hex}`;
}

function splitIntoChunks(text, location, attachmentId, startIndex = 0) {
  const clean = normalizeText(text);
  if (!clean) return [];
  const chunks = [];
  let cursor = 0;
  while (cursor < clean.length && cursor < MAX_EXTRACTED_CHARACTERS) {
    let end = Math.min(clean.length, cursor + CHUNK_SIZE);
    if (end < clean.length) {
      const boundary = Math.max(
        clean.lastIndexOf("\n", end),
        clean.lastIndexOf(". ", end),
        clean.lastIndexOf("। ", end),
        clean.lastIndexOf(" ", end),
      );
      if (boundary > cursor + CHUNK_SIZE * 0.55) end = boundary + 1;
    }
    const chunkText = clean.slice(cursor, end).trim();
    if (chunkText) {
      const index = startIndex + chunks.length;
      chunks.push({
        id: `${attachmentId}:chunk:${index}`,
        attachmentId,
        text: chunkText,
        location,
      });
    }
    if (end >= clean.length) break;
    cursor = Math.max(cursor + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function capExtractedChunks(chunks) {
  const capped = [];
  let remaining = MAX_EXTRACTED_CHARACTERS;
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const text = chunk.text.slice(0, remaining).trim();
    if (text) capped.push({ ...chunk, text });
    remaining -= text.length;
  }
  return capped;
}

async function parsePdf(buffer, attachmentId, onProgress) {
  const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = worker.default;
  const document = await getDocument({ data: buffer.slice(0) }).promise;
  const chunks = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || "").join(" ");
    chunks.push(
      ...splitIntoChunks(
        text,
        { page: pageNumber },
        attachmentId,
        chunks.length,
      ),
    );
    onProgress?.(Math.round((pageNumber / document.numPages) * 100));
  }
  if (!chunks.length) {
    throw new Error(
      "No selectable text was found in this PDF. Scanned PDFs need local OCR page images.",
    );
  }
  return { chunks, pageCount: document.numPages, kind: "pdf" };
}

async function parseDocx(buffer, attachmentId) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  const paragraphs = normalizeText(result.value).split(/\n+/).filter(Boolean);
  const chunks = [];
  for (let index = 0; index < paragraphs.length; index += 6) {
    chunks.push(
      ...splitIntoChunks(
        paragraphs.slice(index, index + 6).join("\n"),
        {
          section: `Paragraphs ${index + 1}-${Math.min(
            paragraphs.length,
            index + 6,
          )}`,
        },
        attachmentId,
        chunks.length,
      ),
    );
  }
  return { chunks, kind: "docx", sectionCount: paragraphs.length };
}

async function parseCsv(text, attachmentId) {
  const Papa = (await import("papaparse")).default;
  const parsed = Papa.parse(text, { skipEmptyLines: true });
  if (parsed.errors.some((error) => error.type === "Quotes")) {
    throw new Error("The CSV contains invalid quoted data.");
  }
  const rows = parsed.data;
  const chunks = [];
  for (let index = 0; index < rows.length; index += 25) {
    const block = rows
      .slice(index, index + 25)
      .map((row) => row.join(" | "))
      .join("\n");
    chunks.push(
      ...splitIntoChunks(
        block,
        {
          rowStart: index + 1,
          rowEnd: Math.min(rows.length, index + 25),
        },
        attachmentId,
        chunks.length,
      ),
    );
  }
  return { chunks, kind: "csv", rowCount: rows.length };
}

async function parseXlsx(buffer, attachmentId) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const chunks = [];
  let rowCount = 0;
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = row.values
        .slice(1)
        .map((value) =>
          typeof value === "object" && value !== null
            ? value.text || value.result || JSON.stringify(value)
            : String(value ?? ""),
        );
      rows.push({ rowNumber, text: values.join(" | ") });
      rowCount += 1;
    });
    for (let index = 0; index < rows.length; index += 20) {
      const block = rows.slice(index, index + 20);
      chunks.push(
        ...splitIntoChunks(
          block.map((row) => row.text).join("\n"),
          {
            sheet: sheet.name,
            rowStart: block[0]?.rowNumber || 1,
            rowEnd: block.at(-1)?.rowNumber || 1,
          },
          attachmentId,
          chunks.length,
        ),
      );
    }
  });
  return {
    chunks,
    kind: "xlsx",
    rowCount,
    sheetCount: workbook.worksheets.length,
  };
}

async function parseImage(file, attachmentId, onProgress) {
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("Local image OCR is limited to images of 10 MB or less.");
  }
  const { recognize } = await import("tesseract.js");
  const result = await recognize(file, "eng", {
    logger(event) {
      if (event.status === "recognizing text" && event.progress)
        onProgress?.(Math.round(event.progress * 100));
    },
  });
  const chunks = splitIntoChunks(
    result.data.text,
    { image: 1 },
    attachmentId,
  );
  if (!chunks.length)
    throw new Error("No readable text was found in this image.");
  return { chunks, kind: "image" };
}

export async function extractLocalAttachment(file, { onProgress } = {}) {
  if (!(file instanceof Blob)) throw new Error("Choose a valid local file.");
  const extension = extensionOf(file.name || "");
  const buffer = await file.arrayBuffer();
  const attachmentId = await stableAttachmentId(buffer);
  onProgress?.(5);
  let parsed;
  if (extension === "pdf") {
    parsed = await parsePdf(buffer, attachmentId, onProgress);
  } else if (extension === "docx") {
    parsed = await parseDocx(buffer, attachmentId);
  } else if (extension === "csv") {
    parsed = await parseCsv(await file.text(), attachmentId);
  } else if (extension === "xlsx") {
    parsed = await parseXlsx(buffer, attachmentId);
  } else if (["png", "jpg", "jpeg", "webp"].includes(extension)) {
    parsed = await parseImage(file, attachmentId, onProgress);
  } else if (["txt", "md", "json"].includes(extension)) {
    parsed = {
      chunks: splitIntoChunks(
        await file.text(),
        { section: extension === "md" ? "Markdown text" : "Document text" },
        attachmentId,
      ),
      kind: extension === "md" ? "markdown" : extension,
    };
  } else {
    throw new Error("This attachment type is not supported for local parsing.");
  }
  parsed.chunks = capExtractedChunks(parsed.chunks);
  if (!parsed.chunks.length) throw new Error("No readable text was extracted.");
  onProgress?.(100);
  return {
    id: attachmentId,
    name: file.name,
    filename: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    extension,
    kind: parsed.kind,
    type: parsed.kind,
    status: "ready",
    stage: "complete",
    progress: 100,
    localOnly: true,
    extractedAt: new Date().toISOString(),
    characterCount: parsed.chunks.reduce(
      (total, chunk) => total + chunk.text.length,
      0,
    ),
    chunks: parsed.chunks,
    ...(parsed.pageCount ? { pageCount: parsed.pageCount } : {}),
    ...(parsed.rowCount ? { rowCount: parsed.rowCount } : {}),
    ...(parsed.sheetCount ? { sheetCount: parsed.sheetCount } : {}),
    ...(parsed.sectionCount ? { sectionCount: parsed.sectionCount } : {}),
  };
}

function tokenize(value) {
  return (String(value || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])
    .filter((token) => token.length > 2);
}

export function selectRelevantAttachmentChunks(
  attachments,
  query,
  limit = MAX_API_CHUNKS,
) {
  const candidates = [];
  for (const attachment of attachments || []) {
    if (attachment.active === false || attachment.status !== "ready") continue;
    for (const chunk of attachment.chunks || []) {
      candidates.push({ attachment, chunk });
    }
  }
  const queryTokens = [...new Set(tokenize(query))];
  const ranked = candidates.map(({ attachment, chunk }, index) => {
    const chunkTokens = new Set(tokenize(chunk.text));
    const matches = queryTokens.filter((token) => chunkTokens.has(token)).length;
    const score = queryTokens.length
      ? matches / queryTokens.length
      : Math.max(0.1, 1 - index / Math.max(1, candidates.length));
    return { attachment, chunk, score, index };
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = queryTokens.length
    ? ranked.filter((item) => item.score > 0).slice(0, limit)
    : ranked.slice(0, limit);
  const fallback = selected.length ? selected : ranked.slice(0, Math.min(3, limit));
  return fallback.map(({ attachment, chunk, score }) => ({
    attachmentId: attachment.id,
    chunkId: chunk.id,
    filename: attachment.filename || attachment.name,
    text: chunk.text,
    location: chunk.location,
    score: Number(score.toFixed(3)),
  }));
}

export function sentAttachmentMetadata(attachment) {
  const {
    chunks: _chunks,
    file: _file,
    fingerprint: _fingerprint,
    localId: _localId,
    ...metadata
  } = attachment;
  return metadata;
}
