import { isRedirect } from "@sveltejs/kit";
import { afterEach, describe, expect, it } from "vitest";

import { load } from "./+page.server";

function event(path: string, session: { sub: string } | null) {
  return {
    locals: { session },
    cookies: { get: () => undefined },
    url: new URL(`http://localhost:5173${path}`),
  } as unknown as Parameters<typeof load>[0];
}

describe("/setup load", () => {
  const saved = {
    jwks: process.env.COGNITO_TEST_JWKS,
    vercel: process.env.VERCEL,
    skip: process.env.HQ_WORK_MESH_SKIP_SETUP,
    force: process.env.HQ_WORK_MESH_FORCE_SETUP,
  };

  afterEach(() => {
    process.env.COGNITO_TEST_JWKS = saved.jwks;
    process.env.VERCEL = saved.vercel;
    process.env.HQ_WORK_MESH_SKIP_SETUP = saved.skip;
    process.env.HQ_WORK_MESH_FORCE_SETUP = saved.force;
  });

  it("sends signed-out visitors to sign-in", async () => {
    try {
      await load(event("/setup", null));
      throw new Error("expected redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      if (isRedirect(err)) expect(err.location).toBe("/auth/signin");
    }
  });

  it("preview=1 also bounces — web cannot run local install/CLI setup", async () => {
    process.env.COGNITO_TEST_JWKS = "{}";
    try {
      await load(event("/setup?preview=1", { sub: "person-test" }));
      throw new Error("expected redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      if (isRedirect(err)) expect(err.location).toBe("/");
    }
  });

  it("bounces every signed-in session to the shell (no local-cache gate)", async () => {
    process.env.COGNITO_TEST_JWKS = "{}";
    process.env.HQ_WORK_MESH_FORCE_SETUP = "1";
    try {
      await load(event("/setup", { sub: "person-test" }));
      throw new Error("expected redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      if (isRedirect(err)) expect(err.location).toBe("/");
    }
  });
});
