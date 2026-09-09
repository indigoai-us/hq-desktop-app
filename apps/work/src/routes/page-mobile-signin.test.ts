import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The root route is where a phone's session actually gets attached.
 *
 * Every piece of the flow is unit-tested on its own (mobile-auth,
 * mobile-auth-host, mobile-sign-in). What those tests cannot see is whether
 * the route wires them to WorkShell — and the failure mode of not doing so is
 * silent: the shell renders, every hq-pro call 401s, and the sidebar says
 * "Couldn't load conversations." with nothing wrong in any log.
 */

const route = readFileSync(
  fileURLToPath(new URL("./+page.svelte", import.meta.url)),
  "utf8",
);

/**
 * The same source with comments stripped. The comments deliberately NAME the
 * route that must not be navigated to, so a naive search over the whole file
 * matches the prose explaining its absence and reports the opposite.
 */
const code = route
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the root route's mobile branch", () => {
  it("is one file for all three targets", () => {
    // packages/ui and apps/work share ONE Svelte source; a `+page.mobile.svelte`
    // is the drift this repo's single-source guard exists to prevent.
    expect(route).toContain("resolveHostPlatform()");
    expect(route).toMatch(/platform === "ios" \|\| platform === "android"/);
  });

  it("gives the phone an authorised hq-pro transport", () => {
    // Without this the shell falls back to the browser token provider, which
    // reads /api/auth/token — a server route a static bundle does not ship.
    expect(route).toContain("mobileTokenProvider(session)");
    expect(route).toContain("fetch={mobile.fetch}");
  });

  it("never navigates a static bundle to the server sign-in route", () => {
    // redirectToSigninWithCallback() is createHqProFetch's default. On a phone
    // it navigates to /auth/signin, which resolves to SvelteKit's 404 page.
    expect(code).toContain("onUnauthorized");
    expect(code).not.toContain("/auth/signin");
  });

  it("distinguishes 'still checking' from 'signed out'", () => {
    // Restoring a stored refresh token is a network round trip. Rendering the
    // sign-in button during it asks a signed-in user to sign in again.
    expect(route).toContain('signInState === "signed-in"');
    expect(route).toContain('signInState === "checking"');
  });

  it("listens for the deep-link callback", () => {
    expect(route).toContain("listenForAuthCallback");
    expect(route).toContain("flow.handleCallback(url)");
  });

  it("leaves the web and desktop path exactly as it was", () => {
    expect(route).toContain(
      "<WorkShell {data} apiUrl={env.PUBLIC_HQ_PRO_API_URL} />",
    );
  });
});
