import { LexicalIndex } from "./retrieval.js";

export function normalizePageText(items) {
  let text = "";
  let previousY = null;
  for (const item of items) {
    if (!item?.str) continue;
    const y = item.transform?.[5];
    const newLine =
      previousY !== null && Number.isFinite(y) && Math.abs(y - previousY) > 4;
    text += `${newLine ? "\n" : " "}${item.str}`;
    if (Number.isFinite(y)) previousY = y;
  }
  return text
    .replace(/-\s*\n\s*(?=[a-z])/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkPages(
  pages,
  { documentId, filename, targetSize = 850, overlap = 100 } = {},
) {
  const chunks = [];
  for (const page of pages) {
    let cursor = 0;
    while (cursor < page.text.length) {
      let end = Math.min(cursor + targetSize, page.text.length);
      if (end < page.text.length) {
        const boundary = Math.max(
          page.text.lastIndexOf(". ", end),
          page.text.lastIndexOf("\n", end),
          page.text.lastIndexOf(" ", end),
        );
        if (boundary > cursor + 550) end = boundary + 1;
      }
      const text = page.text.slice(cursor, end).trim();
      if (text) {
        const id = `PDF-S${chunks.length + 1}`;
        chunks.push({
          id,
          documentId,
          filename,
          page: page.page,
          text,
          excerpt: text.slice(0, 240),
        });
      }
      if (end >= page.text.length) break;
      cursor = Math.max(cursor + 1, end - overlap);
    }
  }
  return chunks;
}

export async function extractPdf(
  buffer,
  { documentId, filename, maxPages = 300, maxCharacters = 2_000_000 } = {},
) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  const pdf = await task.promise;
  if (pdf.numPages > maxPages) {
    await pdf.destroy();
    const error = new Error(
      `The PDF has too many pages. The limit is ${maxPages} pages.`,
    );
    error.status = 413;
    error.code = "PDF_PAGE_LIMIT";
    throw error;
  }

  const pages = [];
  let totalCharacters = 0;
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizePageText(content.items);
      totalCharacters += text.length;
      if (totalCharacters > maxCharacters) {
        const error = new Error(
          `The extracted PDF text exceeds the ${maxCharacters.toLocaleString()} character limit.`,
        );
        error.status = 413;
        error.code = "PDF_TEXT_LIMIT";
        throw error;
      }
      pages.push({ page: pageNumber, text });
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }

  const readableCharacters = pages.reduce(
    (sum, page) => sum + page.text.replace(/\s/g, "").length,
    0,
  );
  if (readableCharacters < Math.max(40, pdf.numPages * 20)) {
    const error = new Error(
      "No readable text was found. This PDF may contain scanned images.",
    );
    error.status = 422;
    error.code = "SCANNED_PDF";
    throw error;
  }

  const chunks = chunkPages(pages, { documentId, filename });
  return {
    pageCount: pdf.numPages,
    characterCount: totalCharacters,
    pages,
    chunks,
    index: new LexicalIndex(chunks),
  };
}

export function buildSummaryContext(chunks, maxCharacters = 24_000) {
  if (!chunks.length) return { context: "", selected: [] };
  const byPage = new Map();
  for (const chunk of chunks) {
    if (!byPage.has(chunk.page)) byPage.set(chunk.page, []);
    byPage.get(chunk.page).push(chunk);
  }
  const pages = [...byPage.keys()];
  const averageFirstChunk =
    pages.reduce((sum, page) => sum + byPage.get(page)[0].text.length + 80, 0) /
    pages.length;
  const pageCapacity = Math.max(
    1,
    Math.floor(maxCharacters / averageFirstChunk),
  );
  const representativePages =
    pages.length <= pageCapacity
      ? pages
      : Array.from(
          { length: pageCapacity },
          (_, index) =>
            pages[
              Math.round((index * (pages.length - 1)) / (pageCapacity - 1 || 1))
            ],
        );
  const selected = [];
  let length = 0;
  let round = 0;
  while (length < maxCharacters) {
    let added = false;
    for (const page of representativePages) {
      const chunk = byPage.get(page)[round];
      if (!chunk) continue;
      const addition = chunk.text.length + 80;
      if (length + addition > maxCharacters && selected.length) continue;
      selected.push(chunk);
      length += addition;
      added = true;
      if (length >= maxCharacters) break;
    }
    if (!added || length >= maxCharacters) break;
    round += 1;
  }
  const context = selected
    .map(
      (chunk, index) =>
        `[S${index + 1}]\nFile: ${chunk.filename}\nPage: ${chunk.page}\nContent: ${chunk.text}`,
    )
    .join("\n\n");
  return { context, selected };
}
