import { createHash } from "node:crypto";

/**
 * Content hash for files/chunks (Design Decision: freshness).
 *
 * Uses SHA-256 from node:crypto — synchronous, no extra native dep. Non-crypto
 * would be faster (xxhash) but requires async WASM init; SHA-256 is fast enough
 * at 5MB cap and only hashes changed/suspicious files.
 */

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function contentHashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}