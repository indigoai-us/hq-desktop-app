import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  applyNavigationCommit,
  assertSerializableNavigationEntry,
  canonicalDestinationKey,
  canonicalizeDestination,
  createNavigationEntry,
  createNavigationHistory,
  destinationCompanyKey,
  destinationLabel,
  destinationsEqual,
  entriesEqual,
  entryCompanyIsAccessible,
  extraParamCompanyKey,
  sessionExtraRequiresCompany,
  historyNeighbor,
  NAVIGATION_HISTORY_CAP,
  type NavigationDestination,
  type NavigationEntry,
} from "./navigation-history.js";
import {
  DESKTOP_APP_FUNCTION_HISTORY,
  DESKTOP_APP_FUNCTION_RE,
  DESKTOP_APP_VIEW_ASSIGN_COUNT,
  DESKTOP_APP_VIEW_ASSIGN_RE,
  DESKTOP_ALT_MAIN_FILE,
  HQ_WORK_SHELL_NAVIGATE_COUNT,
  HQ_WORK_SHELL_NAVIGATE_RE,
  LEGACY_DESKTOP_APP_FILE,
  NAVIGATION_HANDLER_MATRIX,
  NAVIGATION_INVENTORY_FILES,
  SHARED_SHELL_FILE,
  HQ_WORK_SHELL_FILE,
  handlerUsesNavigateBoundary,
  inScopeUserHandler,
  matrixRowsForFile,
} from "./navigation-handler-matrix.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function scope() {
  return { accountId: "acct_ada", companyUid: "cmp_acme" };
}

function entry(
  destination: NavigationDestination,
  overrides?: Partial<NavigationEntry>,
): NavigationEntry {
  return createNavigationEntry(
    destination,
    {
      accountId: overrides?.accountId ?? scope().accountId,
      companyUid:
        overrides?.companyUid !== undefined
          ? overrides.companyUid
          : scope().companyUid,
    },
    overrides?.scroll,
  );
}

function extractDesktopAppFunctions(source: string): string[] {
  const names = new Set<string>();
  const re = new RegExp(DESKTOP_APP_FUNCTION_RE.source, "g");
  for (const match of source.matchAll(re)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}

describe("navigation handler coverage matrix", () => {
  it("lists every inventoried handler and every row has a handler", () => {
    expect(NAVIGATION_HANDLER_MATRIX.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const row of NAVIGATION_HANDLER_MATRIX) {
      expect(row.id, "matrix row missing id").toBeTruthy();
      expect(row.file, `${row.id} missing file`).toBeTruthy();
      expect(row.needle, `${row.id} missing handler needle`).toBeTruthy();
      expect(row.destinationKind, `${row.id} missing destination`).toBeTruthy();
      expect(ids.has(row.id), `duplicate matrix id ${row.id}`).toBe(false);
      ids.add(row.id);
      const source = readRepo(row.file);
      expect(
        source.includes(row.needle),
        `${row.id}: needle not found in ${row.file}: ${row.needle}`,
      ).toBe(true);
    }
  });

  it("covers every declared inventory file", () => {
    for (const file of NAVIGATION_INVENTORY_FILES) {
      expect(
        matrixRowsForFile(file).length,
        `${file} has no matrix rows`,
      ).toBeGreaterThan(0);
    }
  });

  it("fails when a DesktopApp nav-shaped function is missing from the matrix", () => {
    const source = readRepo(SHARED_SHELL_FILE);
    const found = extractDesktopAppFunctions(source);
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(Object.keys(DESKTOP_APP_FUNCTION_HISTORY).sort());
    for (const name of found) {
      expect(
        DESKTOP_APP_FUNCTION_HISTORY[name],
        `${name} is not classified in DESKTOP_APP_FUNCTION_HISTORY`,
      ).toBeTruthy();
    }
  });

  it("fails when DesktopApp gains or loses a view assignment", () => {
    const source = readRepo(SHARED_SHELL_FILE);
    const matches = source.match(DESKTOP_APP_VIEW_ASSIGN_RE) ?? [];
    expect(matches.length).toBe(DESKTOP_APP_VIEW_ASSIGN_COUNT);
  });

  it("fails when HqWorkWorkShell gains or loses a navigation.navigate call", () => {
    const source = readRepo(HQ_WORK_SHELL_FILE);
    const matches = source.match(HQ_WORK_SHELL_NAVIGATE_RE) ?? [];
    expect(matches.length).toBe(HQ_WORK_SHELL_NAVIGATE_COUNT);
  });

  it("fails when an in-scope user handler bypasses navigate()", () => {
    const sources = new Map<string, string>();
    const read = (file: string) => {
      const cached = sources.get(file);
      if (cached) return cached;
      const next = readRepo(file);
      sources.set(file, next);
      return next;
    };
    const shared = read(SHARED_SHELL_FILE);
    expect(shared).not.toContain("onclick={() => (agentSurface = t.id)}");
    expect(shared).not.toContain("onselect={(id) => (companyTab = id)}");
    expect(shared).not.toContain("onclick={() => (tab = t.id)}");
    expect(shared).not.toContain('onOpenInChannel={() => (tab = "chat")}');
    expect(shared).not.toContain("onnavigatetab={(next) => (libraryTab = next)}");
    expect(shared).not.toContain('onclose={() => (agentSurface = "chat")}');
    for (const row of NAVIGATION_HANDLER_MATRIX) {
      if (!inScopeUserHandler(row)) continue;
      expect(
        handlerUsesNavigateBoundary(read(row.file), row.needle),
        `${row.id} bypasses navigate(): ${row.needle}`,
      ).toBe(true);
    }
  });

  it("validates the active host and documents the legacy DesktopRoute path as out of scope", () => {
    const main = readRepo(DESKTOP_ALT_MAIN_FILE);
    expect(main).toContain("import('./HqWorkWorkShell.svelte')");
    expect(main).not.toMatch(/from ['"]\.\/DesktopApp\.svelte['"]/);
    const work = readRepo("apps/work/src/lib/WorkShell.svelte");
    expect(work).toContain("<DesktopApp");
    const hqWork = readRepo(HQ_WORK_SHELL_FILE);
    expect(hqWork).toContain("<WorkShell");
    const legacy = matrixRowsForFile(LEGACY_DESKTOP_APP_FILE);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.inScope).toBe(false);
    expect(legacy[0]?.id).toBe("legacy-desktop-route-navigate");
  });
});

describe("destination equality and labels", () => {
  it("treats equal stable IDs as equal and unequal IDs as not", () => {
    const a: NavigationDestination = {
      kind: "channel",
      channelId: "chn_alpha",
      replyRootEventId: null,
      tab: "chat",
    };
    const b: NavigationDestination = {
      kind: "channel",
      channelId: "  chn_alpha  ",
    };
    const c: NavigationDestination = {
      kind: "channel",
      channelId: "chn_beta",
    };
    expect(destinationsEqual(a, b)).toBe(true);
    expect(destinationsEqual(a, c)).toBe(false);
    expect(canonicalDestinationKey(a)).toBe(canonicalDestinationKey(b));
    expect(canonicalDestinationKey(a)).not.toBe(canonicalDestinationKey(c));
  });

  it("does not treat nested reply or tab state as the same destination", () => {
    const channel: NavigationDestination = {
      kind: "channel",
      channelId: "chn_alpha",
    };
    const thread: NavigationDestination = {
      kind: "channel",
      channelId: "chn_alpha",
      replyRootEventId: "evt_root",
    };
    const files: NavigationDestination = {
      kind: "channel",
      channelId: "chn_alpha",
      tab: "files",
    };
    const preview: NavigationDestination = {
      kind: "channel",
      channelId: "chn_alpha",
      tab: "files",
      fileKey: "projects/demo/readme.md",
    };
    expect(destinationsEqual(channel, thread)).toBe(false);
    expect(destinationsEqual(channel, files)).toBe(false);
    expect(destinationsEqual(files, preview)).toBe(false);
    expect(destinationLabel(preview)).toBe("File preview");
  });

  it("returns human labels without cached titles", () => {
    expect(destinationLabel({ kind: "notifications" })).toBe("Notifications");
    expect(destinationLabel({ kind: "settings", section: "appearance" })).toBe(
      "Settings · Appearance",
    );
    expect(destinationLabel({ kind: "settings", section: "agents" })).toBe(
      "Settings · Agents",
    );
    expect(
      destinationLabel({ kind: "extra", page: "sessions", param: "new?draft=1" }),
    ).toBe("New session");
    expect(extraParamCompanyKey("new?company=indigo&draft=1")).toBe("indigo");
    expect(
      extraParamCompanyKey("history?id=h&tool=claude&company=cmp_gone"),
    ).toBe("cmp_gone");
    expect(extraParamCompanyKey("ses_live")).toBeNull();
    expect(extraParamCompanyKey("ses_live?company=cmp_gone")).toBe("cmp_gone");
    expect(sessionExtraRequiresCompany("ses_live")).toBe(true);
    expect(sessionExtraRequiresCompany("ses_live?company=cmp_gone")).toBe(true);
    expect(sessionExtraRequiresCompany("new")).toBe(false);
    expect(sessionExtraRequiresCompany("new?company=indigo&draft=1")).toBe(false);
    expect(sessionExtraRequiresCompany(null)).toBe(false);
    expect(
      destinationCompanyKey({
        kind: "extra",
        page: "sessions",
        param: "new?company=gone",
      }),
    ).toBe("gone");
    expect(
      canonicalizeDestination({
        kind: "extra",
        page: "sessions",
        param: "new?company=cmp_gone&draft=1",
      }),
    ).toEqual({
      kind: "extra",
      page: "sessions",
      param: "new?company=cmp_gone&draft=1",
      companyUid: "cmp_gone",
    });
    const extraGone = createNavigationEntry(
      {
        kind: "extra",
        page: "sessions",
        param: "new?company=cmp_gone&draft=1",
      },
      { accountId: "acct_ada", companyUid: null },
    );
    expect(
      entryCompanyIsAccessible(extraGone, new Set(["cmp_acme"])),
    ).toBe(false);
    expect(
      entryCompanyIsAccessible(extraGone, new Set(["cmp_gone", "gone"])),
    ).toBe(true);
    expect(
      destinationLabel({ kind: "channel", channelId: "chn_alpha" }),
    ).toBe("Channel");
  });

  it("models the DM connection-requests panel as a history destination", () => {
    expect(destinationLabel({ kind: "dm-requests" })).toBe("Connection requests");
    expect(canonicalizeDestination({ kind: "dm-requests", pairKey: "  " })).toEqual(
      { kind: "dm-requests", pairKey: null },
    );
    expect(
      canonicalizeDestination({ kind: "dm-requests", pairKey: " pair_1 " }),
    ).toEqual({ kind: "dm-requests", pairKey: "pair_1" });
    expect(
      destinationsEqual(
        { kind: "dm-requests" },
        { kind: "dm-requests", pairKey: null },
      ),
    ).toBe(true);
    expect(
      destinationsEqual(
        { kind: "dm-requests", pairKey: "pair_1" },
        { kind: "dm-requests", pairKey: "pair_2" },
      ),
    ).toBe(false);
    expect(canonicalDestinationKey({ kind: "dm-requests" })).not.toBe(
      canonicalDestinationKey({ kind: "messages" }),
    );
    expect(() =>
      assertSerializableNavigationEntry(
        entry({ kind: "dm-requests", pairKey: "pair_1" }),
      ),
    ).not.toThrow();
  });

  it("rejects component-like or presigned payloads", () => {
    expect(() =>
      assertSerializableNavigationEntry({
        destination: { kind: "messages" },
        accountId: "acct_ada",
        companyUid: null,
        component: {},
      } as NavigationEntry),
    ).toThrow(/serializable/);
    expect(() =>
      assertSerializableNavigationEntry({
        destination: {
          kind: "extra",
          page: "sessions",
          param: "https://bucket.s3.amazonaws.com/x?X-Amz-Signature=abc",
        },
        accountId: "acct_ada",
        companyUid: null,
      }),
    ).toThrow(/presigned/);
  });
});

describe("navigation history stack", () => {
  it("pushes, replaces, goes back and forward, suppresses duplicates, truncates forward, and caps at 100", () => {
    const history = createNavigationHistory();
    const a = entry({ kind: "channel", channelId: "chn_a" });
    const b = entry({ kind: "channel", channelId: "chn_b" });
    const c = entry({ kind: "extra", page: "sessions", param: "ses_c" });

    history.push(a);
    history.push(a);
    expect(history.snapshot().entries).toHaveLength(1);

    history.push(b);
    expect(history.canGoBack()).toBe(true);
    expect(history.canGoForward()).toBe(false);
    expect(history.current()?.destination).toEqual(
      expect.objectContaining({ kind: "channel", channelId: "chn_b" }),
    );

    history.back();
    expect(history.current()?.destination).toEqual(
      expect.objectContaining({ channelId: "chn_a" }),
    );
    expect(history.canGoForward()).toBe(true);

    history.push(c);
    expect(history.canGoForward()).toBe(false);
    expect(history.snapshot().entries.map((item) => item.destination.kind)).toEqual(
      ["channel", "extra"],
    );
    expect(history.snapshot().entries.length).toBeLessThanOrEqual(
      NAVIGATION_HISTORY_CAP,
    );

    history.replace(entry({ kind: "extra", page: "sessions", param: "ses_d" }));
    expect(history.current()?.destination).toEqual(
      expect.objectContaining({ param: "ses_d" }),
    );
    expect(history.snapshot().entries).toHaveLength(2);

    const labeled = createNavigationHistory();
    labeled.push(a);
    labeled.push(b);
    expect(historyNeighbor(labeled.snapshot(), "back")?.destination).toEqual(
      expect.objectContaining({ channelId: "chn_a" }),
    );
    expect(historyNeighbor(labeled.snapshot(), "forward")).toBeNull();
    labeled.back();
    expect(historyNeighbor(labeled.snapshot(), "forward")?.destination).toEqual(
      expect.objectContaining({ channelId: "chn_b" }),
    );

    for (let i = 0; i < 120; i += 1) {
      history.push(entry({ kind: "channel", channelId: `chn_${i}` }));
    }
    expect(history.snapshot().entries.length).toBe(NAVIGATION_HISTORY_CAP);
    expect(history.snapshot().index).toBe(NAVIGATION_HISTORY_CAP - 1);
  });

  it("does not add a history entry for hydration or poller writes", () => {
    const history = createNavigationHistory();
    const dest = entry({ kind: "channel", channelId: "chn_boot" });
    applyNavigationCommit(history, {
      kind: "non-navigation",
      reason: "hydration",
    });
    applyNavigationCommit(history, {
      kind: "non-navigation",
      reason: "polling",
    });
    expect(history.snapshot().entries).toEqual([]);
    expect(history.current()).toBeNull();

    applyNavigationCommit(history, {
      kind: "navigate",
      mode: "push",
      entry: dest,
    });
    expect(history.snapshot().entries).toHaveLength(1);
    applyNavigationCommit(history, {
      kind: "non-navigation",
      reason: "live-session-phase",
    });
    applyNavigationCommit(history, {
      kind: "non-navigation",
      reason: "background-roster",
    });
    applyNavigationCommit(history, {
      kind: "non-navigation",
      reason: "cosmetic-sidebar",
    });
    expect(history.snapshot().entries).toHaveLength(1);
  });

  it("stores a scroll anchor on the current entry without changing equality", () => {
    const history = createNavigationHistory();
    const a = entry({ kind: "channel", channelId: "chn_long" });
    history.push(a);
    history.recordScroll({
      kind: "message",
      id: "evt_mid",
      offset: 840,
    });
    const stored = history.current();
    expect(stored?.scroll).toEqual({
      kind: "message",
      id: "evt_mid",
      offset: 840,
    });
    expect(
      entriesEqual(stored!, entry({ kind: "channel", channelId: "chn_long" })),
    ).toBe(true);
    history.push(entry({ kind: "notifications" }));
    expect(history.snapshot().entries[0]?.scroll).toEqual({
      kind: "message",
      id: "evt_mid",
      offset: 840,
    });
    expect(JSON.stringify(history.snapshot())).not.toMatch(
      /localStorage|sessionStorage|indexedDB/i,
    );
  });
});
