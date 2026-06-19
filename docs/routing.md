# Agent Routing Instructions — CodeLens

> Inject this block into your agent's system prompt / rules so it routes code
> discovery through the codelens tools instead of raw grep/find/read.

## When to use codelens tools

**For codebase discovery, do NOT start with `grep`/`find`/`read`.** Use the
codelens tools first:

1. Call `cl_current` to confirm the index is ready for the current branch.
   - If `status` is `missing`, call `cl_refresh` to build the index.
2. Use `cl_search` to find relevant files/symbols by intent (2–4 specific terms).
3. Use `cl_related` to expand graph neighbors (tests, callers, imports).
4. Use `cl_expand` to read the exact current file content for a chosen target
   (it reads from disk — never stale).
5. Save working context with `cl_save` and reload it with `cl_load` across
   compaction / long sessions.

## When raw reads are still allowed

- Before **editing** a file: read the exact target file with your normal read
  tool (or `cl_expand`) so you have the current bytes.
- When **verifying** exact code, logs, or user-supplied paths.
- When `cl_search` explicitly cannot answer (e.g. the index is empty and the
  repo is not a git repo).
- When the user explicitly asks for raw command output.

Do **not** ban raw reads outright — they are correct for editing and
verification. The routing is about **discovery**: prefer indexed context over
bulk file dumps to keep your context window lean.

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
| `cl_expand` | exact current file content by path/range |
| `cl_save` / `cl_load` | persist + reload working context |
| `cl_stats` | index counts |
| `cl_doctor` | runtime/DB/integrity health check |
| `cl_prune` | manual TTL sweep |
| `cl_drop` | delete a branch/index explicitly |