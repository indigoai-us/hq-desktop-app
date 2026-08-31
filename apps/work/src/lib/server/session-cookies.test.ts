import { describe, expect, it, vi } from "vitest";

import {
  ID_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  type AuthConfig,
  type Session,
} from "@hq/auth";

import {
  REFRESH_TOKEN_MAX_AGE_SEC,
  clearSessionCookies,
  restoreSession,
  writeSessionCookies,
  type SessionCookieJar,
} from "./session-cookies";

const NOW = 1_800_000_000_000;

const config: AuthConfig = {
  clientId: "client-123",
  hostedUiDomain: "vault-test.auth.us-east-1.amazoncognito.com",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL",
  appOrigin: "https://work.hq.computer",
};

const liveSession: Session = {
  sub: "user-abc",
  email: "person@example.com",
  name: "Person",
  expiresAt: NOW + 3_600_000,
};

function makeJar(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const set: {
    name: string;
    value: string;
    maxAge?: number;
    secure?: boolean;
  }[] = [];
  const deleted: string[] = [];
  const jar: SessionCookieJar = {
    get: (name) => store.get(name),
    set: (name, value, opts) => {
      store.set(name, value);
      set.push({
        name,
        value,
        maxAge: opts.maxAge,
        secure: opts.secure,
      });
    },
    delete: (name) => {
      store.delete(name);
      deleted.push(name);
    },
  };
  return { jar, set, deleted, store };
}

describe("writeSessionCookies", () => {
  it("pins hq_id_token to remaining JWT life and hq_refresh_token to 30 days", () => {
    const { jar, set } = makeJar();
    writeSessionCookies(jar, {
      idToken: "id.jwt",
      refreshToken: "rt-1",
      session: liveSession,
      secure: true,
      now: NOW,
    });
    expect(set).toEqual([
      { name: ID_TOKEN_COOKIE, value: "id.jwt", maxAge: 3600, secure: true },
      {
        name: REFRESH_TOKEN_COOKIE,
        value: "rt-1",
        maxAge: REFRESH_TOKEN_MAX_AGE_SEC,
        secure: true,
      },
    ]);
  });

  it("drops Secure over http and skips a missing refresh token", () => {
    const { jar, set } = makeJar();
    writeSessionCookies(jar, {
      idToken: "id.jwt",
      session: liveSession,
      secure: false,
      now: NOW,
    });
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({
      name: ID_TOKEN_COOKIE,
      secure: false,
      maxAge: 3600,
    });
  });
});

describe("restoreSession", () => {
  const fetchStub = vi.fn() as unknown as typeof fetch;

  it("returns a still-valid id_token session without calling refresh", async () => {
    const { jar, set } = makeJar({ [ID_TOKEN_COOKIE]: "live.id" });
    const verify = vi.fn(async () => liveSession);
    const refresh = vi.fn();
    const session = await restoreSession(jar, {
      secure: true,
      fetch: fetchStub,
      config,
      now: NOW,
      verify,
      refresh,
    });
    expect(session).toEqual(liveSession);
    expect(refresh).not.toHaveBeenCalled();
    expect(set).toHaveLength(0);
  });

  it("refreshes when the id_token is missing and a refresh cookie is present", async () => {
    const { jar, set } = makeJar({ [REFRESH_TOKEN_COOKIE]: "rt-old" });
    const verify = vi.fn(async (_c, token: string) =>
      token === "fresh.id" ? liveSession : null,
    );
    const refresh = vi.fn(async () => ({ id_token: "fresh.id" }));
    const session = await restoreSession(jar, {
      secure: true,
      fetch: fetchStub,
      config,
      now: NOW,
      verify,
      refresh,
    });
    expect(session).toEqual(liveSession);
    expect(refresh).toHaveBeenCalledOnce();
    expect(set.map((c) => c.name)).toEqual([
      ID_TOKEN_COOKIE,
      REFRESH_TOKEN_COOKIE,
    ]);
    expect(set[0]?.value).toBe("fresh.id");
    // Rotation off: keep the refresh token we just used.
    expect(set[1]?.value).toBe("rt-old");
    expect(set[1]?.maxAge).toBe(REFRESH_TOKEN_MAX_AGE_SEC);
  });

  it("refreshes when the existing id_token is expired", async () => {
    const { jar } = makeJar({
      [ID_TOKEN_COOKIE]: "stale.id",
      [REFRESH_TOKEN_COOKIE]: "rt-old",
    });
    const verify = vi.fn(async (_c, token: string) => {
      if (token === "stale.id") {
        return { ...liveSession, expiresAt: NOW - 1 };
      }
      return liveSession;
    });
    const refresh = vi.fn(async () => ({
      id_token: "fresh.id",
      refresh_token: "rt-rotated",
    }));
    const session = await restoreSession(jar, {
      secure: true,
      fetch: fetchStub,
      config,
      now: NOW,
      verify,
      refresh,
    });
    expect(session).toEqual(liveSession);
    expect(refresh).toHaveBeenCalledOnce();
    expect(jar.get(REFRESH_TOKEN_COOKIE)).toBe("rt-rotated");
  });

  it("keeps cookies when refresh fails transiently", async () => {
    const { jar, deleted } = makeJar({
      [ID_TOKEN_COOKIE]: "stale.id",
      [REFRESH_TOKEN_COOKIE]: "rt-dead",
    });
    const session = await restoreSession(jar, {
      secure: true,
      fetch: fetchStub,
      config,
      now: NOW,
      verify: async () => null,
      refresh: async () => {
        throw new Error("rejected");
      },
    });
    expect(session).toBeNull();
    expect(deleted).toEqual([]);
    expect(jar.get(REFRESH_TOKEN_COOKIE)).toBe("rt-dead");
  });

  it("clears cookies only when Cognito rejects the refresh token", async () => {
    const { TokenExchangeError } = await import("@hq/auth");
    const { jar, deleted } = makeJar({
      [ID_TOKEN_COOKIE]: "stale.id",
      [REFRESH_TOKEN_COOKIE]: "rt-dead",
    });
    const session = await restoreSession(jar, {
      secure: true,
      fetch: fetchStub,
      config,
      now: NOW,
      verify: async () => null,
      refresh: async () => {
        throw new TokenExchangeError(400);
      },
    });
    expect(session).toBeNull();
    expect(deleted).toEqual([ID_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]);
  });

  it("coalesces parallel refreshes of the same refresh token", async () => {
    let calls = 0;
    const refresh = vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { id_token: "fresh.id" };
    });
    const verify = vi.fn(async (_c, token: string) =>
      token === "fresh.id" ? liveSession : null,
    );
    const a = makeJar({ [REFRESH_TOKEN_COOKIE]: "rt-shared" });
    const b = makeJar({ [REFRESH_TOKEN_COOKIE]: "rt-shared" });
    const [left, right] = await Promise.all([
      restoreSession(a.jar, {
        secure: true,
        fetch: fetchStub,
        config,
        now: NOW,
        verify,
        refresh,
      }),
      restoreSession(b.jar, {
        secure: true,
        fetch: fetchStub,
        config,
        now: NOW,
        verify,
        refresh,
      }),
    ]);
    expect(left).toEqual(liveSession);
    expect(right).toEqual(liveSession);
    expect(calls).toBe(1);
  });
});

describe("clearSessionCookies", () => {
  it("deletes id and refresh cookies", () => {
    const { jar, deleted } = makeJar({
      [ID_TOKEN_COOKIE]: "id",
      [REFRESH_TOKEN_COOKIE]: "rt",
    });
    clearSessionCookies(jar);
    expect(deleted).toEqual([ID_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]);
  });
});
