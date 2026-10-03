/**
 * The live transcript poller and body load only when the Transcript tab of a
 * live meeting opens. Walks the static import graph from the shell entries
 * and from the meeting canvas and asserts neither reaches them; the only way
 * in is the dynamic import in live-transcript-lazy.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..");

const LIVE_CODE = [
  resolve(here, "LiveTranscriptBody.svelte"),
  resolve(here, "live-transcript.svelte.ts"),
  resolve(here, "live-transcript-model.ts"),
];

function scriptOf(path: string): string {
  const text = readFileSync(path, "utf8");
  if (!path.endsWith(".svelte")) return text;
  return [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
}

/** Static, value-level relative imports (type-only imports are erased). */
function staticImports(path: string): string[] {
  const code = scriptOf(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*import\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    out.push(spec);
  }
  for (const m of code.matchAll(/^\s*export\s+(?!type\s)[\s\S]*?\sfrom\s+["'](\.[^"']+)["']/gm)) out.push(m[1]);
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
  for (const cand of [base, `${base}.ts`, `${base}.svelte`, `${base}.svelte.ts`, resolve(base, "index.ts")]) {
    if (existsSync(cand) && !cand.endsWith("/")) {
      try {
        readFileSync(cand);
        return cand;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function reachable(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticImports(file)) {
      const next = resolveSpec(file, spec);
      if (next) queue.push(next);
    }
  }
  return seen;
}

describe("live transcript stays off the initial JS graph", () => {
  it("is not statically reachable from the shell entries", () => {
    const graph = reachable([resolve(src, "index.ts"), resolve(src, "shell/DesktopApp.svelte")]);
    expect(graph.has(resolve(src, "shell/DesktopApp.svelte"))).toBe(true);
    expect(LIVE_CODE.filter((f) => graph.has(f))).toEqual([]);
  });

  it("is not statically reachable from the meeting canvas", () => {
    const graph = reachable([resolve(here, "MeetingCanvas.svelte")]);
    expect(graph.has(resolve(here, "LiveTranscriptDoor.svelte"))).toBe(true);
    expect(LIVE_CODE.filter((f) => graph.has(f))).toEqual([]);
  });

  it("loads the body through the memoized door", () => {
    const lazy = readFileSync(resolve(here, "live-transcript-lazy.ts"), "utf8");
    expect(lazy).toMatch(/import\("\.\/LiveTranscriptBody\.svelte"\)/);
    expect(staticImports(resolve(here, "LiveTranscriptDoor.svelte"))).toEqual(["./live-transcript-lazy"]);
  });
});
