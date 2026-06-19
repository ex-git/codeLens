# CodeLens Evaluation Harness

A repeatable, fair way to measure **CodeLens vs. raw grep/find/read** for a
coding agent. Two isolated sessions (ON / OFF) run the **same** task set and
each writes a timestamped report; you diff the reports.

## Files
- `prompt-template.md` — the MODE-toggle prompt + report schema. Paste into each session.
- `task-set.md` — the standard tasks (incl. grep-hostile ones) + a separate grader answer-key.
- reports land at `reports/codelens-eval/<codelens-on|codelens-off>-<UTC>.md`.

## Procedure
1. **Session 1 (CodeLens ON):** enable the CodeLens MCP server; paste `prompt-template.md` with `MODE: CodeLens ON`.
2. **Session 2 (CodeLens OFF):** in a fresh session, **disable** the CodeLens MCP server at the client level; paste with `MODE: CodeLens OFF`.
3. Diff the two reports (or have a throwaway third session read both and produce the verdict table).

## Fairness rules (must hold)
- **Same git HEAD**, same model, same task wording/acceptance in both runs (the report header records the sha).
- **Fresh context per run** — no shared memory; otherwise OFF benefits from ON's discoveries.
- **Enforce the toolset at the client/MCP level**, not just via prompt text. In OFF, actually disable the CodeLens server.
- **Analysis-only tasks** (no edits) so both arms can run without touching the worktree.
- Keep the **grader answer-key out** of the agent-facing prompt.

## Normalized byte accounting (the key fix)
Earlier ad-hoc runs under-counted the OFF arm. Count bytes consistently:
- **OFF baseline bytes** = bytes of files read (`cat`/`sed`/`read`) **plus** the bytes `grep`/`find` dumped into context. Do not discount grep output.
- **ON bytes** = `cl_search`/`cl_related` result payloads (previews) **plus** every `cl_expand` they triggered. Count follow-up fetches against ON.
- Report `cl_refresh` (index build) **separately** as one-time setup, not per-task cost.
- `cl_usage`'s `bytes_saved` is a **global, cumulative estimate** — record it for context but **do not** use it as the per-run comparison metric.

## Scoring (in priority order)
1. Answer correctness / completeness (most important).
2. Total context bytes/tokens used (normalized as above).
3. Discovery round-trips / turns to first correct target.
4. Wrong / stale / out-of-scope results (e.g. hits in ignored/build dirs).

Decision rule for tuning (e.g. default `snippet` mode): if a thinner preview
*increases* total bytes (preview + extra `cl_expand`) or round-trips, it lost.

## Validity notes
- One task is not a verdict — run the full set and prefer ≥5 tasks per arm.
- Tasks where the feature maps to a well-named directory favor grep; include
  unknown-term and cross-file-graph tasks to stress semantic/graph retrieval.
