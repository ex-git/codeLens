export interface QueryTokenOptions {
  minLength?: number;
  stopwords?: ReadonlySet<string>;
}

const DEFAULT_MIN_LENGTH = 1;
const QUERY_TOKEN_RE = /[^A-Za-z0-9_]+/i;

export function queryTokens(query: string, opts: QueryTokenOptions = {}): string[] {
  const minLength = opts.minLength ?? DEFAULT_MIN_LENGTH;
  const stopwords = opts.stopwords;
  return query
    .split(QUERY_TOKEN_RE)
    .filter((term) => term.length >= minLength && !stopwords?.has(term.toLowerCase()));
}

export function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, "\"\"")}"`;
}
