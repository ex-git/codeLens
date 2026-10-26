import { posix } from "node:path";
import { isInsideRepo, toPosix } from "../util/paths.js";
import { inferLanguage } from "../index/scanner.js";
import { isCodeLanguage } from "./grammars.js";
import type { ExtractedEdge } from "./edges.js";

/** Extract explicit Markdown references only. Never fetch URLs or infer concepts. */
export function extractDocEdges(path: string, source: string, repoRoot: string, knownFiles: Set<string>): ExtractedEdge[] {
  const lines = source.split("\n");
  const visible: Array<{ text: string; line: number }> = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; continue; }
    if (!fence) visible.push({ text, line: i + 1 });
  }
  const references = new Map<string, string>();
  const refKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  for (const { text } of visible) {
    const match = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/.exec(text);
    if (match) references.set(refKey(match[1]!), match[2] ?? match[3]!);
  }
  const result: ExtractedEdge[] = [], seen = new Set<string>();
  const add = (raw: string, line: number, mention: boolean) => {
    let destination: string;
    try { destination = toPosix(decodeURIComponent(raw.replace(/^<|>$/g, ""))); } catch { return; }
    if (!destination || /^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith("//") || [...destination].some(c => c.charCodeAt(0) < 32)) return;
    const hash = destination.indexOf("#");
    const fragment = hash >= 0 ? destination.slice(hash + 1) : "";
    const pathname = (hash >= 0 ? destination.slice(0, hash) : destination).split("?")[0]!;
    if (!pathname) return;
    const candidates = pathname.startsWith("/") ? [posix.normalize(pathname.slice(1))]
      : mention ? [posix.normalize(pathname), posix.normalize(posix.join(posix.dirname(path), pathname))]
        : [posix.normalize(posix.join(posix.dirname(path), pathname))];
    const matches = [...new Set(candidates)].filter(p => !p.startsWith("../") && knownFiles.has(p)
      && isCodeLanguage(inferLanguage(p)) && isInsideRepo(repoRoot, p));
    if (matches.length !== 1) return;
    const toPath = matches[0]!;
    const toSymbol = fragment && !/^L\d+(?:-L?\d+)?$/.test(fragment) ? fragment : null;
    const key = `${toPath}\0${toSymbol}\0${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ fromPath: path, toPath, fromSymbol: null, toSymbol, type: "documents", confidence: 0.9,
      sourceStartLine: line, sourceEndLine: line, method: "explicit-reference" });
  };
  for (const { text, line } of visible) {
    if (/^\s{0,3}\[[^\]]+\]:/.test(text)) continue;
    for (const match of text.matchAll(/(?<!!)\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) add(match[1] ?? match[2]!, line, false);
    for (const match of text.matchAll(/(?<!!)\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const target = references.get(refKey(match[2] || match[1]!));
      if (target) add(target, line, false);
    }
    for (const match of text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) add(match[1]!, line, true);
  }
  return result;
}
