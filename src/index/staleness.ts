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
