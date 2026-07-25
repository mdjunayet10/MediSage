import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sourceText(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.name === "noSecrets.test.js") return "";
      return entry.isDirectory()
        ? sourceText(target)
        : fs.readFileSync(target, "utf8");
    })
    .join("\n");
}

describe("client secret boundary", () => {
  it("contains no API key or backend key variable", () => {
    const text = sourceText(path.resolve("src"));
    expect(text).not.toMatch(/sk-or-v1-|OPENROUTER_API_KEY/);
    expect(text).not.toMatch(
      /FIREBASE_ADMIN|private_key|service-account\.json|BEGIN PRIVATE KEY/,
    );
  });

  it("documents a dedicated HTTPS Vercel production API origin", () => {
    const example = fs.readFileSync(
      path.resolve(".env.production.example"),
      "utf8",
    );
    expect(example).toMatch(
      /^VITE_API_BASE_URL=https:\/\/[A-Z-]+\.vercel\.app$/m,
    );
    expect(example).not.toMatch(/OPENROUTER_API_KEY/);
  });
});
