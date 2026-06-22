const pendingByIndex = new Map<string, Set<string>>();

/** Remember files that were known stale but not refreshed within the budget. */
export function setPendingPaths(indexId: string, paths: string[]): void {
  if (paths.length === 0) {
    pendingByIndex.delete(indexId);
    return;
  }
  pendingByIndex.set(indexId, new Set(paths));
}

export function getPendingPaths(indexId: string): Set<string> {
  return pendingByIndex.get(indexId) ?? new Set<string>();
}

export function isPendingPath(indexId: string, path: string): boolean {
  return pendingByIndex.get(indexId)?.has(path) ?? false;
}

/**
 * Freshness + pending-file count for a tool result, derived from pending paths.
 * `pendingFiles` is omitted when 0, matching the prior conditional-assignment shape.
 */
export function freshnessFromPending(indexId: string): { freshness: "fresh" | "partial"; pendingFiles?: number } {
  const pending = getPendingPaths(indexId).size;
  return pending > 0 ? { freshness: "partial", pendingFiles: pending } : { freshness: "fresh" };
}

/** Whether `path` is stale (pending refresh) for the given index. Semantic alias of isPendingPath. */
export function isStalePath(indexId: string, path: string): boolean {
  return isPendingPath(indexId, path);
}

/** Mark `item.stale = true` when `path` is pending refresh. Mutates only when stale. */
export function markStale<T extends { stale?: boolean }>(item: T, indexId: string, path: string): void {
  if (isPendingPath(indexId, path)) item.stale = true;
}
