import { z } from "zod";
import type Database from "better-sqlite3";
import { ctxCurrent } from "./current.js";
import { ctxRefresh } from "./refresh.js";
import { ctxSearch } from "./search.js";
import { ctxRelated } from "./related.js";
import { ctxExpand } from "./expand.js";
import { ctxSave, ctxLoad } from "./save.js";
import { ctxPrune, ctxDrop } from "./prune.js";
import { gatherStats } from "../obs/stats.js";
import { runDoctor } from "../obs/doctor.js";
import { UsageTracker, openGlobalUsageDb } from "../obs/usage.js";
import { detectScope } from "../git/scope.js";
import { getOrCreateIndex, getActiveIndexId } from "../index/manager.js";
import { buildIndex } from "../index/indexer.js";

/**
 * Tool registry (Step 24).
 *
 * Central source of truth for the 10 MCP tools: name, zod input schema,
 * description (WHEN/RETURNS/EXAMPLE), and handler. The handlers receive a
 * ServerContext (core db, contexts db, repoRoot) and the parsed args.
 */

export interface ServerContext {
  coreDb: Database.Database;
  ctxDb: Database.Database;
  repoRoot: string;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown;
}

function withScope(ctx: ServerContext) {
  return detectScope(ctx.repoRoot);
}

/** Ensure an active index exists for the current repo scope before query tools. */
function ensureActive(ctx: ServerContext): string {
  const scope = withScope(ctx);
  if (!scope) throw new Error("not inside a git repo (or plain dir support not enabled)");
  // build the index if none active for this scope
  if (!getActiveIndexId()) {
    buildIndex(ctx.coreDb, scope);
  } else {
    getOrCreateIndex(ctx.coreDb, scope);
  }
  return getActiveIndexId()!;
}

export const TOOLS: ToolDef[] = [
  {
    name: "cl_current",
    description:
      "Report current repo/branch/index status with freshness fields. Use first to check if an index is ready.\n\nRETURNS: {repo, branch, headSha, indexId, status, dirtyFiles, lastIndexedAt, inGitRepo}\n\nEXAMPLE: cl_current",
    schema: {},
    handler: (ctx) => ctxCurrent(ctx.coreDb, ctx.repoRoot),
  },
  {
    name: "cl_refresh",
    description:
      "Create or update the current branch/worktree index. Scans files, indexes FTS, extracts symbols, builds graph.\n\nRETURNS: {indexId, branch, indexedFiles, totalChunks, skipped, status}\n\nEXAMPLE: cl_refresh",
    schema: {},
    handler: (ctx) => {
      const scope = withScope(ctx);
      if (!scope) throw new Error("not inside a git repo");
      return ctxRefresh(ctx.coreDb, scope);
    },
  },
  {
    name: "cl_search",
    description:
      "Hybrid search over the current branch index: FTS5 BM25 + symbol-name match + graph proximity, fused via weighted ranking. Compact ranked handles, cursor pagination. Use BEFORE grep/find/read for code discovery. Pass related:true to also get graph neighbors of the top result in one call.\n\nRETURNS: {indexId, results:[{handle,path,startLine,endLine,score,snippet,why}], nextCursor, freshness, pendingFiles}\n\nWHEN NOT: editing exact files (use cl_expand or read instead).\n\nEXAMPLE: cl_search(query: \"session validation\", limit: 5)",
    schema: {
      query: z.string().describe("Search query (2-4 specific technical terms recommended)."),
      limit: z.coerce.number().optional().default(5).describe("Results per page (default 5)."),
      cursor: z.string().optional().describe("Pagination cursor from a prior result's nextCursor."),
      contentType: z.enum(["code", "prose"]).optional().describe("Filter by chunk type: 'code' (source) or 'prose' (docs/markdown). Omit for all, with a modest code boost."),
      related: z.boolean().optional().describe("If true, also return graph neighbors (imports/importers/tests) of the top result — one-call find+explore."),
    },
    handler: (ctx, args) => {
      ensureActive(ctx);
      return ctxSearch(ctx.coreDb, args.query as string, {
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
        scope: withScope(ctx) ?? undefined,
        contentType: args.contentType as "code" | "prose" | undefined,
        related: args.related as boolean | undefined,
      });
    },
  },
  {
    name: "cl_related",
    description:
      "Graph expansion: neighbors of a file (imports/imported_by/tests/callers) within the current index, bounded by depth. Compact handles.\n\nRETURNS: {indexId, results:[{handle,path,edgeType,hops,confidence}]}\n\nEXAMPLE: cl_related(path: \"src/auth/auth.ts\", types: [\"imports\"], depth: 2)",
    schema: {
      path: z.string().describe("Repo-relative POSIX path to expand from."),
      types: z.array(z.string()).optional().describe("Edge types: imports|imported_by|tests|calls|references|defines|exports|belongs_to."),
      depth: z.coerce.number().optional().default(2).describe("Max hops (capped at 3)."),
      direction: z.enum(["out", "in", "both"]).optional().describe("Edge direction. Default 'both'."),
    },
    handler: (ctx, args) => {
      ensureActive(ctx);
      return ctxRelated(ctx.coreDb, args.path as string, {
        types: args.types as string[] | undefined,
        depth: args.depth as number | undefined,
        direction: args.direction as "out" | "in" | "both" | undefined,
      });
    },
  },
  {
    name: "cl_expand",
    description:
      "Return exact current local file content by path/range. Reads from disk — never stale stored text. Use after cl_search/cl_related to read target snippets before editing.\n\nRETURNS: {path, startLine, endLine, content, truncated, chars}\n\nEXAMPLE: cl_expand(path: \"src/auth/session.ts\", startLine: 12, endLine: 58, budget: 1200)",
    schema: {
      path: z.string().optional().describe("Repo-relative POSIX path to read."),
      handle: z.string().optional().describe("Handle from cl_search/cl_related to resolve to a path+range."),
      startLine: z.coerce.number().optional().describe("1-indexed start line (default: file start)."),
      endLine: z.coerce.number().optional().describe("1-indexed end line (default: file end)."),
      budget: z.coerce.number().optional().describe("Max chars to return (default ~4000)."),
      targets: z.array(z.object({
        path: z.string().optional(), handle: z.string().optional(),
        startLine: z.coerce.number().optional(), endLine: z.coerce.number().optional(), budget: z.coerce.number().optional(),
      })).optional().describe("Batch: read multiple targets in one call (cuts round-trips). Returns {results:[...]}."),
    },
    handler: (ctx, args) => {
      ensureActive(ctx);
      if (args.targets && Array.isArray(args.targets)) {
        return { results: (args.targets as Array<{ path?: string; handle?: string; startLine?: number; endLine?: number; budget?: number }>).map((t) => ctxExpand(ctx.coreDb, ctx.repoRoot, t)) };
      }
      return ctxExpand(ctx.coreDb, ctx.repoRoot, {
        path: args.path as string | undefined,
        handle: args.handle as string | undefined,
        startLine: args.startLine as number | undefined,
        endLine: args.endLine as number | undefined,
        budget: args.budget as number | undefined,
      });
    },
  },
  {
    name: "cl_save",
    description:
      "Save a named working-context set (handles/paths + notes) in a separate DB that survives core-index rebuilds. Pin to prevent TTL deletion.\n\nRETURNS: {id, name, pinned, itemCount}\n\nEXAMPLE: cl_save(name: \"auth-investigation\", items: [{path: \"src/auth/session.ts\"}], notes: \"wip\", pinned: true)",
    schema: {
      name: z.string().describe("Context name (unique per repo)."),
      items: z.array(z.object({
        handle: z.string().optional(),
        path: z.string().optional(),
        symbol_id: z.string().optional(),
        chunk_id: z.string().optional(),
      })).describe("Handles/paths to remember."),
      notes: z.string().optional().describe("Free-form notes."),
      pinned: z.boolean().optional().describe("Pin to prevent TTL deletion."),
    },
    handler: (ctx, args) => ctxSave(ctx.ctxDb, ctx.repoRoot, args.name as string, args.items as Array<{ handle?: string; path?: string; symbol_id?: string; chunk_id?: string }>, {
      notes: args.notes as string | undefined,
      pinned: args.pinned as boolean | undefined,
    }),
  },
  {
    name: "cl_load",
    description:
      "Load a saved working-context by name. Returns items (path/symbol-based, stable across reindex).\n\nRETURNS: {context, items}\n\nEXAMPLE: cl_load(name: \"auth-investigation\")",
    schema: { name: z.string().describe("Context name to load.") },
    handler: (ctx, args) => ctxLoad(ctx.ctxDb, ctx.repoRoot, args.name as string),
  },
  {
    name: "cl_stats",
    description:
      "Index statistics: file/symbol/chunk/edge/index counts, total indexes, last indexed. Scoped to active index.\n\nRETURNS: {active, indexId, branch, counts, lastIndexedAt, totalIndexes}\n\nEXAMPLE: cl_stats",
    schema: {},
    handler: (ctx) => gatherStats(ctx.coreDb),
  },
  {
    name: "cl_doctor",
    description:
      "Health check: node version, better-sqlite3, git, schema version, integrity (PRAGMA quick_check), WAL mode. No PII.\n\nRETURNS: diagnostic booleans + integrityOk\n\nEXAMPLE: cl_doctor",
    schema: {},
    handler: (ctx) => runDoctor(ctx.coreDb, ctx.repoRoot),
  },
  {
    name: "cl_usage",
    description:
      "Global usage statistics across all repos: per-tool call counts, bytes served, estimated context bytes saved, and a per-repo breakdown. Use to see how much the index tools are being used.\n\nRETURNS: {perTool:[...], perRepo:[...], totals:{calls,bytes_served,bytes_saved}}\n\nEXAMPLE: cl_usage",
    schema: {},
    handler: () => new UsageTracker(openGlobalUsageDb()).snapshot(),
  },
  {
    name: "cl_prune",
    description:
      "Run a manual TTL sweep: delete expired inactive indexes. Never deletes active/pinned/locked/grace-window indexes.\n\nRETURNS: {deletedIndexes, skipped}\n\nEXAMPLE: cl_prune",
    schema: {},
    handler: (ctx) => ctxPrune(ctx.coreDb),
  },
  {
    name: "cl_drop",
    description:
      "Delete a specific branch/index explicitly. Refuses the active or pinned index.\n\nRETURNS: {deleted, indexId, reason?}\n\nEXAMPLE: cl_drop(branch: \"old-feature\")",
    schema: {
      indexId: z.string().optional().describe("Index id to drop."),
      branch: z.string().optional().describe("Branch name to drop (resolves to latest index)."),
    },
    handler: (ctx, args) => ctxDrop(ctx.coreDb, { indexId: args.indexId as string | undefined, branch: args.branch as string | undefined }),
  },
];