import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const clientRoot = process.cwd();
const read = (path) => readFileSync(`${clientRoot}/${path}`);

function pngSize(path) {
  const file = read(path);
  expect(file.subarray(1, 4).toString()).toBe("PNG");
  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
  };
}

describe("MediSage browser and installed-app branding", () => {
  it("uses only the MediSage title and canonical logo metadata", () => {
    const html = read("index.html").toString();
    expect(html).toContain("<title>MediSage</title>");
    expect(html).toContain('rel="icon" type="image/svg+xml" href="/medisage-logo.svg"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('rel="manifest" href="/site.webmanifest"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('property="og:title" content="MediSage"');
    expect(html).not.toContain(["MediSage", "AI"].join(" "));
  });

  it("publishes consistent PWA names and required icon sizes", () => {
    const manifest = JSON.parse(read("public/site.webmanifest").toString());
    expect(manifest.name).toBe("MediSage");
    expect(manifest.short_name).toBe("MediSage");
    expect(manifest.icons.map(({ sizes }) => sizes)).toEqual([
      "192x192",
      "512x512",
    ]);
    expect(pngSize("public/icons/medisage-32.png")).toEqual({
      width: 32,
      height: 32,
    });
    expect(pngSize("public/icons/apple-touch-icon.png")).toEqual({
      width: 180,
      height: 180,
    });
    expect(pngSize("public/icons/medisage-192.png")).toEqual({
      width: 192,
      height: 192,
    });
    expect(pngSize("public/icons/medisage-512.png")).toEqual({
      width: 512,
      height: 512,
    });
  });
});
