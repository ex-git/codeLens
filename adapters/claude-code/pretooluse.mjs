#!/usr/bin/env node
// Claude Code PreToolUse hook: nudge large raw Bash/Read/Grep calls toward
// codelens tools. Non-blocking — returns a soft note rather than denying.
import { readFileSync } from "node:fs";

function read() {
  let data = "";
  try { data = readFileSync(0, "utf-8"); } catch { /* no stdin */ }
  return data;
}

try {
  const raw = read();
  if (!raw) process.exit(0);
  const evt = JSON.parse(raw);
  const tool = evt?.tool_name ?? evt?.toolName;
  const input = evt?.tool_input ?? evt?.toolInput ?? {};
  // Heuristic: a grep/read over many files or a huge path set → suggest CodeLens discovery tools.
  const isDiscovery =
    tool === "Grep" ||
    (tool === "Read" && Array.isArray(input?.file_paths) && input.file_paths.length > 3) ||
    (tool === "Bash" && /(^|\s)(grep|find|rg|fd)\b/.test(String(input?.command ?? "")));
  if (isDiscovery) {
    // additionalContext is surfaced to the model in Claude Code.
    console.log(JSON.stringify({
      additionalContext:
        "Tip: choose codelens by intent: cl_explore for unknown flows, cl_search to locate code, " +
        "cl_related/cl_impact for relationships or blast radius, then cl_expand for exact code. " +
        "Raw grep/read remain appropriate for known exact strings, logs, edits, and verification.",
    }));
  }
} catch { /* never break the agent on a hook error */ }
process.exit(0);