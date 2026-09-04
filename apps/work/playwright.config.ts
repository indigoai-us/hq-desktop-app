import { defineConfig, devices } from "@playwright/test";

import {
  TEST_CLIENT_ID,
  TEST_ISSUER,
  TEST_JWKS,
} from "./e2e/fixtures/test-jwks";

// Two projects:
// - "smoke": browser E2E against the built app (needs the preview server).
// - "canary": network-only guard for the V1 updater stream (no server, no
//   browser page — uses Playwright's request fixture only).
//
// Set PW_NO_SERVER=1 to skip starting the preview server (used by the canary
// workflow, which never touches the app).
//
// Auth in E2E (US-006): the preview server runs with COGNITO_TEST_JWKS (a
// committed test-only public key) so tests can mint RS256 id_tokens with the
// matching private key and inject them as the session cookie. The server
// ignores COGNITO_TEST_JWKS when VERCEL_ENV === "production", so this never
// weakens the deployed app. No real Cognito is needed in CI.
const noServer = !!process.env.PW_NO_SERVER;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "smoke",
      testDir: "e2e",
      // stories/ holds vitest story acceptance tests (run by `pnpm test`),
      // not Playwright specs.
      testIgnore: ["**/e2e/canary/**", "**/e2e/stories/**"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "canary",
      testDir: "e2e/canary",
    },
  ],
  webServer: noServer
    ? undefined
    : {
        command: "pnpm build && pnpm preview --port 4173 --strictPort",
        port: 4173,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          COGNITO_ISSUER: TEST_ISSUER,
          COGNITO_CLIENT_ID: TEST_CLIENT_ID,
          COGNITO_TEST_JWKS: TEST_JWKS,
          // Hosted UI domain + app origin configured so the branded
          // /auth/signin deep-link (?idp=Google) can build and 302 to the
          // Cognito authorize URL. The no-idp branded page never auto-redirects
          // off-origin, so configuring these no longer bounces plain visits.
          COGNITO_HOSTED_UI_DOMAIN:
            "vault-test.auth.us-east-1.amazoncognito.com",
          PUBLIC_APP_ORIGIN: "http://localhost:4173",
          PUBLIC_HQ_PRO_API_URL: "https://hqapi.example.test",
          // Isolate E2E from the developer's real ~/.hq/work-mesh/cache so
          // the empty/"No data" path is what the suite asserts.
          HQ_WORK_MESH_CACHE: "off",
          // /setup always redirects to the shell (no local install card).
          HQ_WORK_MESH_SKIP_SETUP: "1",
        },
      },
});
