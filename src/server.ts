#!/usr/bin/env node
import { checkInstall, checkSqlite, formatInstallationFailure } from "./runtime/install-check.js";
import { parseCwdArg } from "./runtime/root.js";

/** Keep diagnostics loadable even when native application imports fail. */
export async function main(): Promise<void> {
  const args = parseCwdArg(process.argv.slice(2)).args;
  if (args[0] === "--check-install") {
    const report = checkInstall();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const sqlite = checkSqlite();
  if (!sqlite.ok) {
    console.error(formatInstallationFailure(sqlite));
    process.exitCode = 1;
    return;
  }

  const application = await import("./application.js");
  await application.main();
}

main().catch((err: unknown) => {
  console.error("codelens server error:", err);
  process.exitCode = 1;
});
