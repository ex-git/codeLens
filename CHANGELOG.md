# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.2.1] - 2026-06-21

### Fixed
- Fixed auto-index propagation and behavior: installed configs now include `--auto-index missing`, background indexing runs in a detached child process, `missing` checks persistent index state, and `cl_current` can report `status: "indexing"` with `indexingStartedAt`/`indexingAgeMs`.
- Guarded `cl_refresh` and query activation against duplicating an active background auto-index; `cl_refresh` returns `status:"indexing"` with timing fields while a background index is running.

## [2.2.0] - 2026-06-21

### Added
- Added `--auto-index` option to the CLI and installer (`missing` (default), `always`, or `never`). CodeLens now automatically builds the index in the background when the server starts up in a workspace if no index exists for the current branch. This warms the index before the agent searches, without requiring an explicit `cl_refresh` call. Cursor installations default to `--auto-index missing`.

## [2.1.3] - 2026-06-21

### Changed
- Cursor config (global and local) now attaches to the active workspace via `--cwd ${workspaceFolder}`, which Cursor expands per-workspace. This makes a single global install one-shot across all workspaces (no per-workspace install, no dependence on MCP Roots). Routing prompts/docs/upgrade messaging updated accordingly.

## [2.1.2] - 2026-06-21

### Fixed
- `codelens upgrade` now reports the freshly rebuilt version (was printing the pre-upgrade version, which looked like a one-version-at-a-time upgrade).

### Changed
- `codelens upgrade` now auto-refreshes global agent config + routing using the new build, and reminds Cursor users to run a per-workspace local install.

## [2.1.1] - 2026-06-21

### Added
- Global `--cwd <path>` support for CLI/MCP startup so clients can attach CodeLens to the intended workspace even when launched from another directory.
- Best-effort MCP Roots support for clients such as Cursor that provide workspace roots.

### Changed
- Cursor project-local install now writes `args: ["--cwd", "${workspaceFolder}"]` and routing prompts now report workspace attachment issues instead of silently falling back to raw search.
- Project-local installs for all writable hosts (Claude, Gemini, opencode, Codex) now pin the concrete workspace path via `--cwd`; global installs keep empty args and rely on MCP Roots.

## [2.1.0] - 2026-06-21

### Added
- Deterministic offline `npm run eval:agent` harness comparing CodeLens-style discovery with raw-scan proxy metrics.
- Package metadata test to ensure README-linked docs are included in the npm package.
- Claude slash commands for `cl_explore` and `cl_impact`.

### Changed
- `cl_explore` now supports payload caps (`maxFiles`, `maxResultsPerFile`, `maxRelated`), deterministic ordering, and additive `truncated` metadata.
- `cl_impact` now includes additive `symbolId`, `summary`, provenance, and confidence labels for impact handles.
- npm package `files` now includes README-linked docs (`how-it-works` and `usage-metrics`).

## [2.0.1] - 2026-06-20

### Added
- `cl_explore`: one-call grouped search with compact previews, signatures,
  duplicate-collapse metadata, and a relationship map.
- `cl_impact`: branch-scoped callers/callees/affected-files/affected-tests
  analysis with hop counts, confidence, ambiguity candidates, and confidence
  notes.

### Changed
- Query tools now share freshness reconciliation and can surface per-result
  `stale:true` plus `freshness:"partial"` / `pendingFiles` when refresh work is
  budget-limited.
- Removed obsolete comparison document/link and stale self-deprecating language.

### Fixed
- Docs: corrected README Limitations — cold index for 2000 files is ~3.5s (was
  a stale ~1.6s), the ranking signal list now includes path/code/exact, and the
  identifier-aware subtoken matching is documented (no vector/semantic layer).
- Fixed stale `cl_search` registry description to match the v2 output shape.

## [2.0.0] - 2026-06-20

### Breaking
- **`cl_search` output redesign.** Each result is now
  `{ handle, path, lines, score, why, preview }` and the envelope adds
  `query` and `count`. `lines` is a `"start-end"` string, `why` is a
  comma-joined signal string, and `preview` replaces the old `snippet`.
  The per-result `cursor` field was removed — pagination uses the top-level
  `nextCursor` only. Consumers that read `startLine`/`endLine`/`snippet`/
  per-result `cursor` from `cl_search` must update. (`cl_expand` is unchanged
  and still returns numeric `startLine`/`endLine`.)
- **Compact MCP serialization.** All tool responses are emitted as compact
  JSON (no pretty-print whitespace) to reduce output tokens.

### Added
- **Identifier-aware retrieval.** camelCase/snake_case/PascalCase/ALL_CAPS
  identifiers are split into bounded, deduplicated subtokens in the match-only
  FTS content, with bounded query-side expansion, so a query like `session`
  finds `validateSession`. Snippets/handles are unchanged.
- **Structure-aware chunking.** Code is chunked around outermost symbols with
  line-based fallback, leading comment/decorator attachment, and oversized /
  gap handling; chunks carry `chunker`/`chunker_version`/`symbol_id`.
- **Dev quality harness.** `npm run quality` reports recall@5/MRR/top-1,
  no-regression/precision, and latency on a fixed labeled fixture; added as a
  non-blocking CI step.
- **CLI `codelens search --preview`** prints a short preview line per result.

### Changed
- **Parse once per file.** Symbol and edge extraction share a single
  tree-sitter parse, reducing redundant parsing.
- Internal: shared query tokenizer used by search and snippet rendering.
- `CHUNKER_VERSION` bumped so identifier-enriched FTS content is refreshed on
  the next index refresh.

### Removed
- One-off `reports/codelens-eval/` evaluation files (also purged from history).

## [1.2.0] and earlier
- See git history. Highlights: SQLite FTS5 + tree-sitter symbols + source-graph
  edges, branch-isolated indexing, retrieval-gap improvements (snippet modes,
  deterministic rerank, `cl_map`, graph edges), and the MCP/CLI surface.
