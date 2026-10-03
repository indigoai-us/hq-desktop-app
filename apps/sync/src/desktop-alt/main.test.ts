import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const main = readFileSync(
  fileURLToPath(new URL("./main.ts", import.meta.url)),
  "utf8",
);

describe("desktop-alt embedded Work bundle boundary", () => {
  it("keeps the workspace shell code-split behind mountHqWork", () => {
    const mountHqWork = main.match(
      /mountHqWork:\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n  \},\n\}\)/,
    );
    const dynamicImports =
      main.match(/import\(\s*["']\.\/HqWorkWorkShell\.svelte["']\s*\)/g) ?? [];

    expect(
      main,
      "Regression: HqWorkWorkShell must not be statically imported at module top level.",
    ).not.toMatch(
      /^\s*import(?:\s+[^"']+?\s+from)?\s*["']\.\/HqWorkWorkShell\.svelte["'];?\s*$/m,
    );
    expect(
      dynamicImports,
      "Regression: HqWorkWorkShell must remain a single dynamic import.",
    ).toHaveLength(1);
    expect(
      mountHqWork?.[1],
      "Regression: the workspace shell dynamic import must be reached from mountHqWork.",
    ).toContain("import('./HqWorkWorkShell.svelte')");
    expect(main).not.toMatch(/getHqWorkHandoff|mountLegacy|getHandoff|DesktopApp/);
  });

  it("wires fixed startup milestones before the work they diagnose", () => {
    const entry = main.indexOf("startupDiagnostics.emit('entry-started')");
    const listeners = main.indexOf('installGlobalErrorListeners(window)');
    const boot = main.indexOf('bootDesktopAltWindow({');
    const importStarted = main.indexOf("startupDiagnostics.emit('dynamic-import-started')");
    const dynamicImport = main.indexOf("import('./HqWorkWorkShell.svelte')");
    const importCompleted = main.indexOf("startupDiagnostics.emit('dynamic-import-completed')");
    const mountStarted = main.indexOf("startupDiagnostics.emit('mount-started')");
    const mountCall = main.indexOf('mount(GlobalErrorBoundary');
    const mountCompleted = main.indexOf("startupDiagnostics.emit('mount-completed')");

    expect(entry).toBeGreaterThan(-1);
    expect(entry).toBeLessThan(listeners);
    expect(listeners).toBeLessThan(boot);
    expect(importStarted).toBeLessThan(dynamicImport);
    expect(dynamicImport).toBeLessThan(importCompleted);
    expect(importCompleted).toBeLessThan(mountStarted);
    expect(mountStarted).toBeLessThan(mountCall);
    expect(mountCall).toBeLessThan(mountCompleted);
    expect(main).toContain("onStartupBoundaryError: () => startupDiagnostics.emit('boundary-error')");
    expect(main).toContain("startupDiagnostics.emit('boot-failed')");
  });
});
