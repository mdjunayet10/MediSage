import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async (pageNumber) => ({
        getTextContent: async () => ({
          items: [
            {
              str:
                pageNumber === 1
                  ? "Page one explains hypertension and blood pressure."
                  : "Page two explains monitoring and professional review.",
            },
          ],
        }),
      }),
    }),
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/pdf.worker.mjs",
}));

import {
  extractLocalAttachment,
  selectRelevantAttachmentChunks,
} from "./localAttachments.js";

function localFile(contents, name, type) {
  const bytes = new TextEncoder().encode(contents);
  const file = new Blob([bytes], { type });
  Object.defineProperty(file, "name", { value: name });
  file.arrayBuffer = async () => bytes.buffer.slice(0);
  file.text = async () => contents;
  return file;
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

describe("browser-local attachment extraction", () => {
  it("extracts PDF pages locally with stable page-preserving chunks", async () => {
    const first = await extractLocalAttachment(
      localFile("%PDF-local-test", "lesson.pdf", "application/pdf"),
    );
    const second = await extractLocalAttachment(
      localFile("%PDF-local-test", "lesson.pdf", "application/pdf"),
    );
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^att_[a-f0-9]{24}$/);
    expect(first.pageCount).toBe(2);
    expect(first.chunks.map((chunk) => chunk.location.page)).toEqual([1, 2]);
    expect(first.chunks[0].text).toContain("hypertension");
  });

  it("extracts text without a network request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const attachment = await extractLocalAttachment(
      localFile(
        "Hypertension is persistent elevation of blood pressure.",
        "notes.txt",
        "text/plain",
      ),
    );
    expect(attachment.status).toBe("ready");
    expect(attachment.chunks[0].location).toEqual({
      section: "Document text",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only query-relevant chunks while retaining stable attachment IDs", () => {
    const attachments = [
      {
        id: "att_relevant_123",
        filename: "notes.txt",
        status: "ready",
        active: true,
        chunks: [
          {
            id: "att_relevant_123:chunk:0",
            text: "Hypertension is elevated blood pressure.",
            location: { section: "Blood pressure" },
          },
          {
            id: "att_relevant_123:chunk:1",
            text: "The skeleton supports the body.",
            location: { section: "Anatomy" },
          },
        ],
      },
    ];
    const selected = selectRelevantAttachmentChunks(
      attachments,
      "Explain hypertension",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      attachmentId: "att_relevant_123",
      chunkId: "att_relevant_123:chunk:0",
    });
    expect(selected[0].text).not.toContain("skeleton");
  });
});
