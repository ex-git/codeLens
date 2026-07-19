# Agent Guide — CodeLens

End-to-end workflow for a coding agent using codelens.

## Typical session

```
1. cl_current
   → { status: "missing" }   # first run on this branch

2. cl_refresh
   → { indexedFiles: 812, totalChunks: 2400, status: "ready" }

3. cl_explore(query: "session validation flow")
   → { query: "session validation flow", count: 3,
       files: [{ path: "src/auth/session.ts", results: [{ handle: "chk_…", lines: "12-58", preview: "export function validateSession…" }] }],
       related: [{ sourcePath: "src/auth/session.ts", path: "src/routes/login.ts", edgeType: "imported_by", hops: 1 }] }

   # If you only need to locate a handle, use the leaner search tool:
   cl_search(query: "session validation")
   → { query: "session validation", count: 1, results: [
       { handle: "chk_…", path: "src/auth/session.ts", lines: "12-58",
         score: 0.92, why: "fts,symbol,graph", preview: "export function validateSession(token: string): boolean" }
     ] }

4. cl_related(path: "src/auth/session.ts", types: ["tests","imported_by"])
   → results: [
       { handle: "rel:src/auth/session.test.ts", path: "…", edgeType: "tests", hops: 1 },
       { handle: "rel:src/routes/login.ts", path: "…", edgeType: "imported_by", hops: 1 }
     ]
   # TS/JS also populate `calls`/`references` and resolve dynamic import().

   # Before changing shared code, ask for the blast radius.
   cl_impact(symbol: "validateSession", path: "src/auth/session.ts")
   → { callers: [...], callees: [...], affectedFiles: [...], affectedTests: [...], confidenceNote: "…" }

   # Orientation (optional): outline a file or directory without reading it.
   cl_map(path: "src/auth")
   → files: [{ path: "src/auth/session.ts", symbols: [{ name: "validateSession", kind: "function", signature: "export function validateSession(token: string): boolean" }] }]

5. cl_expand(path: "src/auth/session.ts", startLine: 12, endLine: 58, budget: 1200)
   → { content: "export function validateSession(...) { … }", truncated: false }

6. # edit the file with your normal edit tool now that you know the target

7. cl_save(name: "auth-investigation", items: [{path: "src/auth/session.ts"}], pinned: true)
8. cl_load(name: "auth-investigation")   # after compaction
```

## Tool choice

Choose by intent rather than calling every tool in sequence:

- Unknown area, conceptual question, or execution flow: start with `cl_explore`.
- Find a symbol, behavior, or likely implementation location: use ranked hybrid `cl_search`.
- Find callers, importers, tests, or dependencies of a known file: use `cl_related`.
- Assess blast radius before editing shared code: use `cl_impact`. Pass `symbol` + `path` when both are known; pass `path` alone for module/file impact when the symbol is uncertain.
- Get a cheap structural outline without reading whole files: use `cl_map`.
- Inspect exact current content after choosing the target: use `cl_expand` or a raw read.

Do not start with broad `grep`, `find`, or bulk reads when the target is unknown
or the question concerns relationships. Raw tools remain appropriate for known
exact strings/paths, logs/generated output, and exact verification or editing.

## Branch switch

```
git checkout feature-b
cl_current   → detects new branch, may say "missing"
cl_refresh   → builds feature-b index; main's results no longer leak in
```


## Freshness and stale results

Query tools reconcile changed files before answering. If a response includes `freshness: "partial"`, `pendingFiles`, or per-result `stale:true`, read those stale files directly (`cl_expand` or raw read) before relying on indexed previews/edges.

## Saving context across compaction

`cl_save` / `cl_load` persist named handle sets in a **separate** DB that
survives core-index rebuilds. Pin important contexts to prevent TTL deletion.