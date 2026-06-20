export interface IdentifierSplitOptions {
  minTokenLength?: number;
  maxTokens?: number;
}

const DEFAULT_MIN_TOKEN_LENGTH = 3;
const DEFAULT_MAX_TOKENS = 128;
const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Extract bounded identifier subtokens from code-ish text.
 *
 * Only identifiers that actually benefit from splitting (camel/Pascal case,
 * snake_case, ALL_CAPS_WITH_UNDERSCORES) contribute subtokens. Tokens are
 * lowercased, deduped in first-seen order, short tokens are skipped, and output
 * is capped so synthetic terms cannot dominate BM25.
 */
export function splitIdentifiers(text: string, opts: IdentifierSplitOptions = {}): string[] {
  const minLength = opts.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(IDENTIFIER_RE)) {
    const raw = match[0];
    const parts = identifierParts(raw);
    if (parts.length <= 1) continue;
    for (const part of parts) {
      const token = part.toLowerCase();
      if (token.length < minLength || /^\d+$/.test(token) || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
      if (out.length >= maxTokens) return out;
    }
  }
  return out;
}

/** Preserve original content and append bounded subtokens to match-only FTS text. */
export function withIdentifierSubtokens(content: string, opts: IdentifierSplitOptions = {}): string {
  const subtokens = splitIdentifiers(content, opts);
  return subtokens.length === 0 ? content : `${content}\n${subtokens.join(" ")}`;
}

function identifierParts(raw: string): string[] {
  const underscoreParts = raw.split(/_+/).filter((part) => part.length > 0);
  if (underscoreParts.length > 1) return underscoreParts.flatMap(splitCaseBoundaries);
  return splitCaseBoundaries(raw);
}

function splitCaseBoundaries(raw: string): string[] {
  return raw
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0);
}
