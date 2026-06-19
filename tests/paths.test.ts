import { describe, it, expect } from "vitest";
import { toPosix, resolveReal, repoRelative, isInsideRepo, assertInsideRepo, PathOutsideRepo } from "../src/util/paths.js";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setupRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ce-paths-"));
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  writeFileSync(join(root, "src", "auth", "session.ts"), "export const x = 1;\n");
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("toPosix", () => {
  it("converts backslashes to forward slashes", () => {
    expect(toPosix("src\\auth\\session.ts")).toBe("src/auth/session.ts");
  });
  it("leaves posix paths unchanged", () => {
    expect(toPosix("src/auth/session.ts")).toBe("src/auth/session.ts");
  });
});

describe("resolveReal", () => {
  it("returns posix form of a real path", () => {
    const { root, cleanup } = setupRepo();
    try {
      const real = resolveReal(join(root, "src", "auth", "session.ts"));
      expect(real).toContain("/src/auth/session.ts");
      expect(real).not.toContain("\\");
    } finally {
      cleanup();
    }
  });
});

describe("repoRelative", () => {
  it("returns repo-relative posix path for an absolute child", () => {
    const { root, cleanup } = setupRepo();
    try {
      const rel = repoRelative(root, join(root, "src", "auth", "session.ts"));
      expect(rel).toBe("src/auth/session.ts");
    } finally {
      cleanup();
    }
  });

  it("accepts a relative path and resolves it under root", () => {
    const { root, cleanup } = setupRepo();
    try {
      const rel = repoRelative(root, "src/auth/session.ts");
      expect(rel).toBe("src/auth/session.ts");
    } finally {
      cleanup();
    }
  });

  it("resolves symlinks to their real target", () => {
    const { root, cleanup } = setupRepo();
    try {
      const link = join(root, "link.ts");
      symlinkSync(join(root, "src", "auth", "session.ts"), link);
      const rel = repoRelative(root, link);
      expect(rel).toBe("src/auth/session.ts");
    } finally {
      cleanup();
    }
  });

  it("preserves case (no lowercasing)", () => {
    const root = mkdtempSync(join(tmpdir(), "ce-case-"));
    try {
      mkdirSync(join(root, "Src"), { recursive: true });
      writeFileSync(join(root, "Src", "Session.ts"), "x");
      const rel = repoRelative(root, join(root, "Src", "Session.ts"));
      expect(rel).toBe("Src/Session.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws PathOutsideRepo on traversal escape", () => {
    const { root, cleanup } = setupRepo();
    try {
      expect(() => repoRelative(root, join(root, "..", "..", "etc", "passwd"))).toThrow(PathOutsideRepo);
    } finally {
      cleanup();
    }
  });
});

describe("isInsideRepo / assertInsideRepo", () => {
  it("isInsideRepo true for child, false for escape", () => {
    const { root, cleanup } = setupRepo();
    try {
      expect(isInsideRepo(root, join(root, "src"))).toBe(true);
      expect(isInsideRepo(root, join(root, "..", "..", "etc"))).toBe(false);
    } finally {
      cleanup();
    }
  });
  it("assertInsideRepo throws on escape", () => {
    const { root, cleanup } = setupRepo();
    try {
      expect(() => assertInsideRepo(root, join(root, "..", "..", "etc"))).toThrow();
    } finally {
      cleanup();
    }
  });
});
import { dedent } from "../src/search/snippet.js";
describe("dedent", () => {
  it("strips common leading whitespace, preserves relative structure", () => {
    const s = "    function foo() {\n      if (x) {\n        return 1;\n      }\n    }";
    expect(dedent(s)).toBe("function foo() {\n  if (x) {\n    return 1;\n  }\n}");
  });
  it("no-op when no common indent", () => {
    expect(dedent("a\nb")).toBe("a\nb");
  });
  it("ignores blank lines when computing common indent", () => {
    expect(dedent("  a\n\n  b")).toBe("a\n\nb");
  });
});
