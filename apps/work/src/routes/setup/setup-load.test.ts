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
  };

  afterEach(() => {
    process.env.COGNITO_TEST_JWKS = saved.jwks;
    process.env.VERCEL = saved.vercel;
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
    try {
      await load(event("/setup", { sub: "person-test" }));
      throw new Error("expected redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      if (isRedirect(err)) expect(err.location).toBe("/");
    }
  });
});
