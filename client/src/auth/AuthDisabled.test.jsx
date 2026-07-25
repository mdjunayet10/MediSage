import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../config/authConfig.js", () => ({
  authConfig: { enabled: false, googleEnabled: false, firebaseConfigured: false, accountServicesAvailable: false },
}));
vi.mock("../lib/firebase.js", () => ({ auth: null, googleProvider: {}, googleSignInEnabled: false }));
vi.mock("firebase/auth", () => ({
  browserLocalPersistence: {}, browserSessionPersistence: {}, createUserWithEmailAndPassword: vi.fn(), deleteUser: vi.fn(),
  EmailAuthProvider: { credential: vi.fn() }, getRedirectResult: vi.fn(), GoogleAuthProvider: { credentialFromError: vi.fn() }, linkWithCredential: vi.fn(), linkWithPopup: vi.fn(), linkWithRedirect: vi.fn(),
  onAuthStateChanged: vi.fn(), sendEmailVerification: vi.fn(), sendPasswordResetEmail: vi.fn(), setPersistence: vi.fn(),
  signInAnonymously: vi.fn(), signInWithCredential: vi.fn(), signInWithEmailAndPassword: vi.fn(), signInWithPopup: vi.fn(), signInWithRedirect: vi.fn(), signOut: vi.fn(), updateProfile: vi.fn(),
}));
import { AuthProvider, useAuth } from "./AuthContext.jsx";

function Probe() {
  const state = useAuth();
  return <span>{state.status}:{state.user?.uid}:{state.isGuest ? "guest" : "other"}</span>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("bootstraps one signed server guest session without initializing Firebase", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { sessionId: "guest_server_1", type: "guest" } }),
  }));
  render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>);
  expect(await screen.findByText("guest:guest_server_1:guest")).toBeTruthy();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith("/api/session/guest", expect.objectContaining({ method: "POST", credentials: "include" }));
});
