import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticatedFetch,
  buildApiUrl,
  joinApiUrl,
  isValidAssistantAnswer,
  parseApiResponse,
  requireValidChatData,
} from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("assistant response validation", () => {
  it("rejects every internal classifier form", () => {
    for (const value of [
      "safe",
      "unsafe",
      "medical_safe",
      "User Safety: safe",
      "emergency false",
      "urgent",
    ]) {
      expect(isValidAssistantAnswer(value)).toBe(false);
    }
  });

  it("rejects HTML documents and raw JSON as assistant answers", () => {
    expect(isValidAssistantAnswer("<!doctype html><html><body>Hosting</body></html>")).toBe(false);
    expect(isValidAssistantAnswer('{"answer":"This object must not be rendered directly."}')).toBe(false);
  });

  it("reads only the nested data.answer contract", () => {
    const data = requireValidChatData({
      data: {
        answer:
          "High blood pressure means pressure in the arteries remains elevated over time.",
        groundingType: "general",
        sources: [],
        relatedQuestions: [],
        safety: { level: "normal", requiresUrgentCare: false, warning: null },
      },
    });
    expect(data.answer).toContain("arteries");
    expect(() =>
      requireValidChatData({
        answer: "This legacy field must not be rendered as the answer.",
      }),
    ).toThrow();
  });
});

describe("authenticated API transport", () => {
  it("normalizes API paths and never exposes an HTML response body", async () => {
    expect(buildApiUrl("api/health")).toBe("/api/health");
    expect(
      joinApiUrl(
        "https://medisage-api.vercel.app/",
        "api/health",
      ),
    ).toBe("https://medisage-api.vercel.app/api/health");
    await expect(
      parseApiResponse(
        new Response("<!doctype html><html><body>SPA fallback</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message:
        "The AI service is not connected correctly. Please try again shortly.",
    });
  });

  it("rejects malformed JSON with a controlled retryable error", async () => {
    await expect(
      parseApiResponse(
        new Response("{invalid", {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_JSON_RESPONSE",
      retryable: true,
    });
  });

  it("adds a Firebase bearer token and force-refreshes it once after a 401", async () => {
    const user = {
      getIdToken: vi
        .fn()
        .mockResolvedValueOnce("stale-token")
        .mockResolvedValueOnce("fresh-token"),
    };
    const responses = [
      new Response("", { status: 401 }),
      new Response("{}", { status: 200 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(responses.shift())),
    );
    const response = await authenticatedFetch(
      "/api/chat",
      { method: "POST" },
      user,
    );
    expect(response.status).toBe(200);
    expect(user.getIdToken).toHaveBeenNthCalledWith(1, false);
    expect(user.getIdToken).toHaveBeenNthCalledWith(2, true);
    expect(fetch.mock.calls[1][1].headers.get("Authorization")).toBe(
      "Bearer fresh-token",
    );
  });
});
