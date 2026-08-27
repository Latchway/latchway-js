import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("strict CSP compatibility", () => {
  it("does not evaluate source text or inject scripts", () => {
    const sourceRoot = new URL("../src/", import.meta.url);
    const files = readdirSync(sourceRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith(".ts"));
    for (const file of files) {
      const source = readFileSync(new URL(String(file), sourceRoot), "utf8");
      expect(source, String(file)).not.toMatch(/\beval\s*\(|\bnew\s+Function\s*\(|createElement\s*\(\s*["']script/u);
    }
  });
});
