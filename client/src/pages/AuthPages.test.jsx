import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const state = vi.hoisted(() => ({ auth: null }));
vi.mock("../auth/AuthContext.jsx", () => ({ useAuth: () => state.auth }));
import {
  ForgotPasswordPage,
  SignInPage,
  SignUpPage,
} from "./AuthPages.jsx";

afterEach(() => cleanup());

function baseAuth(overrides = {}) {
  return {
    user: null,
    loading: false,
    configured: true,
    googleSignInEnabled: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    resetPassword: vi.fn(),
    signInWithGoogle: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Firebase authentication pages", () => {
  it("login calls Firebase sign-in and hides Google when its feature flag is false", async () => {
    state.auth = baseAuth();
    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("MediSage")).toBeTruthy();
    expect(
      document.querySelector('img[src="/medisage-logo.svg"]'),
    ).toBeTruthy();
    expect(screen.queryByText("Continue with Google")).toBeNull();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(state.auth.signIn).toHaveBeenCalledWith(
        "user@example.com",
        "secret123",
        true,
      ),
    );
    expect(screen.queryByText("Current guest conversation")).toBeNull();
    expect(screen.queryByText("Import it into this account")).toBeNull();
  });

  it("shows and invokes the real Google flow when its feature flag is enabled", async () => {
    state.auth = baseAuth({ googleSignInEnabled: true });
    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    await waitFor(() =>
      expect(state.auth.signInWithGoogle).toHaveBeenCalledOnce(),
    );
  });

  it("registration validates terms and calls Firebase registration", async () => {
    state.auth = baseAuth();
    render(
      <MemoryRouter>
        <SignUpPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Medical Learner" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "learner@example.com" },
    });
    const passwords = screen.getAllByLabelText(/password/i);
    fireEvent.change(passwords[0], { target: { value: "StrongPass123" } });
    fireEvent.change(passwords[1], { target: { value: "StrongPass123" } });
    fireEvent.click(
      screen.getByLabelText("I accept the Terms and Privacy notice"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(state.auth.signUp).toHaveBeenCalledWith(
        "Medical Learner",
        "learner@example.com",
        "StrongPass123",
      ),
    );
  });

  it("offers the same Google account flow on registration", async () => {
    state.auth = baseAuth({
      googleSignInEnabled: true,
      signInWithGoogle: vi
        .fn()
        .mockResolvedValue({ user: { uid: "google-user" } }),
    });
    render(
      <MemoryRouter>
        <SignUpPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    await waitFor(() =>
      expect(state.auth.signInWithGoogle).toHaveBeenCalledOnce(),
    );
  });

  it("forgot password uses the neutral Firebase reset flow", async () => {
    state.auth = baseAuth();
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset email" }));
    await waitFor(() =>
      expect(state.auth.resetPassword).toHaveBeenCalledWith("user@example.com"),
    );
    expect(await screen.findByText(/If an account exists/)).toBeTruthy();
  });
});
