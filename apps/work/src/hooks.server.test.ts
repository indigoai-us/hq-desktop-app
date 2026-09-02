import { describe, expect, it, vi } from "vitest";

const restoreSession = vi.hoisted(() => vi.fn());

vi.mock("$lib/server/auth", () => ({
  authConfig: vi.fn(() => ({})),
}));
vi.mock("$lib/server/local-dev-session", () => ({
  localDevSession: vi.fn(() => null),
}));
vi.mock("$lib/server/session-cookies", () => ({ restoreSession }));

import { handle } from "./hooks.server";

const LEGACY_PATHS = [
  "/chat",
  "/board",
  "/projects",
  "/marketplace",
  "/library",
  "/files",
  "/meetings",
  "/deployments",
  "/settings",
];

function event(path: string) {
  return {
    url: new URL(`https://work.hq.computer${path}`),
    cookies: {},
    fetch: vi.fn(),
    locals: {},
  };
}

async function call(path: string) {
  const resolve = vi.fn(async () => new Response("shell"));
  const response = await handle({ event: event(path), resolve } as never);
  return { response, resolve };
}

describe("hosted-web session hook", () => {
  it("passes a root deep link to sign-in as an encoded callback URL", async () => {
    restoreSession.mockResolvedValueOnce(null);
    const { response } = await call("/?channel=engineering&reply=thread-42");

    expect(response.status).toBe(303);
    const redirect = new URL(
      response.headers.get("location")!,
      "https://work.hq.computer",
    );
    expect(redirect.pathname).toBe("/auth/signin");
    expect(redirect.searchParams.get("callbackUrl")).toBe(
      "/?channel=engineering&reply=thread-42",
    );
  });

  it.each(LEGACY_PATHS)("redirects authenticated legacy path %s to the root shell", async (path) => {
    restoreSession.mockResolvedValueOnce({ sub: "person-1" });
    const { response, resolve } = await call(`${path}?channel=engineering`);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/?channel=engineering");
    expect(resolve).not.toHaveBeenCalled();
  });
});
