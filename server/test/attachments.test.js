import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { Document, Packer, Paragraph } from "docx";
import { inspectAttachment, parseAttachment } from "../src/attachments.js";

const options = {
  attachmentId: "attachment-test",
  filename: "notes.txt",
  mimeType: "text/plain",
  maxPages: 10,
  maxCharacters: 100_000,
  maxSpreadsheetRows: 100,
  maxImagePixels: 1_000_000,
  timeoutMs: 10_000,
};

test("plain text, Markdown, CSV, and JSON use local parser registry chunks with locations", async () => {
  const fixtures = [
    [
      "notes.txt",
      "text/plain",
      "Hypertension is persistently elevated blood pressure.",
    ],
    [
      "notes.md",
      "text/plain",
      "# Cardiovascular\nHypertension is persistently elevated blood pressure.",
    ],
    ["table.csv", "text/csv", "term,meaning\nhypertension,high blood pressure"],
    [
      "data.json",
      "application/json",
      '{"term":"hypertension","meaning":"high blood pressure"}',
    ],
  ];
  for (const [filename, mimeType, value] of fixtures) {
    const parsed = await parseAttachment(Buffer.from(value), {
      ...options,
      filename,
      mimeType,
    });
    assert.ok(parsed.chunks.length > 0, filename);
    assert.ok(
      parsed.chunks.every(
        (chunk) => chunk.attachmentId === options.attachmentId,
      ),
    );
    assert.ok(parsed.index.search("hypertension", 2).length > 0);
  }
});

test("DOCX and XLSX preserve document and sheet/row source locations", async () => {
  const docx = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph("Hypertension treatment overview and monitoring."),
          ],
        },
      ],
    }),
  );
  const parsedDocx = await parseAttachment(docx, {
    ...options,
    filename: "medical.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  assert.equal(parsedDocx.kind, "docx");
  assert.match(parsedDocx.chunks[0].text, /hypertension/i);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Patient Data");
  sheet.addRows([
    ["condition", "reading"],
    ["hypertension", "140/90"],
  ]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsedXlsx = await parseAttachment(xlsx, {
    ...options,
    filename: "medical.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  assert.equal(parsedXlsx.chunks[0].location.sheet, "Patient Data");
  assert.deepEqual(
    [
      parsedXlsx.chunks[0].location.rowStart,
      parsedXlsx.chunks[0].location.rowEnd,
    ],
    [1, 2],
  );
});

test("image parsing invokes the local OCR worker and preserves image location", async () => {
  let recognized = false;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nC8AAAAASUVORK5CYII=",
    "base64",
  );
  const parsed = await parseAttachment(png, {
    ...options,
    filename: "label.png",
    mimeType: "image/png",
    ocrWorkerFactory: async () => ({
      recognize: async () => {
        recognized = true;
        return {
          data: { text: "Aspirin label text for education", confidence: 92 },
        };
      },
      terminate: async () => {},
    }),
  });
  assert.equal(recognized, true);
  assert.equal(parsed.chunks[0].location.image, 1);
});

test("file content and filename mismatches are rejected before parsing", async () => {
  await assert.rejects(
    inspectAttachment(Buffer.from("%PDF-test"), "malware.txt", "text/plain"),
    (error) =>
      error.code === "ATTACHMENT_TYPE_MISMATCH" && error.status === 415,
  );
});
