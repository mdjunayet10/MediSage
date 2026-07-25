import { createRemoteJWKSet, jwtVerify } from "jose";

const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

export async function verifyFirebaseIdToken(
  token,
  {
    projectId = process.env.FIREBASE_PROJECT_ID || "medi-sage",
    jwks = FIREBASE_JWKS,
  } = {},
) {
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required.");
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ["RS256"],
  });
  if (
    !payload.sub ||
    typeof payload.sub !== "string" ||
    payload.sub.length > 128
  ) {
    throw new Error("Firebase token subject is invalid.");
  }
  return { ...payload, uid: payload.sub };
}
