import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

interface PackageJson {
  files?: string[];
}

describe("package metadata", () => {
  it("includes README-linked docs in the npm package files", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as PackageJson;
    expect(pkg.files).toEqual(expect.arrayContaining([
      "README.md",
      "docs/agent-guide.md",
      "docs/how-it-works.md",
      "docs/routing.md",
      "docs/tools.md",
      "docs/usage-metrics.md",
    ]));
  });
});
