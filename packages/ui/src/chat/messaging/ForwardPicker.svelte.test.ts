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
  attachmentCount: 0,
  attachmentNames: [],
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
    expect(q('[data-testid="forward-error-text"]')!.textContent).toBe(
      "That message is no longer available. Close this and refresh the conversation.",
    );
    expect(onclose).not.toHaveBeenCalled();
  });

  describe("US-010 file access, notices, error recovery", () => {
    const fileSource: ForwardSource = { ...source, attachmentCount: 2, attachmentNames: ["a.pdf", "b.png"] };
    const multi = [
      { uid: "cmp_a", name: "Acme" },
      { uid: "cmp_b", name: "Beta" },
    ];

    async function sendTo(index: number) {
      options()[index].click();
      flushSync();
      q<HTMLButtonElement>('[data-testid="forward-send"]')!.click();
      await tick();
      await tick();
    }

    function chooseCompany(uid: string) {
      const sel = q<HTMLSelectElement>('[data-testid="forward-company"]')!;
      sel.value = uid;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      flushSync();
    }

    const filesRequired: ForwardResult = {
      ok: false,
      code: "FORWARD_FILE_ACCESS_REQUIRED",
      status: 409,
      files: [{ id: "f1", name: "a.pdf" }, { id: "f2", name: "b.png" }],
      notShareable: [{ id: "f3", name: "secret.xlsx" }],
    };

    it("AC0: shows 'This shares {n} files with {name}', the names, and two actions", async () => {
      const { onsend } = setup({ source: fileSource });
      onsend.mockResolvedValueOnce(filesRequired);
      await sendTo(0);
      expect(q('[data-testid="forward-files-title"]')!.textContent).toBe("This shares 2 files with Ana");
      const listed = Array.from(q('[data-testid="forward-files-list"]')!.querySelectorAll("li")).map((l) => l.textContent);
      expect(listed).toEqual(["a.pdf", "b.png"]);
      expect(q('[data-testid="forward-files-grant"]')!.textContent).toBe("Share and send");
      expect(q('[data-testid="forward-files-omit"]')!.textContent).toBe("Send without files");
    });

    it("AC0: singular wording for one file", async () => {
      const { onsend } = setup({ source: fileSource });
      onsend.mockResolvedValueOnce({ ...filesRequired, files: [{ id: "f1", name: "a.pdf" }], notShareable: [] });
      await sendTo(0);
      expect(q('[data-testid="forward-files-title"]')!.textContent).toBe("This shares 1 file with Ana");
    });

    it("AC1: share and send resends with fileAccess grant, keeping destination and note", async () => {
      const { onsend, ondone } = setup({ source: fileSource });
      onsend.mockResolvedValueOnce(filesRequired);
      type(q<HTMLTextAreaElement>('[data-testid="forward-note"]')!, "fyi");
      await sendTo(0);
      expect(onsend.mock.calls[0][0].fileAccess).toBeUndefined();
      q<HTMLButtonElement>('[data-testid="forward-files-grant"]')!.click();
      await tick();
      await tick();
      const req = onsend.mock.calls[1][0];
      expect(req.fileAccess).toBe("grant");
      expect(req.destination.id).toBe("dm:prs_ana");
      expect(req.note).toBe("fyi");
      expect(ondone).toHaveBeenCalled();
    });

    it("AC1: send without files resends with fileAccess omit", async () => {
      const { onsend } = setup({ source: fileSource });
      onsend.mockResolvedValueOnce(filesRequired);
      await sendTo(0);
      q<HTMLButtonElement>('[data-testid="forward-files-omit"]')!.click();
      await tick();
      expect(onsend.mock.calls[1][0].fileAccess).toBe("omit");
    });

    it("AC4: a file that cannot be shared is listed as not included with no share action", async () => {
      const { onsend } = setup({ source: fileSource });
      onsend.mockResolvedValueOnce(filesRequired);
      await sendTo(0);
      const blocked = q('[data-testid="forward-files-not-included"]')!;
      expect(blocked.textContent).toContain("Not included");
      expect(blocked.textContent).toContain("secret.xlsx");
      expect(blocked.querySelector("button")).toBeNull();
      expect(q('[data-testid="forward-files-list"]')!.textContent).not.toContain("secret.xlsx");
    });

    it("AC4: when every file is blocked only send without files is offered", async () => {
      const { onsend } = setup({ source: fileSource });
      onsend.mockResolvedValueOnce({ ...filesRequired, files: [] });
      await sendTo(0);
      expect(q('[data-testid="forward-files-grant"]')).toBeNull();
      expect(q('[data-testid="forward-files-omit"]')).not.toBeNull();
      expect(q('[data-testid="forward-files-not-included"]')!.textContent).toContain("secret.xlsx");
    });

    it("AC2: a channel destination with files shows the notice before sending", () => {
      const { onsend } = setup({ source: fileSource });
      expect(q('[data-testid="forward-notice-channel"]')).toBeNull();
      const channel = options().find((o) => o.dataset.id === "ch:ch_a")!;
      channel.click();
      flushSync();
      expect(onsend).not.toHaveBeenCalled();
      expect(q('[data-testid="forward-notice-channel"]')!.textContent).toBe(
        "Files are not included in forwards to channels. 2 files will be left out.",
      );
    });

    it("AC2: no channel notice when the message has no files", () => {
      setup();
      options().find((o) => o.dataset.id === "ch:ch_a")!.click();
      flushSync();
      expect(q('[data-testid="forward-notice-channel"]')).toBeNull();
    });

    it("AC3: another company shows both names, and only the confirm press sends the ack", async () => {
      const { onsend } = setup({ adminCompanies: multi });
      chooseCompany("cmp_b");
      options().find((o) => o.dataset.id === "ch:ch_b")!.click();
      flushSync();
      const notice = q('[data-testid="forward-notice-cross-company"]')!;
      expect(notice.textContent).toBe("This sends the message from Acme to Beta. Files are not included.");
      expect(onsend).not.toHaveBeenCalled();
      const send = q<HTMLButtonElement>('[data-testid="forward-send"]')!;
      expect(send.textContent).toBe("Confirm and forward");
      send.click();
      await tick();
      expect(onsend.mock.calls[0][0].acknowledgeCrossCompany).toBe(true);
    });

    it("AC3: a same-company send never carries acknowledgeCrossCompany", async () => {
      const { onsend } = setup({ adminCompanies: multi });
      options().find((o) => o.dataset.id === "ch:ch_a")!.click();
      flushSync();
      expect(q('[data-testid="forward-notice-cross-company"]')).toBeNull();
      expect(q('[data-testid="forward-send"]')!.textContent).toBe("Forward");
      q<HTMLButtonElement>('[data-testid="forward-send"]')!.click();
      await tick();
      expect(onsend.mock.calls[0][0].acknowledgeCrossCompany).toBeUndefined();
    });

    it("AC3: a server ack prompt with no destination company says another company", async () => {
      const { onsend } = setup();
      onsend.mockResolvedValueOnce({
        ok: false,
        code: "CROSS_COMPANY_ACK_REQUIRED",
        status: 409,
        files: [],
        notShareable: [],
        sourceCompany: { uid: "cmp_a", name: "Acme" },
        destinationCompany: null,
      });
      await sendTo(0);
      expect(onsend.mock.calls[0][0].acknowledgeCrossCompany).toBeUndefined();
      expect(q('[data-testid="forward-ack"]')!.textContent).toContain(
        "This sends the message from Acme to another company. Files are not included.",
      );
    });

    const errorCases: Array<[ForwardResult & { ok: false }, string]> = [
      [{ ok: false, code: "NETWORK", status: null, files: [], notShareable: [] }, "retry"],
      [{ ok: false, code: "UNKNOWN", status: 500, files: [], notShareable: [] }, "retry"],
      [{ ok: false, code: "INVALID_FORWARD_OF", status: 400, files: [], notShareable: [] }, "retry"],
      [{ ok: false, code: "INVALID_FILE_ACCESS", status: 400, files: [], notShareable: [] }, "retry"],
      [{ ok: false, code: "CROSS_COMPANY_FORBIDDEN", status: 403, files: [], notShareable: [] }, "pick"],
      [{ ok: false, code: "FORWARD_FILES_NOT_ALLOWED", status: 400, files: [], notShareable: [] }, "omit"],
      [{ ok: false, code: "FORWARD_FILE_SHARE_FORBIDDEN", status: 403, files: [], notShareable: [] }, "omit"],
      [{ ok: false, code: "FORWARD_SOURCE_NOT_FOUND", status: 404, files: [], notShareable: [] }, "close"],
      [{ ok: false, code: "FORWARD_BODY_TOO_LARGE", status: 413, files: [], notShareable: [] }, "close"],
      [{ ok: false, code: "FORWARD_DETAILS_TOO_LARGE", status: 413, files: [], notShareable: [] }, "close"],
      [{ ok: false, code: "FORWARD_PROMPT_TOO_LARGE", status: 413, files: [], notShareable: [] }, "close"],
    ];

    it.each(errorCases)("AC5/AC6: %o shows a plain sentence, a next action, and keeps state", async (result, action) => {
      const { onsend, onclose } = setup();
      onsend.mockResolvedValueOnce(result);
      type(q<HTMLTextAreaElement>('[data-testid="forward-note"]')!, "keep me");
      await sendTo(0);
      const err = q('[data-testid="forward-error"]')!;
      const text = err.textContent ?? "";
      expect(text).not.toContain("{");
      expect(text).not.toMatch(/\b\d{3}\b/);
      expect(text).not.toContain(result.code);
      expect(text).not.toMatch(/[A-Z]{2,}_[A-Z]/);
      expect(q('[data-testid="forward-error-action"]')!.dataset.action).toBe(action);
      // AC6: picker open, destination and note preserved.
      expect(onclose).not.toHaveBeenCalled();
      expect(q('[data-testid="forward-picker"]')).not.toBeNull();
      expect(options()[0].getAttribute("aria-selected")).toBe("true");
      expect(q<HTMLTextAreaElement>('[data-testid="forward-note"]')!.value).toBe("keep me");
    });

    it("AC5: Try again resends the same request", async () => {
      const { onsend, ondone } = setup();
      onsend.mockResolvedValueOnce({ ok: false, code: "NETWORK", status: null, files: [], notShareable: [] });
      type(q<HTMLTextAreaElement>('[data-testid="forward-note"]')!, "again");
      await sendTo(0);
      q<HTMLButtonElement>('[data-testid="forward-error-action"]')!.click();
      await tick();
      await tick();
      expect(onsend).toHaveBeenCalledTimes(2);
      expect(onsend.mock.calls[1][0].note).toBe("again");
      expect(onsend.mock.calls[1][0].destination.id).toBe("dm:prs_ana");
      expect(ondone).toHaveBeenCalled();
    });

    it("AC5: Send without files resends with fileAccess omit", async () => {
      const { onsend } = setup();
      onsend.mockResolvedValueOnce({ ok: false, code: "FORWARD_FILE_SHARE_FORBIDDEN", status: 403, files: [], notShareable: [] });
      await sendTo(0);
      expect(q('[data-testid="forward-error-action"]')!.textContent).toBe("Send without files");
      q<HTMLButtonElement>('[data-testid="forward-error-action"]')!.click();
      await tick();
      expect(onsend.mock.calls[1][0].fileAccess).toBe("omit");
    });

    it("AC5: a failed file grant offers both try again and send without files", async () => {
      const { onsend } = setup();
      onsend.mockResolvedValueOnce({
        ok: false, code: "FORWARD_FILE_GRANT_FAILED", status: 502, files: [], notShareable: [], file: { name: "a.pdf" },
      });
      await sendTo(0);
      expect(q('[data-testid="forward-error-action"]')!.textContent).toBe("Try again");
      q<HTMLButtonElement>('[data-testid="forward-error-omit"]')!.click();
      await tick();
      expect(onsend.mock.calls[1][0].fileAccess).toBe("omit");
    });

    it("AC5: Pick another destination clears the selection and keeps the picker open", async () => {
      const { onsend, onclose } = setup();
      onsend.mockResolvedValueOnce({ ok: false, code: "CROSS_COMPANY_FORBIDDEN", status: 403, files: [], notShareable: [] });
      await sendTo(0);
      q<HTMLButtonElement>('[data-testid="forward-error-action"]')!.click();
      flushSync();
      expect(onclose).not.toHaveBeenCalled();
      expect(options().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
      expect(q('[data-testid="forward-error"]')).toBeNull();
    });

    it("AC5: Close closes the picker", async () => {
      const { onsend, onclose } = setup();
      onsend.mockResolvedValueOnce({ ok: false, code: "FORWARD_SOURCE_NOT_FOUND", status: 404, files: [], notShareable: [] });
      await sendTo(0);
      q<HTMLButtonElement>('[data-testid="forward-error-action"]')!.click();
      expect(onclose).toHaveBeenCalledTimes(1);
    });
  });
});
