# Agent Guide — CodeLens

End-to-end workflow for a coding agent using codelens.

## Typical session

```
1. cl_current
   → { status: "missing" }   # first run on this branch

2. cl_refresh
   → { indexedFiles: 812, totalChunks: 2400, status: "ready" }

3. cl_search(query: "session validation")
   → results: [
       { handle: "chk_…", path: "src/auth/session.ts", symbol: "validateSession",
         startLine: 12, endLine: 58, score: 0.92, why: ["fts","symbol","graph"] }
     ]

4. cl_related(path: "src/auth/session.ts", types: ["tests","imported_by"])
   → results: [
       { handle: "rel:src/auth/session.test.ts", path: "…", edgeType: "tests", hops: 1 },
       { handle: "rel:src/routes/login.ts", path: "…", edgeType: "imported_by", hops: 1 }
     ]

5. cl_expand(path: "src/auth/session.ts", startLine: 12, endLine: 58, budget: 1200)
   → { content: "export function validateSession(...) { … }", truncated: false }

6. # edit the file with your normal edit tool now that you know the target

7. cl_save(name: "auth-investigation", items: [{path: "src/auth/session.ts"}], pinned: true)
8. cl_load(name: "auth-investigation")   # after compaction
```

## Branch switch

```
git checkout feature-b
cl_current   → detects new branch, may say "missing"
cl_refresh   → builds feature-b index; main's results no longer leak in
```


## Saving context across compaction

`cl_save` / `cl_load` persist named handle sets in a **separate** DB that
survives core-index rebuilds. Pin important contexts to prevent TTL deletion.