/**
 * Every `invoke` the Sync PlatformAdapter makes must supply the arguments the
 * registered Rust command actually requires.
 *
 * Tauri deserializes command arguments before the handler runs, so a missing
 * or misnamed key is not a soft failure — the call is rejected outright and
 * the feature is dead with no compiler, linter, or type-level complaint. The
 * adapter is plain `invoke(name, bag)`, so nothing else in the build checks
 * this seam.
 *
 * It had already drifted on 18 call sites across Marketplace, Projects,
 * Library, Agency, conflict restore, terminal launch, and CLI updates —
 * mostly snake_case Rust parameters (`company_slug`, `prd_path`) whose
 * camelCase JS names (`companySlug`, `prdPath`) the adapter shortened to
 * `slug` / `path`, plus a few commands handed an opaque payload bag where
 * Rust wanted flat named fields.
 *
 * The check reads both sides from source: the `generate_handler!` list in
 * `main.rs` for what is registered, the `#[tauri::command]` signatures for
 * what each one needs, and the adapter for what it sends.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());
const rustRoot = resolve(repoRoot, 'src-tauri/src');

/** Rust parameters supplied by Tauri itself, never by the caller. */
const INJECTED_TYPES = [
  'AppHandle',
  'State<',
  'Window',
  'WebviewWindow',
  'tauri::',
  'Runtime',
];

function rustSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...rustSources(full));
    else if (entry.endsWith('.rs')) out.push(full);
  }
  return out;
}

/** `generate_handler![…]` with balanced brackets — a lazy `.*?` stops early. */
function registeredCommands(): Set<string> {
  const main = readFileSync(join(rustRoot, 'main.rs'), 'utf8');
  const marker = 'generate_handler![';
  const start = main.indexOf(marker) + marker.length;
  let depth = 1;
  let i = start;
  while (depth > 0 && i < main.length) {
    if (main[i] === '[') depth += 1;
    else if (main[i] === ']') depth -= 1;
    i += 1;
  }
  return new Set(
    main
      .slice(start, i - 1)
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter((line) => line && !line.startsWith('//'))
      .map((line) => line.split('::').pop() as string),
  );
}

/** Split a parameter list on top-level commas so generics stay intact. */
function splitParams(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of `${params},`) {
    if ('<(['.includes(ch)) depth += 1;
    else if ('>)]'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  return out;
}

function snakeToCamel(name: string): string {
  const [head, ...rest] = name.split('_');
  return head + rest.map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

/** Command name → required caller-supplied argument names, camelCased. */
function requiredArgs(): Map<string, string[]> {
  const registered = registeredCommands();
  const out = new Map<string, string[]>();
  const signature =
    /#\[tauri::command\][^\n]*\n(?:\s*#\[[^\n]*\]\n)*\s*pub (?:async )?fn (\w+)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g;
  for (const file of rustSources(rustRoot)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(signature)) {
      const [, name, params] = m;
      if (!registered.has(name)) continue;
      const required = splitParams(params)
        .filter((p) => p.includes(':'))
        .map((p) => {
          const [pn, ...rest] = p.split(':');
          return { name: pn.trim(), type: rest.join(':') };
        })
        .filter(({ type }) => !INJECTED_TYPES.some((t) => type.includes(t)))
        .filter(({ type }) => !type.includes('Option<'))
        .map(({ name: pn }) => snakeToCamel(pn));
      out.set(name, required);
    }
  }
  return out;
}

interface CallSite {
  line: number;
  command: string;
  keys: Set<string>;
}

function adapterCallSites(): CallSite[] {
  const src = readFileSync(
    resolve(repoRoot, '../../packages/platform/src/tauri/sync-adapter.ts'),
    'utf8',
  );
  const invoke =
    /call(?:<[^>]*>)?\(\s*'([a-z0-9_]+)'\s*(?:,\s*(\{(?:[^{}]|\{[^{}]*\})*\}))?\s*\)/g;
  const out: CallSite[] = [];
  for (const m of src.matchAll(invoke)) {
    const args = m[2] ?? '';
    out.push({
      line: src.slice(0, m.index).split('\n').length,
      command: m[1],
      keys: new Set(
        [...args.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*(?=[,:}])/g)].map(
          (k) => k[1],
        ),
      ),
    });
  }
  return out;
}

describe('Sync adapter invokes match the registered command signatures', () => {
  const required = requiredArgs();
  const sites = adapterCallSites();

  it('parses both sides (guards the parser itself)', () => {
    expect(required.size).toBeGreaterThan(100);
    expect(sites.length).toBeGreaterThan(50);
    // A known snake_case command, to prove the camelCase mapping is applied.
    expect(required.get('get_local_company_goals')).toEqual(['companySlug']);
    expect(required.get('set_local_story_passes')).toEqual([
      'prdPath',
      'storyId',
      'passes',
    ]);
    // At least some call sites resolve against a real signature, or the
    // assertion below would pass vacuously.
    expect(sites.filter((s) => required.has(s.command)).length).toBeGreaterThan(
      30,
    );
  });

  it('supplies every required argument', () => {
    const broken = sites
      .filter((s) => required.has(s.command))
      .map((s) => ({
        ...s,
        missing: (required.get(s.command) as string[]).filter(
          (arg) => !s.keys.has(arg),
        ),
      }))
      .filter((s) => s.missing.length > 0)
      .map(
        (s) =>
          `hq-work-adapter.ts:${s.line} invoke('${s.command}') is missing ${s.missing.join(', ')} (sends: ${[...s.keys].join(', ') || 'nothing'})`,
      );
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('only invokes commands registered by the desktop host', () => {
    const registered = registeredCommands();
    const broken = sites
      .filter((site) => !registered.has(site.command))
      .map(
        (site) =>
          `hq-work-adapter.ts:${site.line} invokes unregistered command '${site.command}'`,
      );
    expect(broken, broken.join('\n')).toEqual([]);
  });
});
