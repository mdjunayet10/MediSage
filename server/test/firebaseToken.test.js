import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { verifyFirebaseIdToken } from "../auth/firebaseAdmin.js";

async function firebaseToken({ provider = "anonymous", audience = "medi-sage" } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-firebase-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const token = await new SignJWT({
    email: provider === "anonymous" ? undefined : "learner@example.com",
    firebase: { sign_in_provider: provider },
  })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setSubject("firebase-user-123")
    .setIssuer("https://securetoken.google.com/medi-sage")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  return {
    token,
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
  };
}

test("verifies Firebase anonymous and registered ID tokens without a server credential", async () => {
  for (const provider of ["anonymous", "password", "google.com"]) {
    const { token, jwks } = await firebaseToken({ provider });
    const decoded = await verifyFirebaseIdToken(token, {
      projectId: "medi-sage",
      jwks,
    });
    assert.equal(decoded.uid, "firebase-user-123");
    assert.equal(decoded.firebase.sign_in_provider, provider);
  }
});

test("rejects a Firebase token issued for another project", async () => {
  const { token, jwks } = await firebaseToken({ audience: "another-project" });
  await assert.rejects(
    verifyFirebaseIdToken(token, { projectId: "medi-sage", jwks }),
    /unexpected "aud" claim value/,
  );
});
