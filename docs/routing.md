# Agent Routing Instructions — CodeLens

> Inject this block into your agent's system prompt / rules so it routes code
> discovery through the codelens tools instead of bulk grep/find/read.

## When to use codelens tools

Prefer the codelens tools for code **discovery** — they keep the context window
lean and are branch-scoped. They are guidance, not an absolute mandate: use the
right tool for the job.

0. Call `cl_current` to confirm the index is ready; if `status` is `missing`,
   call `cl_refresh` to build it.

Prefer codelens when:
- you don't know the exact name/string (semantic or conceptual search via `cl_search`)
- you need relationships — importers, tests, callers (`cl_related`) — or a
  per-file outline / repo map (`cl_map`)
- the repo is large or unfamiliar, or you'd otherwise grep + read many files
- branch-scoped correctness matters (results won't leak across branches)

Then use `cl_expand` to read the exact current content of a chosen target (it
reads from disk — never stale), and `cl_save`/`cl_load` to persist working
context across compaction.

## When raw grep/find/read is fine (or better)

- you already know an exact string/symbol/path
- you're reading or **editing** a single known file (use `cl_expand` or a raw read)
- the repo is tiny or familiar
- you're **verifying** exact code, logs, or user-supplied paths
- the user explicitly asks for raw command output

The routing is about **discovery**, not a ban on raw reads. Don't force codelens
for a known exact lookup; don't fall back to bulk grep when you don't know what
you're looking for.

## Branch safety

Results are scoped to the **current branch/worktree index only** by default.
After `git checkout`, results will not leak from the old branch. If you switch
branches mid-task, call `cl_current` again; the tool activates/creates the new
branch's index automatically.

## Freshness

`cl_search` auto-refreshes changed files before returning (budget-bounded). If
the response carries `freshness: "partial"` and `pendingFiles > 0`, some very
recent edits may not yet be reflected — call `cl_refresh` or re-query.

## Tool quick reference

| Tool | Purpose |
|------|---------|
| `cl_current` | repo/branch/index status + freshness |
| `cl_refresh` | build/update the current branch index |
| `cl_search` | hybrid ranked search → compact handles |
| `cl_related` | graph neighbors (imports/tests/callers) |
| `cl_map` | per-file symbol outline (repo map) |
| `cl_expand` | exact current file content by path/range |
| `cl_save` / `cl_load` | persist + reload working context |
| `cl_stats` | index counts |
| `cl_doctor` | runtime/DB/integrity health check |
| `cl_prune` | manual TTL sweep |
| `cl_drop` | delete a branch/index explicitly |