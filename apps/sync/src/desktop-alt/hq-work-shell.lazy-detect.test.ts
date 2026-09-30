/**
 * The AI-tool probe (`detect_ai_tools` on the host) is expensive: shell
 * probes for claude/codex/grok plus stats of thousands of files under
 * ~/.claude / ~/.codex / ~/.grok. Running it on every app open froze the
 * desktop shell at boot (#1152). The fix is to remove the unconditional
 * mount-time probe from `HqWorkWorkShell.svelte` and expose an
 * `onrequestaitools` callback that the wizard/setup surfaces call when
 * they need the answer.
 *
 * This test locks the fix in at the source. `refreshInstallChoiceAiTools`
 * must NOT be invoked at the top level of the shell's <script> — only from
 * inside `requestInstallChoiceAiTools` (the lazy trigger) or the post-install
 * refresh hook.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_PATH = resolve(HERE, "./HqWorkWorkShell.svelte");

describe("HqWorkWorkShell · lazy AI-tool detection", () => {
  const source = readFileSync(SHELL_PATH, "utf8");
  // Isolate the <script> block so a doc example inside a comment can never
  // match. Svelte 5 keeps the same shape as v4 here (`<script lang="ts">`).
  const scriptStart = source.indexOf("<script");
  const scriptEnd = source.indexOf("</script>");
  const script = source.slice(scriptStart, scriptEnd);

  it("does not call refreshInstallChoiceAiTools at the top level of the shell script", () => {
    // A top-level `void refreshInstallChoiceAiTools();` or
    // `await refreshInstallChoiceAiTools();` is the exact regression that
    // #1152 fixed off the main thread — but calling it on every mount
    // still fires the probe on every app open, which is what we're
    // preventing. The lazy path (`requestInstallChoiceAiTools`) and the
    // post-install re-check inside `onassistedinstall` are the only
    // permitted call sites; they don't sit at column 0 of a line.
    const lines = script.split("\n");
    const topLevelCall = lines.find((line) =>
      /^\s{0,2}(await\s+|void\s+)?refreshInstallChoiceAiTools\s*\(/.test(line),
    );
    expect(
      topLevelCall,
      `Found a top-level refreshInstallChoiceAiTools() call: ${topLevelCall}`,
    ).toBeUndefined();
  });

  it("exposes a lazy trigger and wires it to WorkShell as onrequestaitools", () => {
    expect(script).toMatch(/function\s+requestInstallChoiceAiTools\s*\(/);
    expect(source).toMatch(/onrequestaitools=\{requestInstallChoiceAiTools\}/);
  });

  it("keeps the post-install re-check so the panel refreshes after the installer lands", () => {
    // Guard against a naive fix that removed the boot probe AND the
    // installer-success re-check together — the panel would then stay on
    // the pre-install reading forever until the user clicked Check again.
    expect(source).toMatch(
      /if\s*\(\s*outcome\.ok\s*\)\s*await\s+refreshInstallChoiceAiTools\s*\(\s*\)/,
    );
  });
});
