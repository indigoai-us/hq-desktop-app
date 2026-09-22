import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The browser preview harness (`npm run dev:preview`) is not covered by the
// Tauri build or by svelte-check's project graph, so a page deleted from
// src/ leaves a dangling import here that only shows up as a blank preview
// at runtime. PR #826 removed the desktop-alt pages/ tree and the harness
// kept importing SettingsPage/HomePage/CompanyPage/SessionsPage for months.
// This test fails the moment a harness import path stops resolving.
const harnessDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dev-harness');
const IMPORT_RE = /from\s+'(\.[^']+)'/g;
const SUFFIXES = ['', '.ts', '.js', '.svelte', '/index.ts'];

const harnessFiles = readdirSync(harnessDir, { recursive: true, encoding: 'utf8' }).filter(
  (f) => f.endsWith('.svelte') || f.endsWith('.ts'),
);

describe('dev-harness imports', () => {
  it('finds harness source files to check', () => {
    expect(harnessFiles.length).toBeGreaterThan(0);
  });

  it.each(harnessFiles)('%s imports only paths that exist', (file) => {
    const abs = resolve(harnessDir, file);
    const source = readFileSync(abs, 'utf8');
    const missing = [...source.matchAll(IMPORT_RE)]
      .map((m) => m[1])
      .filter((spec) => !SUFFIXES.some((s) => existsSync(resolve(dirname(abs), spec + s))));
    expect(missing).toEqual([]);
  });
});
