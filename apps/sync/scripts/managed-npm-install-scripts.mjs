#!/usr/bin/env node
// Regenerates apps/sync/src-tauri/src/commands/managed_npm_install_scripts.json,
// the list of packages with install scripts in each managed npm package's
// resolved dependency tree. `install_deps.rs` tests check that every one of
// them is covered by `managed_npm_allow_scripts`.
//
// It resolves each tree with npm's own Arborist (`buildIdealTree`), which
// reads registry metadata only: nothing is installed and no script runs.
//
// Usage:
//   node apps/sync/scripts/managed-npm-install-scripts.mjs [path/to/@npmcli/arborist] \
//     > apps/sync/src-tauri/src/commands/managed_npm_install_scripts.json
//
// Without an argument it uses the Arborist bundled with the `npm` on PATH.
// Keep the specs below in step with the managed installs in install_deps.rs.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SPECS = [
  '@anthropic-ai/claude-code',
  '@openai/codex',
  '@xai-official/grok',
  '@tobilu/qmd@2.5.3',
  '@indigoai-us/hq-cli',
  'pnpm@9',
]

const arboristPath =
  process.argv[2] ||
  join(
    execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
    'npm',
    'node_modules',
    '@npmcli',
    'arborist',
  )
const require = createRequire(join(arboristPath, 'package.json'))
const Arborist = require(arboristPath)
const arboristVersion = require(join(arboristPath, 'package.json')).version

const packages = {}
for (const spec of SPECS) {
  // realpath: on macOS /tmp is a symlink, and Arborist roots a symlinked
  // path at a link node with no children.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'managed-npm-scripts-')))
  try {
    const arb = new Arborist({ path: dir, ignoreScripts: true })
    const tree = await arb.buildIdealTree({ add: [spec] })
    const root = [...tree.children.values()][0]
    const withScripts = []
    for (const node of tree.inventory.values()) {
      if (node.isProjectRoot || node.inBundle || !node.hasInstallScript) {
        continue
      }
      withScripts.push({
        name: node.packageName,
        version: node.version,
        optional: node.optional,
      })
    }
    withScripts.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    packages[root.packageName] = {
      spec,
      version: root.version,
      install_scripts: withScripts,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

process.stdout.write(
  JSON.stringify(
    {
      generated_at: new Date().toISOString().slice(0, 10),
      generator: `apps/sync/scripts/managed-npm-install-scripts.mjs, @npmcli/arborist ${arboristVersion}`,
      packages,
    },
    null,
    2,
  ) + '\n',
)
