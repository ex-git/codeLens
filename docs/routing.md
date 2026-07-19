# Agent Routing Instructions — CodeLens

> Inject this block into your agent's system prompt / rules so it routes code
> discovery through the codelens tools instead of bulk grep/find/read.

## When to use codelens tools

Use the codelens tools for code **discovery** before broad raw searches or bulk
file reads. They keep the context window lean and are branch-scoped. Choose the
tool by intent:

1. Unknown area, conceptual question, execution flow, or unfamiliar subsystem:
   start with `cl_explore` for grouped previews plus relationships.
2. Find a symbol, behavior, or likely implementation location: use ranked hybrid
   `cl_search` for compact handles.
3. Find callers, importers, tests, or dependencies of a known file: use
   `cl_related`.
4. Assess blast radius before changing shared code: use `cl_impact`. Pass
   `symbol` + `path` when both are known; pass `path` alone for module/file
   impact when the symbol is uncertain.
5. Get a cheap structural outline without reading whole files: use `cl_map`.
6. Read exact current content after choosing a target: use `cl_expand` or a raw
   read. Persist important context across compaction with `cl_save`/`cl_load`.

Call `cl_current` when index readiness is uncertain. Installed MCP configs
background-index missing branches; if `status` is `indexing`, wait or retry and
use `indexingStartedAt`/`indexingAgeMs` to judge whether it looks stuck. If
`status` remains `missing`, call `cl_refresh` explicitly.

If a query result has `stale:true` or `freshness:"partial"`, read that file from
disk before relying on indexed snippets/edges.

If `cl_current.inGitRepo` is false or `repo` points outside the current
workspace, CodeLens is not attached to this workspace. Tell the user to restart
the IDE after upgrading (the global Cursor config attaches via
`${workspaceFolder}`), or to re-run `codelens install --target cursor --yes`. Do
not silently fall back to raw `find`/`grep` for discovery.

## When raw grep/find/read is fine (or better)

- you already know an exact string/symbol/path
- you're reading or **editing** a single known file (use `cl_expand` or a raw read)
- the repo is tiny or familiar
- you're **verifying** exact code, logs, or user-supplied paths
- the user explicitly asks for raw command output

The routing is about **discovery**, not a ban on raw reads. Do not start with
broad `grep`, `find`, or bulk `read` when the target is unknown or the question
concerns relationships. Do not force codelens for a known exact lookup either.

## Branch safety

Results are scoped to the **current branch/worktree index only** by default.
After `git checkout`, results will not leak from the old branch. If you switch
branches mid-task, call `cl_current` again; installed MCP configs auto-index the
new branch in the background when its index is missing. MCP clients that provide
Roots let CodeLens attach to the active workspace even from a global MCP config;
Cursor uses `--cwd ${workspaceFolder}`, and other clients can use `--cwd` or
project-local MCP config.

## Freshness

Query tools auto-refresh changed files before returning (budget-bounded). If
the response carries `freshness: "partial"`, `pendingFiles > 0`, or per-result
`stale:true`, some recent edits were not reindexed within the budget. Read those
files directly with `cl_expand`/raw read. Call `cl_refresh` when you need indexed
relationships to catch up, after large branch/file changes, when `cl_current`
remains `missing`, or when the user explicitly asks for a rebuild. If `cl_refresh`
returns `status:"indexing"`, a background auto-index is already running; wait or
retry instead of launching more indexing work.

## Tool quick reference

| Tool | Purpose |
|------|---------|
| `cl_current` | repo/branch/index status + freshness |
| `cl_refresh` | build/update the current branch index |
| `cl_search` | hybrid ranked search → compact handles |
| `cl_explore` | one-call grouped search + previews + relationship map |
| `cl_related` | graph neighbors (imports/tests/callers) |
| `cl_impact` | callers/callees/affected files/tests before edits |
| `cl_map` | per-file symbol outline (repo map) |
| `cl_expand` | exact current file content by path/range |
| `cl_save` / `cl_load` | persist + reload working context |
| `cl_stats` | index counts |
| `cl_doctor` | runtime/DB/integrity health check |
| `cl_prune` | manual TTL sweep |
| `cl_drop` | delete a branch/index explicitly |