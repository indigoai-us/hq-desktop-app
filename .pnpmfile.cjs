"use strict";

/**
 * US-101: if a linked @hq/{ui,platform,core} package still lists workspace:*
 * deps, rewrite them to sibling file: paths so pnpm can install the graph
 * outside hq-work-mono. Source packages already use file:../; this is a
 * safety net. See apps/sync/docs/hq-work-ui-consume.md.
 */

const HQ_PACKAGES = {
  "@hq/ui": "ui",
  "@hq/platform": "platform",
  "@hq/core": "core",
};

function rewriteWorkspaceToFile(block) {
  if (!block || typeof block !== "object") return;
  for (const [name, spec] of Object.entries(block)) {
    const dir = HQ_PACKAGES[name];
    if (!dir) continue;
    const value = String(spec);
    if (value !== "workspace:*" && !value.startsWith("workspace:")) continue;
    block[name] = `file:../${dir}`;
  }
}

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (!HQ_PACKAGES[pkg.name]) return pkg;
      rewriteWorkspaceToFile(pkg.dependencies);
      rewriteWorkspaceToFile(pkg.devDependencies);
      rewriteWorkspaceToFile(pkg.optionalDependencies);
      rewriteWorkspaceToFile(pkg.peerDependencies);
      return pkg;
    },
  },
};
