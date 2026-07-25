import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const localAttachmentMocks = vi.hoisted(() => ({
  extractLocalAttachment: vi.fn(),
}));
vi.mock("./lib/localAttachments.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractLocalAttachment: localAttachmentMocks.extractLocalAttachment,
  };
});
import App from "./App.jsx";

const STORAGE_KEY = "medisage-conversations-v4";
const answer =
  "High blood pressure means the force against artery walls remains higher than normal over time.";

function chatData(overrides = {}) {
  return {
    answer,
    groundingType: "general",
    sources: [],
    relatedQuestions: ["What lifestyle factors affect blood pressure?"],
    safety: { level: "normal", requiresUrgentCare: false, warning: null },
    ...overrides,
  };
}
function jsonResponse(data, meta, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => (ok ? { success: true, data, meta } : data),
  };
}
function defaultFetch(url, options) {
  if (url === "/api/attachments") {
    const conversationId = options.body.get("conversationId");
    const requestId = options.body.get("requestId");
    return Promise.resolve(
      jsonResponse(
        {
          attachment: {
            id: "11111111-1111-4111-8111-111111111111",
            filename: "lecture.pdf",
            size: 1000,
            kind: "pdf",
            pageCount: 4,
            uploadedAt: new Date().toISOString(),
            status: "ready",
            topics: ["Topic one"],
          },
          summary: chatData({
            answer:
              "This document contains a complete educational summary with supporting page evidence [DOC1].",
            groundingType: "document",
            sources: [
              {
                id: "DOC1",
                type: "document",
                title: "lecture.pdf",
                page: 1,
                excerpt: "Evidence",
              },
            ],
          }),
        },
        { conversationId, requestId, createdAt: new Date().toISOString() },
        { status: 201 },
      ),
    );
  }
  if (url.startsWith("/api/attachments/"))
    return Promise.resolve({
      ok: true,
      status: 204,
      headers: { get: () => "" },
    });
  const payload = JSON.parse(options.body);
  return Promise.resolve(
    jsonResponse(chatData(), {
      conversationId: payload.conversationId,
      requestId: payload.requestId,
      createdAt: new Date().toISOString(),
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "light";
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(defaultFetch));
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `id-${Math.random()}`) });
  localAttachmentMocks.extractLocalAttachment.mockReset().mockImplementation(
    async (file, { onProgress } = {}) => {
      onProgress?.(100);
      return {
        id: "att_local_pdf_123456",
        name: file.name,
        filename: file.name,
        size: file.size,
        mimeType: file.type,
        extension: "pdf",
        kind: "pdf",
        type: "pdf",
        status: "ready",
        stage: "complete",
        progress: 100,
        localOnly: true,
        pageCount: 4,
        chunks: [
          {
            id: "att_local_pdf_123456:chunk:0",
            attachmentId: "att_local_pdf_123456",
            text: "Locally extracted educational content from page one.",
            location: { page: 1 },
          },
        ],
      };
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("functional composer controls", () => {
  it("shows guest migration as a separate post-login dialog, never inside the login form", () => {
    const resolveMigration = vi.fn().mockReturnValue([]);
    render(<MemoryRouter><App user={{ uid: "registered-a", displayName: "Learner", isAnonymous: false }} isRegisteredUser hasPendingGuestMigration onResolveGuestMigration={resolveMigration} /></MemoryRouter>);
    expect(screen.getByRole("dialog", { name: "Add your guest conversation?" })).toBeTruthy();
    expect(screen.queryByText("Current guest conversation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue without importing" }));
    expect(resolveMigration).toHaveBeenCalledWith("keep");
  });

  it("opens the full chatbot for a guest and sends a medical question", async () => {
    const guest = { uid: "guest-a", isAnonymous: true };
    render(<MemoryRouter><App user={guest} isGuest /></MemoryRouter>);
    expect(screen.getByText("Guest")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "Explain hypertension" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(await screen.findByText(answer)).toBeTruthy();
    expect(JSON.parse(fetch.mock.calls.find(([url]) => url === "/api/chat")[1].body).message).toBe("Explain hypertension");
  });
  it("clicking Attach activates the real hidden file input", () => {
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Upload attachment" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload document" }));
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Attachment file input").accept).toContain(
      ".docx",
    );
  });

  it("selecting a PDF extracts it locally, resets the input and never uploads it", async () => {
    render(<App />);
    const input = screen.getByLabelText("Attachment file input");
    fireEvent.change(input, {
      target: {
        files: [
          new File(["%PDF-test"], "lecture.pdf", {
            type: "application/pdf",
            lastModified: 10,
          }),
        ],
      },
    });
    expect((await screen.findByText("lecture.pdf")).textContent).toBe("lecture.pdf");
    expect(await screen.findByText("PDF · 4 pages")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove lecture.pdf" })).toBeTruthy();
    expect(input.value).toBe("");
    expect(localAttachmentMocks.extractLocalAttachment).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unsupported attachment without sending an upload request", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Attachment file input"), {
      target: {
        files: [
          new File(["hello"], "notes.exe", {
            type: "application/octet-stream",
          }),
        ],
      },
    });
    expect(
      await screen.findByText("Select a supported PDF, document, data file, or image."),
    ).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends an attachment without text, clears the draft, and reuses only its ID for follow-up", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Attachment file input"), {
      target: {
        files: [new File(["%PDF-test"], "lecture.pdf", { type: "application/pdf" })],
      },
    });
    await screen.findByText("PDF · 4 pages");
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === "/api/chat")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Remove lecture.pdf" })).toBeNull();

    const first = JSON.parse(fetch.mock.calls.find(([url]) => url === "/api/chat")[1].body);
    expect(first.message).toBe("");
    expect(first.attachmentIds).toEqual(["att_local_pdf_123456"]);
    expect(first.attachmentContext).toEqual([
      expect.objectContaining({
        attachmentId: "att_local_pdf_123456",
        location: { page: 1 },
      }),
    ]);
    expect(first.messageId).toBeTruthy();

    await waitFor(() => expect(screen.getByLabelText("Chat message").disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "What is the key point?" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === "/api/chat")).toHaveLength(2));
    const second = JSON.parse(fetch.mock.calls.filter(([url]) => url === "/api/chat")[1][1].body);
    expect(second.attachmentIds).toEqual(first.attachmentIds);
    expect(second.messages.some((message) => !message.content.trim())).toBe(
      false,
    );
    expect(localAttachmentMocks.extractLocalAttachment).toHaveBeenCalledOnce();
    expect(
      fetch.mock.calls.filter(([url]) => url === "/api/attachments"),
    ).toHaveLength(0);
  });

  it("selects Balanced and Study notes through the reusable response-style menu", async () => {
    render(<App />);
    const trigger = screen.getByRole("button", { name: "Response style" });
    expect(trigger.textContent).toContain("Balanced");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /Study notes/ }));
    expect(
      screen.getByRole("button", { name: "Response style" }).textContent,
    ).toContain("Study notes");
  });

  it("selects বাংলা through the answer-language menu", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Answer language" }));
    fireEvent.click(screen.getByRole("option", { name: /বাংলা/ }));
    expect(
      screen.getByRole("button", { name: "Answer language" }).textContent,
    ).toContain("বাংলা");
  });

  it("sends responseMode, outputLanguage and active attachmentIds explicitly", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "conversation-doc",
          title: "Document chat",
          createdAt: 1,
          messages: [],
          responseMode: "detailed",
          outputLanguage: "bn",
          document: {
            id: "11111111-1111-4111-8111-111111111111",
            filename: "notes.pdf",
            size: 500,
            pageCount: 2,
            uploadedAt: new Date().toISOString(),
            status: "ready",
            topics: [],
          },
        },
      ]),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "প্রশ্নটি বুঝিয়ে দিন" },
    });
    fireEvent.click(screen.getByLabelText("Send message"));
    await screen.findByText(answer);
    const request = JSON.parse(
      fetch.mock.calls.find(([url]) => url === "/api/chat")[1].body,
    );
    expect(request).toMatchObject({
      conversationId: "conversation-doc",
      attachmentIds: ["11111111-1111-4111-8111-111111111111"],
      responseMode: "detailed",
      outputLanguage: "bn",
      message: "প্রশ্নটি বুঝিয়ে দিন",
    });
  });

  it("persists selected settings for each conversation across remounts", () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Response style" }));
    fireEvent.click(screen.getByRole("option", { name: /Concise/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer language" }));
    fireEvent.click(screen.getByRole("option", { name: /English/ }));
    first.unmount();
    render(<App />);
    expect(
      screen.getByRole("button", { name: "Response style" }).textContent,
    ).toContain("Concise");
    expect(
      screen.getByRole("button", { name: "Answer language" }).textContent,
    ).toContain("English");
  });
});

describe("conversation isolation and retry", () => {
  it("keeps a late response in its original conversation after switching", async () => {
    let finish;
    fetch.mockImplementationOnce(
      (_url, options) =>
        new Promise((resolve) => {
          const payload = JSON.parse(options.body);
          finish = () =>
            resolve(
              jsonResponse(
                chatData({
                  answer:
                    "Conversation A receives this delayed medical answer and no other conversation does.",
                }),
                {
                  conversationId: payload.conversationId,
                  requestId: payload.requestId,
                },
              ),
            );
        }),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Question for conversation A" },
    });
    fireEvent.click(screen.getByLabelText("Send message"));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await act(async () => finish());
    expect(screen.queryByText(/Conversation A receives/)).toBeNull();
    fireEvent.click(screen.getByTitle("Question for conversation A"));
    expect(
      await screen.findByText(/Conversation A receives this delayed/),
    ).toBeTruthy();
  });

  it("rejects a response carrying another conversation ID", async () => {
    fetch.mockImplementationOnce((_url, options) => {
      const payload = JSON.parse(options.body);
      return Promise.resolve(
        jsonResponse(
          chatData({
            answer:
              "This mismatched response must never be rendered in the conversation.",
          }),
          {
            conversationId: "wrong-conversation",
            requestId: payload.requestId,
          },
        ),
      );
    });
    render(<App />);
    fireEvent.click(
      screen.getByText("Explain high blood pressure in simple language."),
    );
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/mismatched response must never/)).toBeNull();
  });

  it("Retry uses the exact failed request settings and replaces the error block", async () => {
    fetch
      .mockImplementationOnce((_url, options) => {
        const payload = JSON.parse(options.body);
        return Promise.resolve(
          jsonResponse(
            {
              success: false,
              error: {
                code: "AI_SERVICE_ERROR",
                message: "Temporary failure.",
              },
              meta: {
                conversationId: payload.conversationId,
                requestId: payload.requestId,
              },
            },
            null,
            { ok: false, status: 503 },
          ),
        );
      })
      .mockImplementationOnce(defaultFetch);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Response style" }));
    fireEvent.click(screen.getByRole("option", { name: /Detailed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer language" }));
    fireEvent.click(screen.getByRole("option", { name: /English/ }));
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Retry this exact medical question" },
    });
    fireEvent.click(screen.getByLabelText("Send message"));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText(answer);
    const requests = fetch.mock.calls
      .filter(([url]) => url === "/api/chat")
      .map(([, options]) => JSON.parse(options.body));
    expect(requests[1]).toMatchObject({
      message: requests[0].message,
      conversationId: requests[0].conversationId,
      attachmentIds: requests[0].attachmentIds,
      responseMode: "detailed",
      outputLanguage: "en",
    });
    expect(screen.queryByText("Temporary failure.")).toBeNull();
    expect(
      [...document.querySelectorAll(".user-bubble")].filter(
        (node) => node.textContent === "Retry this exact medical question",
      ),
    ).toHaveLength(1);
  });

  it("drops legacy uncorrelated assistant history instead of restoring leaked content", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "blood-chat",
          title: "Blood pressure",
          createdAt: 1,
          responseMode: "balanced",
          outputLanguage: "auto",
          document: null,
          messages: [
            {
              id: "u",
              role: "user",
              conversationId: "blood-chat",
              content: "Explain high blood pressure",
            },
            {
              id: "bad",
              role: "assistant",
              content:
                "A zoology response that belongs to an unrelated conversation and should disappear.",
            },
          ],
        },
      ]),
    );
    render(<App />);
    expect(screen.queryByText(/zoology response/)).toBeNull();
    expect(screen.getByText("Explain high blood pressure")).toBeTruthy();
  });

  it("replaces stored Hosting HTML with a removable local error card", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "legacy-html-chat",
          title: "Legacy response",
          createdAt: 1,
          responseMode: "balanced",
          outputLanguage: "auto",
          attachments: [],
          messages: [
            {
              id: "legacy-user",
              role: "user",
              conversationId: "legacy-html-chat",
              content: "Explain blood pressure",
            },
            {
              id: "legacy-html",
              role: "assistant",
              conversationId: "legacy-html-chat",
              content:
                "<!doctype html><html><body><div id=\"root\">MediSage</div></body></html>",
            },
          ],
        },
      ]),
    );
    render(<App />);
    expect(
      screen.getByText(
        "The AI service returned an invalid response. Please retry or remove this message.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("<!doctype html>");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(
      screen.queryByText(
        "The AI service returned an invalid response. Please retry or remove this message.",
      ),
    ).toBeNull();
  });

  it("turns a live HTML API response into a professional retryable error", async () => {
    fetch.mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><body>Firebase Hosting fallback</body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Explain hypertension" },
    });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(
      await screen.findByText(
        "The AI service is not connected correctly. Please try again shortly.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("Firebase Hosting fallback");
  });
});

describe("theme and compact layout controls", () => {
  it("keeps both selectors actionable in dark mode and a mobile-sized viewport", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    render(<App />);
    fireEvent.click(screen.getByLabelText("Switch to dark theme"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Response style" }));
    expect(
      screen.getByRole("listbox", { name: "Response style" }),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Response style" }), {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Answer language" }));
    expect(
      screen.getByRole("listbox", { name: "Answer language" }),
    ).toBeTruthy();
  });
});
