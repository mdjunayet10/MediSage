const firebaseConfigured = Boolean(
  import.meta.env.VITE_FIREBASE_API_KEY &&
  import.meta.env.VITE_FIREBASE_AUTH_DOMAIN &&
  import.meta.env.VITE_FIREBASE_PROJECT_ID &&
  import.meta.env.VITE_FIREBASE_APP_ID,
);

export const authConfig = Object.freeze({
  enabled: import.meta.env.VITE_AUTH_ENABLED === "true",
  googleEnabled:
    import.meta.env.VITE_AUTH_ENABLED === "true" &&
    import.meta.env.VITE_GOOGLE_SIGN_IN_ENABLED === "true",
  firebaseConfigured,
  accountServicesAvailable:
    import.meta.env.VITE_AUTH_ENABLED === "true" && firebaseConfigured,
});
