/**
 * Snippet + dedent helpers for agent-facing output.
 *
 * Best practice for agent-consumable tool output: compact, minimal redundant
 * whitespace, relative code structure preserved. `dedent` strips the COMMON
 * leading whitespace across non-blank lines so a deeply-nested function body
 * isn't padded by its base indent — lossless for understanding, fewer tokens.
 */

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "is", "on"]);

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_]+/i).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Strip the common leading whitespace from non-blank lines (Python-style dedent). */
export function dedent(text: string): string {
  const lines = text.split("\n");
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue; // ignore blank lines
    const indent = line.match(/^[ \t]*/)?.[0]?.length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return text;
  return lines.map((l) => (l.length >= minIndent ? l.slice(minIndent) : l)).join("\n");
}

/** Extract a windowed snippet around the first matched term, highlight, dedent. */
export function extractSnippet(content: string, query: string, maxChars = 1500): string {
  const terms = tokenize(query);
  let snippet: string;
  if (terms.length === 0) {
    snippet = content.length > maxChars ? content.slice(0, maxChars) + "\n…" : content;
  } else {
    const lower = content.toLowerCase();
    let bestIdx = -1;
    for (const t of terms) {
      const idx = lower.indexOf(t);
      if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
    }
    if (bestIdx === -1) {
      snippet = content.length > maxChars ? content.slice(0, maxChars) + "\n…" : content;
    } else {
      const half = Math.floor(maxChars / 2);
      const start = Math.max(0, bestIdx - half);
      const end = Math.min(content.length, start + maxChars);
      let s = content.slice(start, end);
      if (start > 0) s = "…" + s;
      if (end < content.length) s = s + "\n…";
      snippet = s;
    }
  }
  snippet = dedent(snippet);
  // Highlight matched terms (on the dedented text).
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
    snippet = snippet.replace(re, "**$1**");
  }
  return snippet;
}