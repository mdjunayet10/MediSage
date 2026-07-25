import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  getRedirectResult,
  linkWithCredential,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  auth,
  googleProvider,
  googleSignInEnabled,
} from "../lib/firebase.js";
import { authConfig } from "../config/authConfig.js";
import { buildApiUrl, parseApiResponse } from "../lib/api.js";

const AuthContext = createContext(null);
let guestInitializationPromise = null;
let localGuestInitializationPromise = null;
let redirectInitializationPromise = null;
const GOOGLE_REDIRECT_GUEST_KEY = "medisage-google-redirect-guest";

export function shouldUseGoogleRedirect(userAgent = "", maxTouchPoints = 0) {
  return (
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)
  );
}

function resolveGoogleRedirectSession() {
  if (!redirectInitializationPromise) {
    redirectInitializationPromise = getRedirectResult(auth).finally(() => {
      redirectInitializationPromise = null;
    });
  }
  return redirectInitializationPromise;
}

function hasStoredGuestData(uid) {
  if (!uid) return false;
  try {
    return Boolean(
      JSON.parse(
        localStorage.getItem(`medisage-conversations-${uid}`) || "[]",
      ).length,
    );
  } catch {
    return false;
  }
}

function ensureLocalGuestSession() {
  if (!localGuestInitializationPromise) {
    localGuestInitializationPromise = fetch(buildApiUrl("/api/session/guest"), {
      method: "POST",
      credentials: "include",
    })
      .then(async (response) => {
        const payload = await parseApiResponse(response);
        if (!payload?.data?.sessionId) throw new Error("Invalid temporary session response.");
        return {
          uid: payload.data.sessionId,
          isAnonymous: true,
          guestSession: true,
          getIdToken: async () => null,
        };
      })
      .catch((error) => {
        if (import.meta.env.DEV) console.warn("MediSage account services are disabled; using an isolated local guest session.", error);
        const storageKey = "medisage-local-guest-session";
        let uid = sessionStorage.getItem(storageKey);
        if (!uid) {
          uid = `local_guest_${crypto.randomUUID()}`;
          sessionStorage.setItem(storageKey, uid);
        }
        return { uid, isAnonymous: true, guestSession: true, localOnly: true, getIdToken: async () => null };
      })
      .finally(() => {
        localGuestInitializationPromise = null;
      });
  }
  return localGuestInitializationPromise;
}

export function ensureGuestSession() {
  if (!auth) return Promise.reject(new Error("Firebase is not configured."));
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  if (!guestInitializationPromise) {
    guestInitializationPromise = signInAnonymously(auth)
      .then((credential) => credential.user)
      .finally(() => {
        guestInitializationPromise = null;
      });
  }
  return guestInitializationPromise;
}

function migrateGuestConversations(fromUid, toUid, choice) {
  if (!fromUid || !toUid || fromUid === toUid) return [];
  const fromKey = `medisage-conversations-${fromUid}`;
  const toKey = `medisage-conversations-${toUid}`;
  try {
    if (choice !== "import") return [];
    const guest = JSON.parse(localStorage.getItem(fromKey) || "[]");
    const existing = JSON.parse(localStorage.getItem(toKey) || "[]");
    const byId = new Map(existing.map((conversation) => [conversation.id, conversation]));
    for (const conversation of guest) {
      const current = byId.get(conversation.id);
      if (!current) byId.set(conversation.id, conversation);
      else {
        const messages = new Map((current.messages || []).map((message) => [message.id, message]));
        for (const message of conversation.messages || []) if (!messages.has(message.id)) messages.set(message.id, message);
        byId.set(conversation.id, { ...current, messages: [...messages.values()] });
      }
    }
    localStorage.setItem(toKey, JSON.stringify([...byId.values()]));
    return [...byId.values()];
  } catch {
    /* Invalid local guest data is never allowed to interrupt authentication. */
    return [];
  } finally {
    localStorage.removeItem(fromKey);
  }
}

function friendlyAuthError(error) {
  const messages = {
    "auth/email-already-in-use": "An account already exists for this email.",
    "auth/credential-already-in-use": "An account already exists with this email. Sign in to continue.",
    "auth/account-exists-with-different-credential": "An account already exists with this email. Sign in to continue.",
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password":
      "Use a stronger password with at least six characters.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/operation-not-allowed": "Guest sessions are not enabled for this Firebase project. Enable Anonymous Authentication and try again.",
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/popup-blocked": "The sign-in window was blocked. Continue in the redirected sign-in page.",
    "auth/unauthorized-domain":
      "Google sign-in is not authorized for this website yet.",
    "auth/network-request-failed":
      "The network interrupted sign-in. Check your connection and try again.",
    "auth/requires-recent-login":
      "For security, sign in again before making this change.",
  };
  const next = new Error(
    messages[error?.code] ||
      error?.message ||
      "Authentication could not be completed.",
  );
  next.code = error?.code || "AUTH_ERROR";
  return next;
}

export function AuthProvider({ children }) {
  const [authState, setAuthState] = useState({
    status: "loading",
    user: null,
    error: null,
  });
  const [pendingMigration, setPendingMigration] = useState(null);

  useEffect(() => {
    if (!authConfig.accountServicesAvailable || !auth) {
      let active = true;
      ensureLocalGuestSession().then((guest) => {
        if (active) setAuthState({ status: "guest", user: guest, error: null });
      });
      return () => {
        active = false;
      };
    }
    let active = true;
    let unsubscribe = () => {};
    const initialize = async () => {
      try {
        const credential = await resolveGoogleRedirectSession();
        const guestUid = sessionStorage.getItem(GOOGLE_REDIRECT_GUEST_KEY);
        sessionStorage.removeItem(GOOGLE_REDIRECT_GUEST_KEY);
        if (
          active &&
          credential?.user &&
          guestUid &&
          guestUid !== credential.user.uid &&
          hasStoredGuestData(guestUid)
        ) {
          setPendingMigration({
            fromUid: guestUid,
            toUid: credential.user.uid,
          });
        }
      } catch (error) {
        sessionStorage.removeItem(GOOGLE_REDIRECT_GUEST_KEY);
        if (active)
          setAuthState((current) => ({
            ...current,
            error: friendlyAuthError(error).message,
          }));
      }
      if (!active) return;
      unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
        if (!active) return;
        if (nextUser) {
          setAuthState({
            status: nextUser.isAnonymous ? "guest" : "authenticated",
            user: nextUser,
            error: null,
          });
          return;
        }
        setAuthState((current) => ({
          ...current,
          status: "loading",
          user: null,
        }));
        try {
          const guest = await ensureGuestSession();
          if (active)
            setAuthState({ status: "guest", user: guest, error: null });
        } catch (error) {
          if (active)
            setAuthState({
              status: "error",
              user: null,
              error: friendlyAuthError(error).message,
            });
        }
      });
    };
    initialize();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const run = async (operation) => {
    if (!authConfig.accountServicesAvailable || !auth)
      throw new Error("Account services are not available in this environment yet.");
    try {
      return await operation();
    } catch (error) {
      throw friendlyAuthError(error);
    }
  };

  const value = useMemo(() => {
    const user = authState.user;
    const signIn = (email, password, remember = true) =>
      run(async () => {
        const guestUid = auth.currentUser?.isAnonymous ? auth.currentUser.uid : null;
        const hasGuestData = hasStoredGuestData(guestUid);
        await setPersistence(
          auth,
          remember ? browserLocalPersistence : browserSessionPersistence,
        );
        const credential = await signInWithEmailAndPassword(auth, email, password);
        if (guestUid && hasGuestData && guestUid !== credential.user.uid)
          setPendingMigration({ fromUid: guestUid, toUid: credential.user.uid });
        return credential;
      });
    const register = async (name, email, password) =>
      run(async () => {
        const credential = auth.currentUser?.isAnonymous
          ? await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email, password))
          : await createUserWithEmailAndPassword(auth, email, password);
        if (name.trim())
          await updateProfile(credential.user, { displayName: name.trim() });
        await sendEmailVerification(credential.user);
        return credential;
      });
    const signOutUser = () => run(async () => {
      const previousUid = auth.currentUser?.uid;
      if (previousUid) localStorage.removeItem(`medisage-conversations-${previousUid}`);
      await signOut(auth);
      return ensureGuestSession();
    });
    return {
      user,
      status: authState.status,
      error: authState.error,
      loading: authState.status === "loading",
      isAuthenticated: Boolean(user),
      isGuest: Boolean(user?.isAnonymous),
      isRegisteredUser: Boolean(user && !user.isAnonymous),
      isEmailVerified: Boolean(user?.emailVerified),
      configured: authConfig.accountServicesAvailable,
      authEnabled: authConfig.enabled,
      hasPendingGuestMigration: Boolean(pendingMigration),
      resolveGuestMigration: (choice) => {
        if (!pendingMigration) return [];
        const imported = migrateGuestConversations(pendingMigration.fromUid, pendingMigration.toUid, choice);
        setPendingMigration(null);
        return imported;
      },
      googleSignInEnabled,
      signIn,
      register,
      signUp: register,
      signInWithGoogle: () =>
        run(async () => {
          const guestUid = auth.currentUser?.isAnonymous
            ? auth.currentUser.uid
            : null;
          const hasGuestData = hasStoredGuestData(guestUid);
          const captureMigration = (credential) => {
            if (
              guestUid &&
              hasGuestData &&
              credential?.user?.uid &&
              guestUid !== credential.user.uid
            ) {
              setPendingMigration({
                fromUid: guestUid,
                toUid: credential.user.uid,
              });
            }
            return credential;
          };
          const redirect = () => {
            if (guestUid)
              sessionStorage.setItem(GOOGLE_REDIRECT_GUEST_KEY, guestUid);
            return signInWithRedirect(auth, googleProvider);
          };
          const preferRedirect = shouldUseGoogleRedirect(
            navigator.userAgent,
            navigator.maxTouchPoints,
          );
          if (preferRedirect) return redirect();
          try {
            const credential = await signInWithPopup(auth, googleProvider);
            return captureMigration(credential);
          } catch (error) {
            if (error?.code === "auth/popup-blocked") return redirect();
            throw error;
          }
        }),
      signOutUser,
      signOut: signOutUser,
      resetPassword: (email) => run(() => sendPasswordResetEmail(auth, email)),
      resendVerification: () =>
        run(() => sendEmailVerification(auth.currentUser)),
      updateName: (displayName) =>
        run(() => updateProfile(auth.currentUser, { displayName })),
      deleteAccount: () => run(() => deleteUser(auth.currentUser)),
    };
  }, [authState, pendingMigration]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
