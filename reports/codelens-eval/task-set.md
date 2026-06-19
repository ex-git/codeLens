# Eval Task Set

Identical in both sessions. Mix of grep-favorable, grep-hostile (unknown-term),
and graph/cross-file tasks so the comparison stresses what CodeLens is for.
Fill `<…>` per repo. **Do not paste the answer-key section into the agent.**

## Tasks

### A. Known-term locate (grep-favorable baseline)
A1. Locate where `<WELL_NAMED_FEATURE>` is defined; list its tests and importers.

### B. Unknown-term / semantic (grep-hostile)
B1. Find where the code handles `<CONCEPT, e.g. "retry with backoff">` — you are
    NOT given the function/file name. Cite exact paths.
B2. Find where `<CROSS-CUTTING CONCERN, e.g. "request rate limiting">` is enforced,
    without grepping a known identifier.

### C. Graph / cross-file
C1. For `<SYMBOL>`, list its callers and the tests that exercise it.
C2. For a change to `<X>`, identify every file that must change with it and why.

### D. Orientation
D1. Produce an outline of `<DIRECTORY>` (top-level symbols per file).

## Metrics to record per task
- tool calls (by tool), bytes pulled into context (normalized — see README),
  discovery round-trips, turns to first correct target, correctness (yes/no + why),
  wrong/stale/out-of-scope results.

---

# GRADER ANSWER-KEY (do NOT show the agent)

> Fill these once per repo so both runs are graded against the same ground truth.

- A1 `<WELL_NAMED_FEATURE>`: defined in `<paths>`, tests `<paths>`, importers `<paths>`.
- B1 `<CONCEPT>`: real location(s) `<paths>` (note the non-obvious naming).
- B2 `<CONCERN>`: `<paths>`.
- C1 `<SYMBOL>`: callers `<paths>`, tests `<paths>`.
- C2 `<X>`: required edits `<paths>` + rationale.
- D1 `<DIRECTORY>`: expected files/symbols `<list>`.

Grade each task: correct / partial / wrong, then apply the README scoring order.
