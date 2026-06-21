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
- you need broad orientation in one call (`cl_explore`) — "how does X work?", flows, or unfamiliar areas
- you need relationships — importers, tests, callers (`cl_related`) — or blast radius before edits (`cl_impact`)
- you need a per-file outline / repo map (`cl_map`)
- the repo is large or unfamiliar, or you'd otherwise grep + read many files
- branch-scoped correctness matters (results won't leak across branches)

Then use `cl_expand` to read the exact current content of a chosen target (it
reads from disk — never stale), and `cl_save`/`cl_load` to persist working
context across compaction. If a query result has `stale:true`, read that file
from disk before relying on indexed snippets/edges.

If `cl_current.inGitRepo` is false or `repo` points outside the current
workspace, CodeLens is not attached to this workspace. Report the setup issue and
ask the user to run `codelens install --target cursor --location local --yes`
from the workspace root (or restart the MCP server after roots attach). Do not
silently fall back to raw `find`/`grep` for discovery.

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
branch's index automatically. MCP clients that provide Roots let CodeLens attach
to the active workspace even from a global MCP config; otherwise use `--cwd` or
project-local MCP config.

## Freshness

Query tools auto-refresh changed files before returning (budget-bounded). If
the response carries `freshness: "partial"`, `pendingFiles > 0`, or per-result
`stale:true`, some recent edits were not reindexed within the budget. Read those
files directly with `cl_expand`/raw read, then call `cl_refresh` or re-query when
you need indexed relationships to catch up.

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