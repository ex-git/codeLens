import { randomUUID } from "node:crypto";

/**
 * Prefixed UUID generator for indexed-row ids (Step 24 / DRY refactor 1e).
 *
 * Centralizes the `prefix + randomUUID()` convention so the id-prefix strings
 * (`file_`, `sym_`, `chk_`, `edge_`) have a single source. Returns the same
 * string shape the inline concatenations produced — byte-identical ids.
 *
 * Note: lease-ownership ids (`own_` in index/queue.ts) are a different domain
 * (lease-scoped, not indexed rows) and intentionally stay inline there.
 */
export function id(prefix: string): string {
  return prefix + randomUUID();
}