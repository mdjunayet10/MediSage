import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const auth = { currentUser: null };
  return {
    auth,
    signInAnonymously: vi.fn(),
    linkWithCredential: vi.fn(),
    onAuthStateChanged: vi.fn(),
    getRedirectResult: vi.fn(),
    signInWithPopup: vi.fn(),
    signInWithRedirect: vi.fn(),
  };
});

vi.mock("../lib/firebase.js", () => ({
  auth: mocks.auth,
  firebaseConfigured: true,
  googleProvider: {},
  googleSignInEnabled: true,
}));
vi.mock("../config/authConfig.js", () => ({
  authConfig: { enabled: true, googleEnabled: false, firebaseConfigured: true, accountServicesAvailable: true },
}));
vi.mock("firebase/auth", () => ({
  browserLocalPersistence: {},
  browserSessionPersistence: {},
  createUserWithEmailAndPassword: vi.fn(),
  deleteUser: vi.fn(),
  EmailAuthProvider: { credential: vi.fn(() => ({ providerId: "password" })) },
  getRedirectResult: mocks.getRedirectResult,
  linkWithCredential: mocks.linkWithCredential,
  onAuthStateChanged: mocks.onAuthStateChanged,
  sendEmailVerification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  setPersistence: vi.fn(),
  signInAnonymously: mocks.signInAnonymously,
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: mocks.signInWithPopup,
  signInWithRedirect: mocks.signInWithRedirect,
  signOut: vi.fn(),
  updateProfile: vi.fn(),
}));

import {
  AuthProvider,
  shouldUseGoogleRedirect,
  useAuth,
} from "./AuthContext.jsx";

function Probe() {
  const auth = useAuth();
  return <><span>{auth.status}</span><span>{auth.isGuest ? "Guest" : "Registered"}</span><span>{auth.hasPendingGuestMigration ? "Migration ready" : "No migration"}</span><button onClick={() => auth.signUp("Learner", "learner@example.com", "secret123")}>Link account</button><button onClick={() => auth.signInWithGoogle()}>Google account</button></>;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  const guest = { uid: "guest-stable", isAnonymous: true, getIdToken: vi.fn() };
  mocks.auth.currentUser = null;
  mocks.signInAnonymously.mockReset().mockImplementation(async () => {
    mocks.auth.currentUser = guest;
    return { user: guest };
  });
  mocks.linkWithCredential.mockReset().mockResolvedValue({ user: { ...guest, isAnonymous: false } });
  mocks.onAuthStateChanged.mockReset().mockImplementation((_auth, callback) => {
    callback(mocks.auth.currentUser);
    return vi.fn();
  });
  mocks.getRedirectResult.mockReset().mockResolvedValue(null);
  mocks.signInWithPopup.mockReset();
  mocks.signInWithRedirect.mockReset().mockResolvedValue(undefined);
});

it("uses popup auth on desktop Safari and reserves redirect auth for mobile Apple devices", () => {
  expect(
    shouldUseGoogleRedirect(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15",
    ),
  ).toBe(false);
  expect(
    shouldUseGoogleRedirect(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    ),
  ).toBe(true);
  expect(
    shouldUseGoogleRedirect(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1",
      5,
    ),
  ).toBe(true);
});

it("creates only one anonymous Firebase session in React Strict Mode and exposes guest state", async () => {
  render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>);
  expect(await screen.findByText("Guest")).toBeTruthy();
  expect(screen.getByText("guest")).toBeTruthy();
  expect(mocks.signInAnonymously).toHaveBeenCalledOnce();
});

it("links email registration to the current anonymous UID instead of signing it out", async () => {
  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText("Guest");
  fireEvent.click(screen.getByRole("button", { name: "Link account" }));
  await waitFor(() => expect(mocks.linkWithCredential).toHaveBeenCalledOnce());
  expect(mocks.auth.currentUser.uid).toBe("guest-stable");
  expect(JSON.stringify(localStorage)).not.toMatch(/secret123|token/i);
});

it("signs into an existing Google account and preserves guest data for post-login migration", async () => {
  localStorage.setItem(
    "medisage-conversations-guest-stable",
    JSON.stringify([{ id: "guest-conversation", messages: [] }]),
  );
  mocks.signInWithPopup.mockResolvedValue({
    user: { uid: "existing-google-user", isAnonymous: false },
  });
  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText("Guest");
  fireEvent.click(screen.getByRole("button", { name: "Google account" }));
  await waitFor(() => expect(mocks.signInWithPopup).toHaveBeenCalledOnce());
  expect(mocks.signInWithPopup.mock.calls[0][0]).toBe(mocks.auth);
  expect(await screen.findByText("Migration ready")).toBeTruthy();
});

it("falls back to Google redirect when the popup is blocked without linking the guest account", async () => {
  mocks.signInWithPopup.mockRejectedValue({
    code: "auth/popup-blocked",
    message: "blocked",
  });
  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText("Guest");
  fireEvent.click(screen.getByRole("button", { name: "Google account" }));
  await waitFor(() => expect(mocks.signInWithRedirect).toHaveBeenCalledOnce());
  expect(mocks.signInWithRedirect.mock.calls[0][0]).toBe(mocks.auth);
  expect(sessionStorage.getItem("medisage-google-redirect-guest")).toBe(
    "guest-stable",
  );
});
