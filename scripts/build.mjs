// Post-tsc asset copy: copy *.sql schema files next to their compiled JS so
// runtime readFileSync resolves them in both dev (src/) and build (build/src/).
import { cpSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dirs = ["db", "context"];
for (const d of dirs) {
  const srcDir = join("src", d);
  const outDir = join("build", "src", d);
  if (!existsSync(srcDir)) continue;
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(srcDir)) {
    if (f.endsWith(".sql")) cpSync(join(srcDir, f), join(outDir, f));
  }
}
