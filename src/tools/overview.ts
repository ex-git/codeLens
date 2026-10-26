import type Database from "better-sqlite3";
import { requireActiveIndex } from "../index/manager.js";
import { freshnessFromPending } from "../index/staleness.js";
import { analyzeOverview, type OverviewOptions } from "../graph/overview.js";

export function ctxOverview(db: Database.Database, opts: OverviewOptions = {}) {
  const indexId = requireActiveIndex(db);
  return { indexId, ...analyzeOverview(db, indexId, opts), ...freshnessFromPending(indexId) };
}
