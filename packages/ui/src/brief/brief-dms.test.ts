// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { dmsFromSender, loadSenderDms, previewLine, shortAgo, teammateReplyPrompt } from "./brief-dms.js";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEightBrief } from "./brief-fixture.js";

const IZZY = "agt_5RPNSHMTP5PP3DDCD0ZF906VYS";
const ME = "prs_me";
const page = {
  messages: [
    { eventId: "e1", fromPersonUid: IZZY, body: "Older note", createdAt: "2026-10-08T20:00:00Z" },
    { eventId: "e2", fromPersonUid: ME, direction: "out", body: "My reply", createdAt: "2026-10-08T21:00:00Z" },
    { eventId: "e3", fromPersonUid: IZZY, body: "Can you reply to the X mention?", createdAt: "2026-10-08T23:08:00Z", unread: true, threadTitle: "X mentions" },
    { eventId: "e4", fromPersonUid: "prs_other", body: "Not Izzy", createdAt: "2026-10-08T23:09:00Z" },
    { eventId: "e5", fromPersonUid: IZZY, messageKind: "system", body: "run complete", createdAt: "2026-10-08T23:10:00Z" },
    { eventId: "e6", fromPersonUid: IZZY, body: "   ", createdAt: "2026-10-08T23:11:00Z" },
  ],
};

describe("sender filtering", () => {
  it("keeps only the sender's real messages, newest first", () => {
    const dms = dmsFromSender(page, IZZY);
    expect(dms.map((d) => d.id)).toEqual(["e3", "e1"]);
    expect(dms[0]).toMatchObject({ text: "Can you reply to the X mention?", unread: true, thread: "X mentions" });
    expect(dms[1]!.unread).toBe(false);
    expect(dmsFromSender(page, "prs_nobody")).toEqual([]);
    expect(dmsFromSender({}, IZZY)).toEqual([]);
  });

  it("reads the live thread with the sender's uid and reports failures plainly", async () => {
    const fetchDmThread = vi.fn(async () => ({ ok: true as const, value: page }));
    const ok = await loadSenderDms({ fetchDmThread }, IZZY);
    expect(fetchDmThread).toHaveBeenCalledWith({ withPersonUid: IZZY, limit: 40 });
    expect(ok.state === "ready" && ok.dms.length).toBe(2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = await loadSenderDms({ fetchDmThread: async () => ({ ok: false as const, reason: "error" as const }) }, IZZY);
    expect(bad).toEqual({ state: "error", message: "Could not load these messages. Try again in a moment." });
    expect((await loadSenderDms(null, IZZY)).state).toBe("error");
    warn.mockRestore();
  });

  it("previews one line and a compact age", () => {
    expect(previewLine("a\n  b   c")).toBe("a b c");
    expect(previewLine("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(shortAgo("2026-10-08T23:00:00Z", new Date("2026-10-08T23:30:00Z"))).toBe("30m");
  });
});

describe("reply prompt content", () => {
  it("quotes the actual latest messages and never the DM count context", () => {
    const prompt = teammateReplyPrompt("Izzy", dmsFromSender(page, IZZY), true);
    expect(prompt).toContain('"Can you reply to the X mention?"');
    expect(prompt).toContain('"Older note"');
    expect(prompt).toContain("in X mentions");
    expect(prompt.indexOf("Older note")).toBeLessThan(prompt.indexOf("X mention?"));
    expect(prompt).toContain("Izzy (an AI agent)");
    expect(prompt).not.toMatch(/DMs? to you/);
    expect(prompt).toContain("Do not send it");
  });

  it("caps the quote at the three newest messages", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, text: `msg ${i}`, at: new Date(Date.UTC(2026, 9, 8, i)).toISOString(), unread: false, thread: null }));
    const prompt = teammateReplyPrompt("Ace", many.slice().reverse());
    expect((prompt.match(/msg \d/g) ?? []).length).toBe(3);
    expect(prompt).toContain("msg 5");
    expect(prompt).not.toContain("msg 2");
  });
});

describe("Team card with live DMs", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("shows the latest message as the row subtitle with the count as a badge", async () => {
    const fetchDmThread = vi.fn(async ({ withPersonUid }: { withPersonUid: string }) => ({
      ok: true as const,
      value: withPersonUid === IZZY ? page : { messages: [] },
    }));
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(DailyBrief, {
      target,
      props: { input: octoberEightBrief(new Date(2026, 9, 8, 7, 42)), dmApi: { fetchDmThread }, onopenthread: () => {} },
    });
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      await tick();
    }
    flushSync();
    expect(fetchDmThread).toHaveBeenCalledWith({ withPersonUid: IZZY, limit: 40 });
    const team = target.querySelector('[data-testid="brief-team"]')!;
    expect(team.textContent).not.toMatch(/DMs to you/);
    const preview = team.querySelector('[data-testid="brief-team-preview"]')!;
    expect(preview.textContent).toContain("Can you reply to the X mention?");
    expect(team.querySelector('[data-testid="brief-team-count"]')?.textContent).toMatch(/^\d+$/);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function hoverIzzy(fetchDmThread: (a: { withPersonUid: string }) => Promise<any>, onopenthread = vi.fn()) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(DailyBrief, {
      target,
      props: { input: octoberEightBrief(new Date(2026, 9, 8, 7, 42)), dmApi: { fetchDmThread }, onopenthread },
    });
    flushSync();
    const row = target.querySelector<HTMLElement>('[data-testid="brief-team"] [aria-label="Izzy"]')!;
    row.dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 260));
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      await tick();
    }
    flushSync();
    return target.querySelector<HTMLElement>('[data-testid="brief-peek"]')!;
  }

  it("the peek lists the sender's messages, opens the thread, and quotes them in the prompt", async () => {
    const onopenthread = vi.fn();
    const peek = await hoverIzzy(async ({ withPersonUid }) => ({ ok: true, value: withPersonUid === IZZY ? page : { messages: [] } }), onopenthread);
    const items = [...peek.querySelectorAll('[data-testid="brief-peek-dm"]')].map((el) => el.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("Can you reply to the X mention?");
    expect(items.join(" ")).not.toContain("Not Izzy");
    expect(peek.querySelector('[data-testid="brief-peek-prompt"]')?.textContent).toContain('"Can you reply to the X mention?"');
    peek.querySelector<HTMLButtonElement>('[data-testid="brief-peek-open-thread"]')!.click();
    expect(onopenthread).toHaveBeenCalledWith(IZZY);
  });

  it("the peek shows empty and error states", async () => {
    let peek = await hoverIzzy(async () => ({ ok: true, value: { messages: [] } }));
    expect(peek.querySelector('[data-testid="brief-peek-dms-empty"]')).not.toBeNull();
    unmount(app!);
    app = null;
    target.remove();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    peek = await hoverIzzy(async () => ({ ok: false, reason: "error" }));
    expect(peek.querySelector('[data-testid="brief-peek-dms-error"]')?.textContent).toContain("Could not load");
    warn.mockRestore();
  });
});
