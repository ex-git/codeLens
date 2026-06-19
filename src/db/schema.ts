// Auto-generated from schema.sql — single source of truth for the DB schema.
// Re-exported so migrations.ts can bundle it without runtime fs reads.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// In dev (vitest from src/): here = src/db/. In build: build/src/db/.
// schema.sql lives alongside this file in src; for the build it is copied by
// the `build` script (cp src/db/schema.sql build/src/db/schema.sql).
export const SCHEMA_V1 = readFileSync(join(here, "schema.sql"), "utf-8");
