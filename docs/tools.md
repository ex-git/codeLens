# Tool Reference — CodeLens

All tools are exposed via MCP. Inputs are validated with zod; outputs are
JSON-serialized text content.

## cl_current
- **Input**: none
- **Returns**: `{ repo, branch, headSha, indexId, status, dirtyFiles, lastIndexedAt, inGitRepo }`
- **Use**: first call to check index readiness.

## cl_refresh
- **Input**: none
- **Returns**: `{ indexId, branch, indexedFiles, totalChunks, skipped, status }`
- **Use**: build/update the current branch index.

## cl_search
- **Input**: `{ query: string, limit?: number=5, cursor?: string }`
- **Returns**: `{ indexId, results:[{handle,path,startLine,endLine,score,snippet,why}], nextCursor, freshness, pendingFiles }`
- **Use**: intent-level code discovery.

## cl_related
- **Input**: `{ path: string, types?: string[], depth?: number=2, direction?: "out"|"in"|"both" }`
- **Returns**: `{ indexId, results:[{handle,path,edgeType,hops,confidence}] }`
- **Edge types**: `imports|imported_by|tests|calls|references|defines|exports|belongs_to`

## cl_expand
- **Input**: `{ path?: string, handle?: string, startLine?: number, endLine?: number, budget?: number=4000 }`
- **Returns**: `{ path, startLine, endLine, content, truncated, chars }`
- **Use**: read exact current file content (disk-backed, never stale). Rejects path traversal.

## cl_save
- **Input**: `{ name: string, items: [{handle?,path?,symbol_id?,chunk_id?}], notes?: string, pinned?: boolean }`
- **Returns**: `{ id, name, pinned, itemCount }`

## cl_load
- **Input**: `{ name: string }`
- **Returns**: `{ context, items }`

## cl_stats
- **Input**: none
- **Returns**: `{ active, indexId, branch, counts, backlog, lastIndexedAt, totalIndexes }`

## cl_doctor
- **Input**: none
- **Returns**: `{ nodeVersion, betterSqlite3, gitPresent, schemaVersion, integrityOk, walMode, inGitRepo, codeVersion }`

## cl_prune
- **Input**: none
- **Returns**: `{ deletedIndexes, skipped, bytesFreed }`

## cl_drop
- **Input**: `{ indexId?: string, branch?: string }`
- **Returns**: `{ deleted, indexId, reason? }` (refuses active/pinned)