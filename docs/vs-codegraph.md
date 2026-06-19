# CodeLens vs CodeGraph

Both are local, MIT-licensed **code-graph MCP tools** that index a repo and let
agents discover code without grep/read floods. They overlap heavily in spirit
but differ in scope, freshness model, and maturity. This is a factual
comparison; verify CodeGraph's current behavior against its own docs, as both
projects evolve.

## At a glance

| | **CodeLens** (this) | **CodeGraph** (colbymachenry/codegraph) |
|---|----------------------|----------------------------------------|
| License | MIT | MIT |
| Local-only / private | ✅ SQLite, nothing leaves machine | ✅ 100% local, SQLite |
| Core unit | **Per-branch/worktree index** | **Per-project graph** (`.codegraph/`) |
| Distribution | Builds from source (Node ≥ 22.5); self-contained bundle is future work | **Self-contained** — bundles its own Node runtime, no compile/native build |
| Published | Pre-release, not yet on npm | On npm (`@colbymachenry/codegraph`) + GitHub Releases bundle |
| Index layers | FTS5 + tree-sitter symbols + source graph (imports/defines/tests) | Semantic code graph + impact analysis |
| Freshness | **Lazy** — reindexes on next `cl_search` (mtime/size + hash) + watcher short-circuit | **Proactive** — native file watcher (FSEvents/inotify/ReadDirectoryChangesW) with debounced auto-sync (2s) + connect-time catch-up |
| Framework route detection | ❌ generic graph only | ✅ 17 frameworks (Flask, FastAPI, Express, NestJS, Laravel, Drupal, Rails, Play, …) |
| Impact analysis | via `cl_related` (callers/importers/tests, bounded BFS) | dedicated impact-radius tracing |
| Hybrid ranking | FTS + symbol + graph + code-boost (deterministic) | semantic code intelligence |
| Branch isolation | ✅ first-class (results never cross branches) | per-project (branch-agnostic) |
| TTL pruning of old indexes | ✅ (per-branch indexes expire) | n/a (single project graph) |
| Saved working contexts | ✅ separate DB, survive rebuilds | session continuity via events |
| Usage/savings metrics | ✅ global, actual-file-size estimate | has its own analytics (different model) |
| Agents | Claude Code, Cursor, Gemini, opencode, Codex, Pi | Claude Code, Cursor, Codex, opencode, Hermes, Gemini, Antigravity, Kiro |
| Hosted product | none planned | "CodeGraph platform" coming (PR impact analysis) |

## The key conceptual difference

**CodeGraph** is **project-scoped and proactive**: one graph per project
(`.codegraph/`), kept continuously fresh by a native file watcher that syncs as
you type (debounced 2s) plus a connect-time reconciliation. It's a live,
always-current map of the project. Its differentiators are framework-aware
routes (17 frameworks), impact analysis, and a self-contained zero-build
install.

**CodeLens** is **branch-scoped and lazy**: a separate index per
`repo + worktree + branch + HEAD`, refreshed on the next search (mtime/size
diff + content hash, budget-bounded) with a watcher that only short-circuits
quiet periods. Its differentiators are **branch isolation** (results never leak
across `git checkout`), TTL pruning of stale branch indexes, saved working
contexts, and usage metrics computed from actual file sizes.

## When each shines

- **Choose CodeGraph if** you want a mature, self-contained, always-fresh
  project graph with framework route detection and impact analysis, and you
  work mostly in one project at a time.
- **Choose CodeLens if** you switch branches/worktrees often and want
  results scoped to the *current* branch (no cross-branch leakage), want
  lightweight per-branch indexes that auto-expire, or want built-in usage
  metrics + saved contexts. It's smaller and pre-release.

## Overlap (both do this)

- Index the repo locally into SQLite.
- Expose MCP tools for ranked code discovery (compact handles, not raw dumps).
- Route agents off raw `grep`/`find`/`read` for discovery.
- Tree-sitter symbols + a source graph (imports/callers/tests).
- No chat LLM in the core path; deterministic.

## Honesty note

CodeGraph is more mature, self-contained, and feature-rich (route detection,
impact analysis, bundled runtime, broad agent support, a hosted product on the
way). CodeLens is a focused, smaller, branch-first engine with a few unique
tricks (branch isolation, TTL, saved contexts, usage metrics) — pre-release and
not yet bundled/published. If you want production-grade, self-contained,
always-fresh today, CodeGraph is the safer bet; if you specifically need
branch-scoped retrieval, CodeLens is built around that.