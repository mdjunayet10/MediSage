import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const authState = vi.hoisted(() => ({
  user: { uid: "local-guest", isAnonymous: true, guestSession: true },
  loading: false,
  isGuest: true,
  isRegisteredUser: false,
  configured: false,
  googleSignInEnabled: false,
  signIn: vi.fn().mockRejectedValue(new Error("Account services are not available in this environment yet.")),
  signUp: vi.fn(),
  resetPassword: vi.fn(),
  signInWithGoogle: vi.fn(),
  signOutUser: vi.fn(),
}));
vi.mock("./auth/AuthContext.jsx", () => ({ useAuth: () => authState }));
import RootApp from "./RootApp.jsx";

const answer = "Hypertension means blood pressure remains elevated over time and can increase cardiovascular risk.";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `id-${Math.random()}`) });
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    const request = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ success: true, data: { answer, groundingType: "general", sources: [], relatedQuestions: [], safety: { level: "normal", requiresUrgentCare: false, warning: null } }, meta: { conversationId: request.conversationId, requestId: request.requestId } }),
    };
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

for (const route of ["/", "/app"]) {
  it(`opens ${route} directly in the chatbot without a login-first action`, () => {
    render(<MemoryRouter initialEntries={[route]}><RootApp /></MemoryRouter>);
    expect(screen.getByText("Medical knowledge, made clearer.")).toBeTruthy();
    expect(screen.getByLabelText("Chat message")).toBeTruthy();
    expect(screen.queryByText("Welcome back")).toBeNull();
    expect(screen.queryByText("Continue as guest")).toBeNull();
  });
}

it("lets the Firebase-disabled guest send a question immediately", async () => {
  render(<MemoryRouter initialEntries={["/"]}><RootApp /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "Explain hypertension" } });
  fireEvent.click(screen.getByLabelText("Send message"));
  expect(await screen.findByText(answer)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/VITE_FIREBASE|\.env|Firebase is not configured/);
});

it("shows login only on explicit /login and Back to MediSage returns to chat", () => {
  render(<MemoryRouter initialEntries={["/login"]}><RootApp /></MemoryRouter>);
  expect(screen.getByText("Welcome back")).toBeTruthy();
  expect(screen.queryByText("Continue as guest")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Back to MediSage" }));
  expect(screen.getByLabelText("Chat message")).toBeTruthy();
});

it("opens login only after the sidebar Sign in action and Back preserves the conversation", async () => {
  render(<MemoryRouter initialEntries={["/"]}><RootApp /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "Explain hypertension" } });
  fireEvent.click(screen.getByLabelText("Send message"));
  expect(await screen.findByText(answer)).toBeTruthy();
  expect(screen.queryByText("Welcome back")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /Guest/i }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));
  expect(screen.getByText("Welcome back")).toBeTruthy();
  expect(screen.queryByText("Current guest conversation")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Back to MediSage" }));
  expect(await screen.findByText(answer)).toBeTruthy();
});
