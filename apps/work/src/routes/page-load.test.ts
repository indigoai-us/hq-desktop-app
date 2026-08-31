import { isRedirect } from "@sveltejs/kit";
import { describe, expect, it } from "vitest";

import { load } from "./+page.server";

function event(session: { sub: string } | null) {
  return {
    locals: { session },
  } as unknown as Parameters<typeof load>[0];
}

describe("root load", () => {
  it("sends signed-out visitors to sign-in", async () => {
    try {
      await load(event(null));
      throw new Error("expected redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      if (isRedirect(err)) expect(err.location).toBe("/auth/signin");
    }
  });

  it("does not gate signed-in users on the local work-mesh cache", async () => {
    const data = await load(event({ sub: "person-test" }));
    expect(data).toEqual({});
    expect(data).not.toHaveProperty("overlay");
  });
});
