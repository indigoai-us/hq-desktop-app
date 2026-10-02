/**
 * Static import walk for the console-rail lazy-chunk contract.
 *
 * Atlas and telemetry must stay off the shell boot path. A static `import`
 * or `export … from` from a shell entry (or anything that entry pulls in
 * statically) is a failure. `import()` is allowed: that is the lazy chunk.
 */

export interface SourceFile {
  path: string;
  content: string;
}

export interface StaticImportFinding {
  file: string;
  specifier: string;
  resolved: string;
  kind: "atlas" | "telemetry";
}

// `import type` / `export type` statements are erased at build time and add
// no runtime bytes, so they are not static bindings. Inline `{ type X }`
// specifiers inside a value import still count: the statement survives.
const STATIC_FROM =
  /\b(?:import|export)\s+(?!type[\s{*])(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["']/g;

const HEAVY = [
  { kind: "atlas" as const, needle: "/atlas/" },
  { kind: "telemetry" as const, needle: "/telemetry/" },
];

/** Specifiers that are real static bindings. `import()` is not in this set. */
export function staticSpecifiers(content: string): string[] {
  const withoutDynamic = content.replace(/\bimport\s*\(/g, "dynamic(");
  const specs: string[] = [];
  for (const match of withoutDynamic.matchAll(STATIC_FROM)) {
    specs.push(match[1]);
  }
  return specs;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return spec;
  const dir = fromFile.split("/").slice(0, -1).join("/");
  let next = normalize(`${dir}/${spec}`);
  next = next.replace(/\.(svelte|ts|js|mjs)$/, "");
  return next;
}

function heavyKind(resolved: string): "atlas" | "telemetry" | null {
  const path = resolved.startsWith("packages/ui/src")
    ? resolved
    : resolved.includes("packages/ui/src/")
      ? resolved.slice(resolved.indexOf("packages/ui/src/"))
      : `packages/ui/src/${resolved.replace(/^(\.\/|\.\.\/)+/, "")}`;
  const padded = `/${path}/`;
  for (const rule of HEAVY) {
    if (padded.includes(rule.needle)) return rule.kind;
  }
  return null;
}

/**
 * Walk static imports from `entries` through `files`.
 * `entries` are repo-relative paths that already exist in `files`.
 */
export function findStaticHeavyImports(
  files: SourceFile[],
  entries: string[],
): StaticImportFinding[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const index = new Map<string, string>();
  for (const file of files) {
    index.set(file.path.replace(/\.(svelte|ts|js|mjs)$/, ""), file.path);
  }

  const findings: StaticImportFinding[] = [];
  const seen = new Set<string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const file = byPath.get(current);
    if (!file) continue;

    for (const spec of staticSpecifiers(file.content)) {
      const resolved = resolveSpecifier(current, spec);
      if (!resolved) continue;
      const kind = heavyKind(resolved);
      const matchPath =
        index.get(resolved) ??
        index.get(resolved.replace(/\/index$/, "")) ??
        null;
      if (kind && (matchPath || resolved.includes(`/src/${kind}/`))) {
        findings.push({
          file: current,
          specifier: spec,
          resolved: matchPath ?? resolved,
          kind,
        });
      }
      if (matchPath && !seen.has(matchPath)) queue.push(matchPath);
    }
  }

  return findings;
}

/**
 * Every file reachable from `entries` through static imports only.
 * Used to prove a lazy body (reached through a door's `import()`) stays out
 * of the shell's initial graph.
 */
export function staticReachable(
  files: SourceFile[],
  entries: string[],
): Set<string> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const index = new Map<string, string>();
  for (const file of files) {
    index.set(file.path.replace(/\.(svelte|ts|js|mjs)$/, ""), file.path);
  }
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const file = byPath.get(current);
    if (!file) continue;
    for (const spec of staticSpecifiers(file.content)) {
      const resolved = resolveSpecifier(current, spec);
      if (!resolved) continue;
      const matchPath =
        index.get(resolved) ?? index.get(resolved.replace(/\/index$/, ""));
      if (matchPath && !seen.has(matchPath)) queue.push(matchPath);
    }
  }
  return seen;
}
