// @vitest-environment happy-dom

/**
 * Board + detail behaviour for the shell's Ideas tab. Navigation is proved
 * separately (shell/hq-idea-board-ideas-tab-reachable.test.ts) — this file is
 * about what the board DOES once a user is on it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { ok, type IdeaCapture, type PlatformAdapter } from "@hq/platform";

import IdeasTab from "./IdeasTab.svelte";
import { localOnlyBadge, citedLabel, safeSourceUrl } from "./ideas-badges.js";

function capture(over: Partial<IdeaCapture> = {}): IdeaCapture {
  return {
    id: "cap_1",
    company_slug: "acme",
    kind: "quote",
    status: "extracted",
    confidence: 0.9,
    image_path: "/tmp/cap_1.png",
    ocr_text: null,
    extracted: { text: "Ship the thing" },
    tags: [],
    provenance: {
      app: "Safari",
      window_title: "Notes",
      url: "https://example.com/a",
      captured_at: "2026-09-01T10:00:00.000Z",
      display_id: 1,
    },
    note: null,
    cited_count: 0,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

interface IdeasStubs {
  captures?: IdeaCapture[];
  settings?: Record<string, unknown>;
  companies?: string[];
  listFails?: boolean;
}

function stubAdapter(opts: IdeasStubs = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, args]);
    return Promise.resolve(ok(null));
  };
  const adapter = {
    kind: "desktop",
    isAvailable: () => false,
    capabilities: {},
    ideas: {
      listCaptures: async () =>
        opts.listFails
          ? { ok: false as const, reason: "error" as const, message: "disk gone" }
          : ok(opts.captures ?? [capture()]),
      setKind: record("setKind"),
      correctKind: record("correctKind"),
      setNote: record("setNote"),
      setTags: record("setTags"),
      moveCapture: (...a: unknown[]) => {
        calls.push(["moveCapture", a]);
        return Promise.resolve(ok(undefined));
      },
      deleteCapture: (...a: unknown[]) => {
        calls.push(["deleteCapture", a]);
        return Promise.resolve(ok(undefined));
      },
      listCompanies: async () => ok(opts.companies ?? ["acme", "other"]),
      getSettings: async () => ok(opts.settings ?? { syncEnabled: true }),
      filePreview: async () => ok(null),
    },
  } as unknown as PlatformAdapter;
  return { adapter, calls };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

async function mountBoard(opts: IdeasStubs = {}) {
  const { adapter, calls } = stubAdapter(opts);
  component = mount(IdeasTab, {
    target: host,
    props: { adapter, slug: "acme" },
  });
  await vi.waitFor(
    () => {
      expect(
        host.querySelector('[data-testid="ideas-loading"]'),
      ).toBeNull();
    },
    { timeout: 5_000, interval: 10 },
  );
  return { calls };
}

function cardTitles(): string[] {
  return [...host.querySelectorAll('[data-testid="idea-card"]')].map(
    (el) => el.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
}

function type(selector: string, value: string): void {
  const el = host.querySelector<HTMLInputElement>(selector)!;
  el.value = value;
  flushSync(() => el.dispatchEvent(new Event("input", { bubbles: true })));
}

describe("hq-idea-board board surfaces", () => {
  it("renders one card per capture", async () => {
    await mountBoard({
      captures: [capture(), capture({ id: "cap_2", extracted: { text: "Second" } })],
    });
    expect(host.querySelectorAll('[data-testid="idea-card"]').length).toBe(2);
    expect(host.querySelector('[data-testid="ideas-masonry"]')).toBeTruthy();
  });

  it("searches the extracted text, not just the title", async () => {
    await mountBoard({
      captures: [
        capture({ id: "cap_1", extracted: { text: "Ship the thing" } }),
        capture({ id: "cap_2", extracted: { text: "Refactor later" } }),
      ],
    });
    type('[data-testid="ideas-search"]', "refactor");
    await tick();
    expect(cardTitles().length).toBe(1);
    expect(cardTitles()[0]).toContain("Refactor later");
  });

  it("says so when nothing matches, instead of showing a blank grid", async () => {
    await mountBoard();
    type('[data-testid="ideas-search"]', "zzzznope");
    await tick();
    expect(host.querySelectorAll('[data-testid="idea-card"]').length).toBe(0);
    expect(host.querySelector('[data-testid="ideas-noresults"]')).toBeTruthy();
  });

  it("filters by chip", async () => {
    await mountBoard({
      captures: [
        capture({ id: "cap_1", kind: "quote" }),
        capture({ id: "cap_2", kind: "article", extracted: { title: "A piece" } }),
      ],
    });
    flushSync(() =>
      host
        .querySelector<HTMLButtonElement>('.ideas-chip[data-chip="articles"]')
        ?.click(),
    );
    await tick();
    expect(cardTitles().length).toBe(1);
    expect(cardTitles()[0]).toContain("A piece");
  });

  it("shows the error surface with a retry when the captures cannot be read", async () => {
    await mountBoard({ listFails: true });
    const err = host.querySelector('[data-testid="ideas-error"]');
    expect(err).toBeTruthy();
    expect(err?.textContent).toContain("disk gone");
    expect(err?.querySelector("button")?.textContent?.trim()).toBe("Retry");
  });

  it("shows the capture chord when there is nothing captured yet", async () => {
    await mountBoard({ captures: [] });
    expect(host.querySelector('[data-testid="ideas-empty"]')).toBeTruthy();
  });

  it("badges the board local-only when sync is off, and not when it is on", async () => {
    await mountBoard({ settings: { syncEnabled: false, capturesRoot: "/tmp/x" } });
    const badge = host.querySelector('[data-testid="ideas-board-local-only"]');
    expect(badge?.textContent?.trim()).toBe("local only");
    expect(badge?.getAttribute("title")).toContain("/tmp/x");
    if (component) await unmount(component);
    component = null;
    host.innerHTML = "";
    await mountBoard({ settings: { syncEnabled: true } });
    expect(
      host.querySelector('[data-testid="ideas-board-local-only"]'),
    ).toBeNull();
  });

  it("writes the user's verdict on a low-confidence capture", async () => {
    const { calls } = await mountBoard({
      captures: [capture({ status: "low_confidence", kind: "x_post" })],
    });
    expect(host.querySelector('[data-testid="idea-lowconf-strip"]')).toBeTruthy();
    flushSync(() =>
      host.querySelector<HTMLButtonElement>(".idea-lowconf-accept")?.click(),
    );
    await tick();
    expect(calls.find((c) => c[0] === "setKind")?.[1]).toEqual([
      "cap_1",
      "x_post",
      "extracted",
    ]);
  });

  it("demotes a wrong guess to a plain image", async () => {
    const { calls } = await mountBoard({
      captures: [capture({ status: "low_confidence", kind: "x_post" })],
    });
    flushSync(() =>
      host.querySelector<HTMLButtonElement>(".idea-lowconf-dismiss")?.click(),
    );
    await tick();
    expect(calls.find((c) => c[0] === "setKind")?.[1]).toEqual([
      "cap_1",
      "image",
      "plain",
    ]);
  });
});

describe("hq-idea-board detail pane", () => {
  async function openDetail(opts: IdeasStubs = {}) {
    const result = await mountBoard(opts);
    flushSync(() =>
      host.querySelector<HTMLElement>('[data-testid="idea-card"]')?.click(),
    );
    await tick();
    expect(host.querySelector('[data-testid="idea-detail"]')).toBeTruthy();
    return result;
  }

  it("opens from a card click", async () => {
    await openDetail();
    expect(
      host.querySelector('[data-testid="idea-detail"]')?.getAttribute("data-id"),
    ).toBe("cap_1");
  });

  it("saves a note on blur", async () => {
    const { calls } = await openDetail();
    const note = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="idea-detail-note"]',
    )!;
    note.value = "worth revisiting";
    flushSync(() => note.dispatchEvent(new Event("input", { bubbles: true })));
    flushSync(() => note.dispatchEvent(new Event("blur", { bubbles: true })));
    await tick();
    expect(calls.find((c) => c[0] === "setNote")?.[1]).toEqual([
      "cap_1",
      "worth revisiting",
    ]);
  });

  it("splits tags on commas and trims them", async () => {
    const { calls } = await openDetail();
    const tags = host.querySelector<HTMLInputElement>(
      '[data-testid="idea-detail-tags"]',
    )!;
    tags.value = " craft , ideas ";
    flushSync(() => tags.dispatchEvent(new Event("input", { bubbles: true })));
    flushSync(() => tags.dispatchEvent(new Event("blur", { bubbles: true })));
    await tick();
    expect(calls.find((c) => c[0] === "setTags")?.[1]).toEqual([
      "cap_1",
      ["craft", "ideas"],
    ]);
  });

  it("corrects the kind", async () => {
    const { calls } = await openDetail();
    const select = host.querySelector<HTMLSelectElement>(
      '[data-testid="idea-detail-kind"]',
    )!;
    select.value = "article";
    flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    await tick();
    expect(calls.find((c) => c[0] === "correctKind")?.[1]).toEqual([
      "cap_1",
      "article",
    ]);
  });

  it("moves the capture to another company and closes", async () => {
    const { calls } = await openDetail({ companies: ["acme", "other"] });
    const move = host.querySelector<HTMLSelectElement>(
      '[data-testid="idea-detail-move"]',
    )!;
    // The current company is never a destination.
    expect([...move.options].map((o) => o.value)).toEqual(["", "other"]);
    move.value = "other";
    flushSync(() => move.dispatchEvent(new Event("change", { bubbles: true })));
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="idea-detail"]')).toBeNull();
    });
    expect(calls.find((c) => c[0] === "moveCapture")?.[1]).toEqual([
      "cap_1",
      "other",
    ]);
  });

  it("asks before deleting, then deletes", async () => {
    const { calls } = await openDetail();
    flushSync(() =>
      host
        .querySelector<HTMLButtonElement>('[data-testid="idea-detail-delete"]')
        ?.click(),
    );
    await tick();
    expect(host.querySelector('[data-testid="idea-detail-confirm"]')).toBeTruthy();
    expect(calls.some((c) => c[0] === "deleteCapture")).toBe(false);
    flushSync(() =>
      host
        .querySelector<HTMLButtonElement>('[data-testid="idea-detail-delete-yes"]')
        ?.click(),
    );
    await vi.waitFor(() => {
      expect(calls.some((c) => c[0] === "deleteCapture")).toBe(true);
    });
  });

  it("opens the source URL through the injected opener", async () => {
    await openDetail();
    const link = host.querySelector<HTMLButtonElement>(
      '[data-testid="idea-detail-url"]',
    )!;
    expect(link.textContent).toContain("https://example.com/a");
  });
});

describe("hq-idea-board pure helpers", () => {
  it("never claims local-only on an unknown posture", () => {
    expect(localOnlyBadge(null)).toBeNull();
    expect(localOnlyBadge({})).toBeNull();
    expect(localOnlyBadge({ syncEnabled: true })).toBeNull();
    expect(localOnlyBadge({ syncEnabled: false })?.label).toBe("local only");
  });

  it("renders no citation label below one citation", () => {
    expect(citedLabel(0)).toBeNull();
    expect(citedLabel(-3)).toBeNull();
    expect(citedLabel(2)).toBe("Cited 2× by agents");
  });

  it("refuses source URLs that are not credential-free http(s)", () => {
    expect(safeSourceUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeSourceUrl("file:///etc/passwd")).toBeNull();
    expect(safeSourceUrl("https://u:p@example.com")).toBeNull();
    expect(safeSourceUrl("not a url")).toBeNull();
    expect(safeSourceUrl(null)).toBeNull();
  });
});

describe("hq-idea-board platform purity", () => {
  const files = [
    "IdeasTab.svelte",
    "IdeaCard.svelte",
    "IdeaDetail.svelte",
    "idea-captures.svelte.ts",
  ];

  const read = (name: string) =>
    readFileSync(resolve(process.cwd(), `src/chat/tabs/ideas/${name}`), "utf8");

  it("reaches the host only through the adapter, never through invoke()", () => {
    for (const name of files) {
      const src = read(name);
      expect(src).not.toContain("invoke(");
      expect(src).not.toContain('from "@tauri-apps/api');
    }
  });

  it("routes every capture write through adapter.ideas", () => {
    expect(read("idea-captures.svelte.ts")).toContain("adapter.ideas");
  });
});
