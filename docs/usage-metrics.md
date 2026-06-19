# Usage metrics — how "saved" is calculated

`cl_usage` reports per-tool call counts, bytes served, and an **estimated**
context-window saving. The saving is an *estimate*, not a measurement — this
page explains exactly how it's computed and its limits.

## Which tools are tracked

Only the agent's **retrieval + context-management** tools are tracked as
"usage" — the ones that represent the agent actually using CodeLens to
find/read/save code:

| Tool | tracked | calls | bytes_served | bytes_saved |
|------|---------|-------|--------------|-------------|
| `cl_search` | ✅ | ✅ | ✅ | ✅ (discovery) |
| `cl_related` | ✅ | ✅ | ✅ | ✅ (discovery) |
| `cl_expand` | ✅ | ✅ | ✅ | 0 (it *is* the scoped read step) |
| `cl_save` / `cl_load` | ✅ | ✅ | ✅ | 0 (context management) |

**Operational tools are NOT tracked** (they're maintenance, not usage):
`cl_refresh`, `cl_doctor`, `cl_stats`, `cl_prune`, `cl_drop`, `cl_current`,
`cl_usage`. So `cl_refresh` (building the index) does not appear in the usage
report, and checking `cl_usage` never inflates the numbers.

Only the **discovery** tools (`cl_search`, `cl_related`) accrue `bytes_saved` —
the ones that replace "grep + read a bunch of files" with compact handles.

## The formula (refined — actual file sizes)

For a discovery call, CodeLens computes savings from the **real sizes of the
files in the results**, which it already indexes (`files.size`):

```
saved = max(0, Σ(distinct result files' indexed sizes) − bytesServed)
```

- `distinct result files` = the unique paths among the returned handles
  (`cl_search`/`cl_related` results carry `path`).
- `indexed sizes` = `files.size` for those paths in the current branch index.
- `bytesServed` = bytes of the JSON actually sent to the model.
- **Capped at 50 distinct files** so a `cl_related` result returning 100
  importers doesn't inflate the total (the agent wouldn't read all 100
  without the tool).

**Counterfactual being modeled:** without the index, the agent would `grep` +
`read` the relevant files (whole-file reads at their real sizes); with the tool
it got compact handles. The difference is the saved context.

### Fallback (flat proxy)

If the size lookup fails (e.g. index not ready, paths not yet indexed), CodeLens
falls back to a flat proxy:

```
saved = max(0, handles × 4096 − bytesServed)
```

where `4096` is a rough average file size and `handles` = number of result
entries. This is the older, less-accurate estimate, kept only as a graceful
fallback.

## Honest limits

1. **It's a counterfactual estimate, not a measurement.** We don't know exactly
   which files the agent *would have* read without the tool — we assume the
   result files, whole.
2. **Whole-file assumption.** We credit the full file size, but a raw `read`
   might be partial, or the agent might read only the relevant part — so the
   estimate can overstate for large files with small relevant regions.
3. **No grep-output cost.** It ignores the bytes `grep` itself would have dumped
   into context, which would make the real saving *larger*.
4. **No multi-round exploration.** It counts one call, not the exploration
   rounds the agent avoids.
5. The 50-file cap is a judgment call to curb `cl_related` inflation.

Net: treat `saved(est)` as an order-of-magnitude indicator of how much context
the index tools are sparing, not an audited figure.

## Storage

Usage is **global** (`~/.codelens/usage.db`), aggregated across all repos, with
a `(tool, repo_id)` key so `cl_usage` can break it down per repo. It survives
restarts and core-index rebuilds (it's separate from the per-branch index DBs).

Reset with `cl_usage` is not exposed as a tool; from code, `UsageTracker.reset()`
clears it.