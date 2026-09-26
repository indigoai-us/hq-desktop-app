import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Set import.meta.env before any module under test reads it (lazy getters)
import.meta.env.VITE_COGNITO_USER_POOL_ID = "us-east-1_TESTPOOL";
import.meta.env.VITE_COGNITO_CLIENT_ID = "test-client-id";
import.meta.env.VITE_COGNITO_DOMAIN = "https://auth.example.com";

// ---------------------------------------------------------------------------
// Fake keychain (in-memory Map, keyed by account name)
// ---------------------------------------------------------------------------
const fakeKeychain = new Map<string, string>();

// ---------------------------------------------------------------------------
// Fake filesystem (in-memory Map, path → content)
// ---------------------------------------------------------------------------
const fakeFs = new Map<string, string>();
const FAKE_HOME = "/Users/testuser";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports from the module under test
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    async (command: string, args?: Record<string, string>) => {
      switch (command) {
        case "keychain_set":
          fakeKeychain.set(args!.account, args!.secret);
          return null;
        case "keychain_get": {
          const val = fakeKeychain.get(args!.account);
          if (val === undefined) throw new Error("not found");
          return val;
        }
        case "keychain_delete":
          fakeKeychain.delete(args!.account);
          return null;
        case "home_dir":
          return FAKE_HOME;
        default:
          throw new Error(`Unknown command: ${command}`);
      }
    }
  ),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn(async (path: string, data: Uint8Array) => {
    fakeFs.set(path, new TextDecoder().decode(data));
  }),
  writeTextFile: vi.fn(async (path: string, content: string) => {
    fakeFs.set(path, content);
  }),
  readTextFile: vi.fn(async (path: string) => {
    const content = fakeFs.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }),
  rename: vi.fn(async (oldPath: string, newPath: string) => {
    const content = fakeFs.get(oldPath);
    if (content === undefined) throw new Error(`File not found: ${oldPath}`);
    fakeFs.set(newPath, content);
    fakeFs.delete(oldPath);
  }),
  remove: vi.fn(async (path: string) => {
    fakeFs.delete(path);
  }),
  mkdir: vi.fn(async () => {}),
  exists: vi.fn(async (path: string) => fakeFs.has(path) || path === `${FAKE_HOME}/.hq`),
}));

// Mock the AWS SDK
let mockSendImpl: (command: unknown) => Promise<unknown> = async () => ({});

vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  class MockClient {
    async send(command: unknown) {
      return mockSendImpl(command);
    }
  }
  class InitiateAuthCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GlobalSignOutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    CognitoIdentityProviderClient: MockClient,
    InitiateAuthCommand,
    GlobalSignOutCommand,
  };
});

// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks are registered
// ---------------------------------------------------------------------------
import {
  signOut,
  storeTokens,
  refreshSession,
  getCurrentUser,
  __resetCacheForTests,
  type CognitoTokens,
} from "../cognito.js";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid idToken JWT payload (base64url encoded middle segment) */
function makeIdToken(sub: string, email: string): string {
  const payload = { sub, email, exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = btoa(JSON.stringify(payload))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${encoded}.signature`;
}

function makeTokens(overrides: Partial<CognitoTokens> = {}): CognitoTokens {
  return {
    accessToken: "access-tok",
    idToken: makeIdToken("sub-123", "user@example.com"),
    refreshToken: "refresh-tok",
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

/** Pre-populate the fake keychain with a set of tokens */
async function seedKeychain(tokens: CognitoTokens) {
  fakeKeychain.set("tokens", JSON.stringify(tokens));
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  fakeKeychain.clear();
  fakeFs.clear();
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(
    async (command: string, args?: unknown) => {
      const invokeArgs = args as Record<string, string> | undefined;
      switch (command) {
        case "keychain_set":
          fakeKeychain.set(invokeArgs!.account, invokeArgs!.secret);
          return null;
        case "keychain_get": {
          const val = fakeKeychain.get(invokeArgs!.account);
          if (val === undefined) throw new Error("not found");
          return val;
        }
        case "keychain_delete":
          fakeKeychain.delete(invokeArgs!.account);
          return null;
        case "home_dir":
          return FAKE_HOME;
        default:
          throw new Error(`Unknown command: ${command}`);
      }
    },
  );
  // Reset the in-memory token cache — otherwise state leaks across tests
  // (the cache is module-scoped, not per-test).
  __resetCacheForTests();

  // Default AWS send: return empty object (overridden per-test as needed)
  mockSendImpl = async () => ({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// storeTokens — used by the provider OAuth flow to persist tokens after exchange
// ---------------------------------------------------------------------------

describe("storeTokens", () => {
  it("writes a single consolidated JSON blob to the keychain (one ACL prompt)", async () => {
    const tokens = makeTokens({
      accessToken: "acc",
      idToken: makeIdToken("sub-1", "alice@example.com"),
      refreshToken: "ref",
    });

    await storeTokens(tokens);

    // All tokens consolidated under the single "tokens" account to minimize
    // keychain access prompts in unsigned dev builds.
    expect(fakeKeychain.size).toBe(1);
    const stored = JSON.parse(fakeKeychain.get("tokens")!);
    expect(stored.accessToken).toBe("acc");
    expect(stored.idToken).toBe(tokens.idToken);
    expect(stored.refreshToken).toBe("ref");
    expect(stored.expiresAt).toBe(tokens.expiresAt);

    // Exactly one keychain_set invocation (no per-field prompts).
    const keychainSetCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "keychain_set");
    expect(keychainSetCalls).toHaveLength(1);
    expect(keychainSetCalls[0][1]).toMatchObject({ account: "tokens" });
  });

  it("continues with memory cache and shared handoff when Keychain write fails", async () => {
    const tokenFilePath = `${FAKE_HOME}/.hq/cognito-tokens.json`;
    const tokens = makeTokens({
      accessToken: "acc-after-keychain-failure",
      idToken: makeIdToken("sub-keychain-failure", "keychain-failure@example.com"),
      refreshToken: "ref-after-keychain-failure",
    });

    vi.mocked(invoke).mockImplementation(
      async (command: string, args?: unknown) => {
        const invokeArgs = args as Record<string, string> | undefined;
        switch (command) {
          case "keychain_set":
            throw new Error("locked keychain");
          case "keychain_get": {
            const val = fakeKeychain.get(invokeArgs!.account);
            if (val === undefined) throw new Error("not found");
            return val;
          }
          case "keychain_delete":
            fakeKeychain.delete(invokeArgs!.account);
            return null;
          case "home_dir":
            return FAKE_HOME;
          default:
            throw new Error(`Unknown command: ${command}`);
        }
      },
    );

    const status = await storeTokens(tokens);
    const user = await getCurrentUser();

    expect(status.keychain).toBe("failed");
    expect(status.sharedFile).toBe("written");
    expect(fakeKeychain.size).toBe(0);
    expect(fakeFs.has(tokenFilePath)).toBe(true);
    expect(JSON.parse(fakeFs.get(tokenFilePath)!).accessToken).toBe(
      "acc-after-keychain-failure",
    );
    expect(user?.email).toBe("keychain-failure@example.com");
    const keychainGetCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "keychain_get");
    expect(keychainGetCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

describe("signOut", () => {
  it("calls GlobalSignOut and clears keychain", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    const globalSignOutCalls: unknown[] = [];
    mockSendImpl = async (cmd) => {
      globalSignOutCalls.push(cmd);
      return {};
    };

    await signOut();

    expect(globalSignOutCalls).toHaveLength(1);
    expect(fakeKeychain.size).toBe(0);
    expect(invoke).toHaveBeenCalledWith(
      "keychain_delete",
      expect.objectContaining({ account: "tokens" }),
    );
  });

  it("clears keychain even if GlobalSignOut throws", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    mockSendImpl = async () => { throw new Error("network error"); };

    await signOut();

    expect(fakeKeychain.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getCurrentUser
// ---------------------------------------------------------------------------

describe("getCurrentUser", () => {
  it("returns null when no tokens in keychain", async () => {
    const user = await getCurrentUser();
    expect(user).toBeNull();
  });

  it("decodes email and sub from idToken", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    expect(user!.sub).toBe("sub-123");
    expect(user!.email).toBe("user@example.com");
    expect(user!.tokens.accessToken).toBe(tokens.accessToken);
  });

  it("auto-refreshes when tokens are expired", async () => {
    const expiredTokens = makeTokens({ expiresAt: Date.now() - 1000 });
    await seedKeychain(expiredTokens);

    const freshIdToken = makeIdToken("sub-456", "fresh@example.com");
    mockSendImpl = async () => ({
      AuthenticationResult: {
        AccessToken: "new-access",
        IdToken: freshIdToken,
        RefreshToken: "new-refresh",
        ExpiresIn: 3600,
      },
    });

    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    expect(user!.email).toBe("fresh@example.com");
    expect(user!.tokens.accessToken).toBe("new-access");
    // Consolidated blob should be updated with the fresh access token
    expect(JSON.parse(fakeKeychain.get("tokens")!).accessToken).toBe(
      "new-access",
    );
  });

  it("returns null and clears keychain if refresh fails", async () => {
    const expiredTokens = makeTokens({ expiresAt: Date.now() - 1000 });
    await seedKeychain(expiredTokens);

    mockSendImpl = async () => { throw new Error("RefreshTokenExpired"); };

    const user = await getCurrentUser();

    expect(user).toBeNull();
    expect(fakeKeychain.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// refreshSession
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// In-memory token cache — regression guard for the "4 keychain prompts" bug.
// ---------------------------------------------------------------------------

describe("token cache", () => {
  it("hits the keychain at most once for repeated getCurrentUser() calls", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    await getCurrentUser();
    await getCurrentUser();
    await getCurrentUser();

    const keychainGetCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "keychain_get");
    expect(keychainGetCalls).toHaveLength(1);
  });

  it("shares one keychain read across concurrent getCurrentUser() calls", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    // Fire three in parallel — simulating StrictMode double-mount + a third
    // caller racing to check auth at the same moment.
    await Promise.all([
      getCurrentUser(),
      getCurrentUser(),
      getCurrentUser(),
    ]);

    const keychainGetCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "keychain_get");
    expect(keychainGetCalls).toHaveLength(1);
  });

  it("serves storeTokens() results from cache without a subsequent keychain_get", async () => {
    const tokens = makeTokens();

    await storeTokens(tokens);
    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    expect(user!.tokens.accessToken).toBe(tokens.accessToken);
    const keychainGetCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "keychain_get");
    // storeTokens warmed the cache — no keychain read should have happened.
    expect(keychainGetCalls).toHaveLength(0);
  });

  it("invalidates the cache on signOut so a later getCurrentUser() returns null", async () => {
    const tokens = makeTokens();
    await storeTokens(tokens); // warms cache

    await signOut();

    const user = await getCurrentUser();
    expect(user).toBeNull();
  });
});

describe("refreshSession", () => {
  it("exchanges refresh token and updates keychain", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    const newIdToken = makeIdToken("sub-999", "new@example.com");
    mockSendImpl = async () => ({
      AuthenticationResult: {
        AccessToken: "refreshed-access",
        IdToken: newIdToken,
        // Cognito may not return a new refresh token
        RefreshToken: undefined,
        ExpiresIn: 3600,
      },
    });

    const refreshed = await refreshSession();

    expect(refreshed.accessToken).toBe("refreshed-access");
    // Should preserve original refresh token when Cognito doesn't return one
    expect(refreshed.refreshToken).toBe(tokens.refreshToken);
    const stored = JSON.parse(fakeKeychain.get("tokens")!);
    expect(stored.accessToken).toBe("refreshed-access");
    expect(stored.refreshToken).toBe(tokens.refreshToken);
  });

  it("throws when no refresh token stored", async () => {
    await expect(refreshSession()).rejects.toThrow("No refresh token");
  });
});

// ---------------------------------------------------------------------------
// Shared token file — sync handoff and keychain fallback
// ---------------------------------------------------------------------------

describe("shared token file", () => {
  const tokenFilePath = `${FAKE_HOME}/.hq/cognito-tokens.json`;

  it("storeTokens writes the full token set so HQ Sync can read the session", async () => {
    // HQ Sync's token parser requires refreshToken; an access-token-only
    // handoff fails to parse there and leaves the user signed out. The shared
    // file must carry the complete set (access + id + refresh + expiry).
    const idToken = makeIdToken("sub-shared", "shared@example.com");
    const tokens = makeTokens({
      accessToken: "acc-shared",
      idToken,
      refreshToken: "ref-shared",
      expiresAt: 1700000000000,
    });

    await storeTokens(tokens);

    expect(fakeFs.has(tokenFilePath)).toBe(true);
    const written = JSON.parse(fakeFs.get(tokenFilePath)!);
    expect(written.accessToken).toBe("acc-shared");
    expect(written.idToken).toBe(idToken);
    expect(written.refreshToken).toBe("ref-shared");
    expect(written.expiresAt).toBe(1700000000000);
    expect(typeof written.expiresAt).toBe("number");
  });

  it("creates the handoff temp file with 0600 permissions", async () => {
    const { writeFile: mockWriteFile } = await import("@tauri-apps/plugin-fs");
    const tokens = makeTokens();

    await storeTokens(tokens);

    const calls = vi.mocked(mockWriteFile).mock.calls;
    expect(calls).toHaveLength(1);
    const [path, data, options] = calls[0];
    expect(String(path)).toMatch(/\/\.cognito-tokens\.json\.tmp\./);
    expect(ArrayBuffer.isView(data)).toBe(true);
    expect(options).toEqual({ mode: 0o600 });
  });

  it("storeTokens uses atomic rename (no .tmp file remains)", async () => {
    const tokens = makeTokens();
    await storeTokens(tokens);

    const tmpFiles = [...fakeFs.keys()].filter((k) => k.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
    expect(fakeFs.has(tokenFilePath)).toBe(true);
  });

  // REGRESSION: installer wipes a valid desktop-only token file.
  // Previously loadTokens() deleted ~/.hq/cognito-tokens.json whenever the
  // keychain entry was missing, invalid, or read-errored (e.g. errSecAuthFailed
  // after re-signing). The desktop app and CLI only refresh the file, so
  // running the installer again erased a valid sign-in.

  it("loadTokens uses the shared file when the keychain entry is missing", async () => {
    // No keychain data — keychain_get throws "not found".
    // File holds a valid token set written by the desktop app.
    const fileTokens = makeTokens({
      accessToken: "file-acc",
      idToken: makeIdToken("sub-file", "file@example.com"),
      refreshToken: "file-ref",
    });
    fakeFs.set(tokenFilePath, JSON.stringify(fileTokens));

    const user = await getCurrentUser();

    // File tokens must be used — user is signed in, not null.
    expect(user).not.toBeNull();
    expect(user!.email).toBe("file@example.com");
    // File must NOT be deleted.
    expect(fakeFs.has(tokenFilePath)).toBe(true);
  });

  it("loadTokens uses the shared file when the keychain payload is invalid", async () => {
    // Keychain holds a malformed blob (e.g. partial write during a crash).
    fakeKeychain.set("tokens", JSON.stringify({ badField: true }));

    const fileTokens = makeTokens({
      accessToken: "file-acc-invalid-kc",
      idToken: makeIdToken("sub-file-invalid", "file-invalid@example.com"),
      refreshToken: "file-ref-invalid",
    });
    fakeFs.set(tokenFilePath, JSON.stringify(fileTokens));

    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    expect(user!.email).toBe("file-invalid@example.com");
    expect(fakeFs.has(tokenFilePath)).toBe(true);
  });

  it("loadTokens uses the shared file on errSecAuthFailed-style keychain errors", async () => {
    // Simulate errSecAuthFailed (-25293): keychain_get throws an error that
    // does not match isMissingKeychainEntry (i.e. not "not found").
    vi.mocked(invoke).mockImplementation(
      async (command: string, args?: unknown) => {
        const invokeArgs = args as Record<string, string> | undefined;
        switch (command) {
          case "keychain_get":
            throw new Error("errSecAuthFailed: The user name or passphrase you entered is not correct.");
          case "keychain_set":
            fakeKeychain.set(invokeArgs!.account, invokeArgs!.secret);
            return null;
          case "keychain_delete":
            fakeKeychain.delete(invokeArgs!.account);
            return null;
          case "home_dir":
            return FAKE_HOME;
          default:
            throw new Error(`Unknown command: ${command}`);
        }
      },
    );

    const fileTokens = makeTokens({
      accessToken: "file-acc-auth-failed",
      idToken: makeIdToken("sub-auth-failed", "auth-failed@example.com"),
      refreshToken: "file-ref-auth-failed",
    });
    fakeFs.set(tokenFilePath, JSON.stringify(fileTokens));

    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    expect(user!.email).toBe("auth-failed@example.com");
    // File must survive the keychain error.
    expect(fakeFs.has(tokenFilePath)).toBe(true);
  });

  it("loadTokens returns null when both keychain and file are unavailable", async () => {
    // No keychain entry, no file.
    const user = await getCurrentUser();
    expect(user).toBeNull();
    // File is absent — nothing to delete or preserve.
    expect(fakeFs.has(tokenFilePath)).toBe(false);
  });

  it("shared file is not deleted when keychain fails and file is also absent", async () => {
    // No keychain, no file — subsequent call must not create or delete anything.
    const user = await getCurrentUser();
    expect(user).toBeNull();
    expect([...fakeFs.keys()].filter((k) => k.includes("cognito-tokens"))).toHaveLength(0);
  });

  it("loadTokens prefers the token with the later expiresAt when both sources are valid", async () => {
    // Keychain has an older token; file has a fresher one (written by the CLI refresh).
    const now = Date.now();
    const keychainTokens = makeTokens({
      accessToken: "kc-acc-stale",
      idToken: makeIdToken("sub-kc-stale", "kc-stale@example.com"),
      expiresAt: now + 1_000,
    });
    const fileTokens = makeTokens({
      accessToken: "file-acc-fresh",
      idToken: makeIdToken("sub-file-fresh", "file-fresh@example.com"),
      refreshToken: "file-ref-fresh",
      expiresAt: now + 3_600_000,
    });
    await seedKeychain(keychainTokens);
    fakeFs.set(tokenFilePath, JSON.stringify(fileTokens));

    const user = await getCurrentUser();

    // File token is newer — it must win.
    expect(user).not.toBeNull();
    expect(user!.email).toBe("file-fresh@example.com");
  });

  it("loadTokens prefers keychain when keychain expiresAt is later than file", async () => {
    const now = Date.now();
    const keychainTokens = makeTokens({
      accessToken: "kc-acc-fresh",
      idToken: makeIdToken("sub-kc-fresh", "kc-fresh@example.com"),
      expiresAt: now + 3_600_000,
    });
    const fileTokens = makeTokens({
      accessToken: "file-acc-stale",
      idToken: makeIdToken("sub-file-stale", "file-stale@example.com"),
      refreshToken: "file-ref-stale",
      expiresAt: now + 1_000,
    });
    await seedKeychain(keychainTokens);
    fakeFs.set(tokenFilePath, JSON.stringify(fileTokens));

    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    expect(user!.email).toBe("kc-fresh@example.com");
  });

  it("file is deleted only on explicit signOut, not on keychain read failure", async () => {
    // Regression guard: file must survive any keychain failure; only signOut()
    // via clearTokens() may delete it.
    const fileTokens = makeTokens({
      accessToken: "file-acc-persist",
      idToken: makeIdToken("sub-persist", "persist@example.com"),
      refreshToken: "file-ref-persist",
    });
    fakeFs.set(tokenFilePath, JSON.stringify(fileTokens));

    // First load — keychain missing, file used.
    const user = await getCurrentUser();
    expect(user).not.toBeNull();
    expect(fakeFs.has(tokenFilePath)).toBe(true);

    // Now sign out — this is the only action that must delete the file.
    __resetCacheForTests();
    mockSendImpl = async () => ({});
    await signOut();
    expect(fakeFs.has(tokenFilePath)).toBe(false);
  });

  it("signOut deletes the shared token file", async () => {
    const tokens = makeTokens();
    await storeTokens(tokens);

    expect(fakeFs.has(tokenFilePath)).toBe(true);

    mockSendImpl = async () => ({});
    await signOut();

    expect(fakeFs.has(tokenFilePath)).toBe(false);
  });

  it("storeTokens calls mkdir when ~/.hq does not exist", async () => {
    const { exists: mockExists } = await import("@tauri-apps/plugin-fs");
    const { mkdir: mockMkdir } = await import("@tauri-apps/plugin-fs");

    // Override exists to return false for the .hq directory
    vi.mocked(mockExists).mockImplementation(async (path: string | URL) => {
      if (String(path) === `${FAKE_HOME}/.hq`) return false;
      return fakeFs.has(String(path));
    });

    const tokens = makeTokens();
    await storeTokens(tokens);

    expect(mockMkdir).toHaveBeenCalledWith(`${FAKE_HOME}/.hq`, { recursive: true });

    // Restore default exists behavior
    vi.mocked(mockExists).mockImplementation(
      async (path: string | URL) => fakeFs.has(String(path)) || String(path) === `${FAKE_HOME}/.hq`,
    );
  });
});
