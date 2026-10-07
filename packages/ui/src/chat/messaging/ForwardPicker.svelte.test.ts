// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ForwardPicker from "./ForwardPicker.svelte";
import type { ConversationRow } from "../sidebar-model.js";
import type { ForwardRequest, ForwardResult, ForwardSource } from "./forward-model.js";

/** US-009 AC1-AC7: the Forward destination picker. */

let component: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

const rows = [
  { id: "dm:prs_ana", kind: "dm", title: "Ana", personUid: "prs_ana", companyUid: null },
  { id: "dm:agt_bot", kind: "dm", title: "Helper", personUid: "agt_bot", companyUid: null },
  { id: "ch:ch_a", kind: "channel", title: "team-a", channelId: "ch_a", companyUid: "cmp_a" },
  { id: "ch:ch_b", kind: "channel", title: "team-b", channelId: "ch_b", companyUid: "cmp_b" },
].map((r) => ({ unreadDot: false, lastActivityAt: 0, pinned: false, ...r })) as ConversationRow[];

const source: ForwardSource = {
  conversationId: "ch_src",
  eventId: "evt_1",
  companyUid: "cmp_a",
  senderName: "Bo Lee",
  body: "line one\nline two\nline three\nline four",
  artifactKind: "details",
  artifactTitle: "Launch plan",
};

const okResult: ForwardResult = { ok: true, omittedAttachments: 0 };

function setup(overrides: Record<string, unknown> = {}) {
  const onsend = vi.fn<(req: ForwardRequest) => Promise<ForwardResult>>(async () => okResult);
  const onclose = vi.fn();
  const ondone = vi.fn();
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ForwardPicker, {
    target: host,
    props: {
      source,
      rows,
      contacts: [{ participantUid: "prs_cy", participantType: "human", displayName: "Cy", companyUid: "cmp_a" }],
      adminCompanies: [],
      onsend,
      onclose,
      ondone,
      ...overrides,
    } as never,
  });
  flushSync();
  return { onsend, onclose, ondone, fetchSpy };
}

const q = <T extends Element = HTMLElement>(sel: string) => host!.querySelector<T>(sel as never) as T | null;
const options = () => Array.from(host!.querySelectorAll<HTMLButtonElement>('[data-testid="forward-option"]'));
const optionNames = () => options().map((o) => o.querySelector(".forward-option-name")!.textContent);

function key(target: Element, k: string, extra: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
  flushSync();
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("ForwardPicker", () => {
  it("opens from the given rows and contacts with no network call (AC1, AC6, AC7)", () => {
    const { onsend, fetchSpy } = setup();
    expect(optionNames()).toEqual(["Ana", "Helper", "#team-a", "Cy"]);
    expect(onsend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters by name from the search field (AC1)", () => {
    setup();
    type(q<HTMLInputElement>('[data-testid="forward-search"]')!, "hel");
    expect(optionNames()).toEqual(["Helper"]);
  });

  it("selects exactly one destination (AC2)", () => {
    setup();
    options()[0].click();
    flushSync();
    options()[2].click();
    flushSync();
    const selected = options().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.dataset.id)).toEqual(["ch:ch_a"]);
  });

  it("previews sender, first lines, and the Details title (AC3)", () => {
    setup();
    expect(q('[data-testid="forward-preview-sender"]')!.textContent).toBe("Bo Lee");
    const body = q('[data-testid="forward-preview-body"]')!.textContent!;
    expect(body).toContain("line one");
    expect(body).toContain("line three");
    expect(body).not.toContain("line four");
    expect(q('[data-testid="forward-preview-artifact"]')!.textContent).toBe("Details: Launch plan");
  });

  it("shows the company control only to an owner/admin of more than one company (AC4)", () => {
    setup({ adminCompanies: [{ uid: "cmp_a", name: "A" }] });
    expect(q('[data-testid="forward-company"]')).toBeNull();
  });

  it("lets a multi-company admin pick another company's destinations (AC4)", () => {
    setup({ adminCompanies: [{ uid: "cmp_a", name: "A" }, { uid: "cmp_b", name: "B" }] });
    const select = q<HTMLSelectElement>('[data-testid="forward-company"]')!;
    expect(select).not.toBeNull();
    select.value = "cmp_b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(optionNames()).toEqual(["#team-b"]);
  });

  it("sends forwardOf and the note, closes, and names the destination (AC5)", async () => {
    const { onsend, onclose, ondone } = setup();
    options()[0].click();
    flushSync();
    type(q<HTMLTextAreaElement>('[data-testid="forward-note"]')!, "see this");
    q<HTMLButtonElement>('[data-testid="forward-send"]')!.click();
    await tick();
    await tick();
    expect(onsend).toHaveBeenCalledTimes(1);
    const req = onsend.mock.calls[0][0];
    expect(req.forwardOf).toEqual({ conversationId: "ch_src", eventId: "evt_1" });
    expect(req.note).toBe("see this");
    expect(req.destination.principalUid).toBe("prs_ana");
    expect(req.acknowledgeCrossCompany).toBeUndefined();
    expect(onclose).toHaveBeenCalled();
    expect(ondone).toHaveBeenCalledWith("Ana", okResult);
  });

  it("Escape closes (AC6)", () => {
    const { onclose } = setup();
    key(q('[data-testid="forward-search"]')!, "Escape");
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("Enter sends only when a destination is selected (AC6)", async () => {
    const { onsend } = setup();
    const search = q<HTMLInputElement>('[data-testid="forward-search"]')!;
    key(search, "Enter");
    await tick();
    expect(onsend).not.toHaveBeenCalled();
    key(search, "ArrowDown");
    key(search, "Enter");
    await tick();
    expect(onsend).toHaveBeenCalledTimes(1);
    expect(onsend.mock.calls[0][0].destination.id).toBe("dm:prs_ana");
  });

  it("send stays disabled until a destination is selected", () => {
    setup();
    expect(q<HTMLButtonElement>('[data-testid="forward-send"]')!.disabled).toBe(true);
    options()[1].click();
    flushSync();
    expect(q<HTMLButtonElement>('[data-testid="forward-send"]')!.disabled).toBe(false);
  });

  it("asks before a cross-company send and resends with acknowledgeCrossCompany", async () => {
    const { onsend, ondone } = setup();
    onsend.mockResolvedValueOnce({
      ok: false,
      code: "CROSS_COMPANY_ACK_REQUIRED",
      status: 409,
      files: [],
      notShareable: [],
      sourceCompany: { uid: "cmp_a", name: "A" },
      destinationCompany: { uid: "cmp_b", name: "B" },
    });
    options()[0].click();
    flushSync();
    q<HTMLButtonElement>('[data-testid="forward-send"]')!.click();
    await tick();
    await tick();
    expect(q('[data-testid="forward-ack"]')!.textContent).toContain("from A to B");
    expect(ondone).not.toHaveBeenCalled();
    q<HTMLButtonElement>('[data-testid="forward-ack-confirm"]')!.click();
    await tick();
    await tick();
    expect(onsend).toHaveBeenCalledTimes(2);
    expect(onsend.mock.calls[1][0].acknowledgeCrossCompany).toBe(true);
    expect(ondone).toHaveBeenCalledWith("Ana", okResult);
  });

  it("offers grant or omit when files need access", async () => {
    const { onsend } = setup();
    onsend.mockResolvedValueOnce({ ok: false, code: "FORWARD_FILE_ACCESS_REQUIRED", status: 409, files: [], notShareable: [] });
    options()[0].click();
    flushSync();
    q<HTMLButtonElement>('[data-testid="forward-send"]')!.click();
    await tick();
    await tick();
    q<HTMLButtonElement>('[data-testid="forward-files-omit"]')!.click();
    await tick();
    expect(onsend.mock.calls[1][0].fileAccess).toBe("omit");
  });

  it("shows a plain sentence on failure, never the server text", async () => {
    const { onsend, onclose } = setup();
    onsend.mockResolvedValueOnce({ ok: false, code: "FORWARD_SOURCE_NOT_FOUND", status: 404, files: [], notShareable: [] });
    options()[0].click();
    flushSync();
    q<HTMLButtonElement>('[data-testid="forward-send"]')!.click();
    await tick();
    await tick();
    expect(q('[data-testid="forward-error"]')!.textContent).toBe(
      "That message is no longer available. Close this and refresh the conversation.",
    );
    expect(onclose).not.toHaveBeenCalled();
  });
});
