import { createHash } from "node:crypto";
import type { GitScope } from "../git/scope.js";

/**
 * Index identity (Design Decisions: branch isolation).
 *
 * index_id = sha256(repoRoot | worktreePath | branch | headSha)
 *
 * Every stored row carries index_id; every query filters by the active id so
 * branch A never returns branch B results by default.
 */

export function computeIndexId(scope: GitScope): string {
  if (!scope.repoRoot) throw new Error("computeIndexId: missing repoRoot");
  if (!scope.headSha && !scope.detached) {
    // Allow empty head only for detached/fresh repos. A normal branch with no
    // head is a caller bug.
    throw new Error("computeIndexId: missing headSha on non-detached scope");
  }
  const key = [scope.repoRoot, scope.worktreePath, scope.branch, scope.headSha].join("|");
  return "idx_" + createHash("sha256").update(key).digest("hex").slice(0, 32);
}