/**
 * Shiki code highlighting for the code-walkthrough structured layout.
 *
 * One lazily-created singleton highlighter, preloaded with a fixed language +
 * theme set and the JS regex engine (no WASM — browser-friendly, deterministic).
 * `highlightCode` returns ready-to-render token HTML; components show plain
 * `<pre>` until it resolves. Highlighting is deterministic and NEVER
 * model-generated — the agent only supplies `{ language, code }`.
 */

import { createHighlighter, createJavaScriptRegexEngine, type Highlighter } from "shiki";

/** Languages we preload. Anything else falls back to plain text. */
export const CODE_LANGS = [
  "python",
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "cpp",
  "java",
  "go",
  "rust",
  "bash",
  "json",
  "sql",
] as const;

export const CODE_THEME = "github-dark-default";

const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  "c++": "cpp",
  cxx: "cpp",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  golang: "go",
  rs: "rust",
};

/** Map a user/AI language id to a preloaded Shiki lang, or "text". */
export function normalizeLang(lang: string | undefined): string {
  const l = (lang ?? "").toLowerCase().trim();
  if ((CODE_LANGS as readonly string[]).includes(l)) return l;
  return ALIASES[l] ?? "text";
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [CODE_THEME],
      langs: [...CODE_LANGS],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

/** Highlight code → Shiki token HTML (a `<pre class="shiki">…</pre>` string).
 *  Falls back to plain text on any error. */
export async function highlightCode(code: string, lang: string | undefined): Promise<string> {
  const hl = await getHighlighter();
  const language = normalizeLang(lang);
  try {
    return hl.codeToHtml(code, { lang: language, theme: CODE_THEME });
  } catch {
    return hl.codeToHtml(code, { lang: "text", theme: CODE_THEME });
  }
}
