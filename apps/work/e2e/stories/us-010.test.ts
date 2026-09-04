/**
 * US-010 story acceptance test (from the PRD e2eTests):
 *
 *   "Given the web app, when a user opens a screen containing desktop-only
 *    actions, then those actions show the designed unavailable state and
 *    cloud-backed content still renders."
 *
 * US-010 ports the remaining wave-3 screens into platform-pure packages/ui,
 * wired into apps/web routes through the PlatformAdapter seam. The rendered
 * contract this proves — matching AC#3 ("Desktop-only capabilities render the
 * standard unavailable/degraded state on web via capability flags — no dead
 * buttons, no errors") — is that a ported screen's desktop-only affordances
 * are driven by REAL capability flags (absent/degraded on web, present on
 * desktop) while the screen's own content chrome still renders on web.
 *
 * Uses Svelte 5 server-side render (svelte/server) through the
 * @sveltejs/vite-plugin-svelte compile step in vitest.config.ts — the same
 * minimal render harness the US-008 rendered-contract test uses (no jsdom, no
 * client runtime). The adapters are the REAL WebPlatformAdapter /
 * TauriPlatformAdapter (constructor-injected, no runtime deps), so the gate
 * under test is production capability wiring, not a test double.
 *
 * Runs under `pnpm test` via apps/web/vitest.config.ts (Playwright's smoke
 * project ignores e2e/stories).
 */

import { describe, expect, it } from "vitest";
import { render } from "svelte/server";

import { WebPlatformAdapter, TauriPlatformAdapter } from "@hq/platform";
// Real ported wave-3 components (deep imports — the @hq/ui root entry pulls in
// the full barrel; the render harness only needs these two files).
import FilePreviewPane from "../../../../packages/ui/src/files/FilePreviewPane.svelte";
import UnavailableNote from "../../../../packages/ui/src/common/UnavailableNote.svelte";

// A desktop `invoke` that is never called during server render — capability
// flags are static, and the async data-loading effects do not run SSR-side.
const noopInvoke = async () => {
  throw new Error("invoke must not run during server render");
};

describe("US-010: wave-3 web port — desktop-only actions degrade, screen still renders", () => {
  const path = "companies/indigo/projects/hq-app-v2-web-first/prd.json";

  it("web: the file-preview screen renders its content chrome but gates the desktop-only Finder action (no dead button)", () => {
    const adapter = new WebPlatformAdapter({ baseUrl: "https://hqapi.test" });
    const { body } = render(FilePreviewPane, { props: { adapter, path } });

    // The ported screen renders on web — its content chrome is present, not a
    // dead/errored pane.
    expect(body).toContain('data-testid="file-preview-pane"');
    expect(body).toContain('data-testid="file-preview-meta"');
    expect(body).toContain(path);
    // Cross-platform affordance still there.
    expect(body).toContain('data-testid="copy-path"');

    // Desktop-only affordance (localFiles capability) is absent on web — never
    // rendered as a dead button.
    expect(adapter.isAvailable("localFiles")).toBe(false);
    expect(adapter.isAvailable("canLaunchApps")).toBe(false);
    expect(body).not.toContain('data-testid="reveal-in-finder"');
  });

  it("desktop: the same capability gate reveals the desktop-only Finder action (the gate is real, capability-driven)", () => {
    const adapter = new TauriPlatformAdapter({ invoke: noopInvoke });
    const { body } = render(FilePreviewPane, { props: { adapter, path } });

    // Same screen, same content chrome.
    expect(body).toContain('data-testid="file-preview-pane"');
    expect(body).toContain('data-testid="copy-path"');

    // On desktop the localFiles capability is present, so the Finder action
    // renders — proving the web absence above is a genuine capability gate,
    // not an unconditional omission.
    expect(adapter.isAvailable("localFiles")).toBe(true);
    expect(body).toContain('data-testid="reveal-in-finder"');
  });

  it("web: the designed unavailable state renders as the standard degraded primitive (role=status, labelled, non-error)", () => {
    // The shared degraded state the ported files/settings/deployments screens
    // render on web via capability flags (never a thrown error).
    const { body } = render(UnavailableNote, {
      props: {
        label: "File browsing",
        message:
          "Your HQ folder is browsable in the desktop app; a web files API is on the way.",
        testid: "files-unavailable",
      },
    });

    expect(body).toContain('data-testid="files-unavailable"');
    expect(body).toContain('role="status"');
    expect(body).toContain("File browsing");
    expect(body).toContain("web files API is on the way");
  });
});
