# Eval Prompt Template

Paste into each session. Flip the `MODE` line for the second run.

```
MODE: CodeLens ON          # <-- change to "CodeLens OFF" for the second session

GOAL
Complete the tasks in reports/codelens-eval/task-set.md against THIS local repo,
then write a single timestamped report logging every discovery action with a
timestamp and the tool used.

TOOL RULES
- MODE = CodeLens ON: do ALL discovery via cl_search / cl_related / cl_expand /
  cl_map. Raw read only to confirm an exact file you already located. No grep/find
  for discovery.
- MODE = CodeLens OFF: do ALL discovery via grep / find / ls / read. No cl_* tools.
- BOTH: purely local. No GitHub MCP, no web/search, no other MCP servers, no
  network. Identical tasks and acceptance either way. Analysis only — do NOT
  modify files; for change-impact, output the LIST of files/lines.

LOGGING (every discovery/read action)
Run `date -u +%Y-%m-%dT%H:%M:%SZ` first, then record:
timestamp | tool | query/target | result_count | approx_bytes_pulled_into_context.

BYTE ACCOUNTING (normalized — see reports/codelens-eval/README.md)
- OFF: count bytes of files read PLUS bytes grep/find dumped into context.
- ON: count cl_search/cl_related preview payloads PLUS every cl_expand they triggered.
- Report cl_refresh (ON) separately as one-time setup, not task cost.

REPORT OUTPUT
Write to: reports/codelens-eval/<MODE-slug>-<UTC>.md
(<MODE-slug> = codelens-on|codelens-off; <UTC> = `date -u +%Y%m%dT%H%M%SZ`)
Sections, in order:
1. Header: MODE, repo, branch, git HEAD sha, model, start/end time.
2. Setup cost: ON → run cl_refresh once, record duration/result; OFF → N/A.
3. Tool-usage log (the table above).
4. Per-task results: answer, exact paths cited, round-trips, turns-to-target,
   correct/complete (yes/no + why) — for every task in task-set.md.
5. Totals: tool calls by tool, total normalized bytes, total round-trips,
   wrong/stale/out-of-scope results.
6. ON only: paste cl_usage at the end, noting it is a global/cumulative estimate
   and NOT the per-run metric.

STOP RULES
- If a task can't be done with the allowed tools, log it as a failure mode; do
  NOT switch toolsets.
- Do not compare against the other mode — comparison happens later by diffing.
```
