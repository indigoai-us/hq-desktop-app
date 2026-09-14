import { describe, expect, it, vi } from "vitest";
import { TauriPlatformAdapter } from "./index";
import { createSyncPlatformAdapter } from "./sync-adapter";
import { WebPlatformAdapter } from "../web/index";

/**
 * The Idea Board reaches the native capture commands through the adapter and
 * nowhere else — `packages/ui` never imports `@tauri-apps/api`. These lock the
 * wire names, because a typo here is invisible until a user clicks the tab
 * (see `reveal_in_finder`, which was wrong for months).
 */

function syncAdapter(invoke: ReturnType<typeof vi.fn>) {
  return createSyncPlatformAdapter({
    invoke,
    fetch: (() => {
      throw new Error("no fetch");
    }) as never,
  } as never);
}

const CASES: Array<{
  name: string;
  run: (ideas: TauriPlatformAdapter["ideas"]) => Promise<unknown>;
  cmd: string;
  args: Record<string, unknown> | undefined;
}> = [
  {
    name: "listCaptures",
    run: (i) => i.listCaptures(),
    cmd: "ideas_list_captures",
    args: undefined,
  },
  {
    name: "setKind",
    run: (i) => i.setKind("cap_1", "x_post", "extracted"),
    cmd: "ideas_set_kind",
    args: { id: "cap_1", kind: "x_post", status: "extracted" },
  },
  {
    name: "correctKind",
    run: (i) => i.correctKind("cap_1", "quote"),
    cmd: "ideas_correct_kind",
    args: { id: "cap_1", kind: "quote" },
  },
  {
    name: "setNote",
    run: (i) => i.setNote("cap_1", "hello"),
    cmd: "ideas_set_note",
    args: { id: "cap_1", note: "hello" },
  },
  {
    name: "setTags",
    run: (i) => i.setTags("cap_1", ["a", "b"]),
    cmd: "ideas_set_tags",
    args: { id: "cap_1", tags: ["a", "b"] },
  },
  {
    name: "moveCapture",
    run: (i) => i.moveCapture("cap_1", "acme"),
    cmd: "ideas_move_capture",
    args: { id: "cap_1", toCompany: "acme" },
  },
  {
    name: "deleteCapture",
    run: (i) => i.deleteCapture("cap_1"),
    cmd: "ideas_delete_capture",
    args: { id: "cap_1" },
  },
  {
    name: "listCompanies",
    run: (i) => i.listCompanies(),
    cmd: "ideas_list_companies",
    args: undefined,
  },
  {
    name: "getSettings",
    run: (i) => i.getSettings(),
    cmd: "ideas_get_settings",
    args: undefined,
  },
  {
    name: "filePreview",
    run: (i) => i.filePreview("/tmp/a.png"),
    cmd: "get_authorized_file_preview",
    args: { path: "/tmp/a.png" },
  },
];

describe("hq_idea_board ideas adapter — Tauri wire names", () => {
  for (const c of CASES) {
    it(`${c.name} invokes ${c.cmd}`, async () => {
      const invoke = vi.fn(async () => null);
      const adapter = new TauriPlatformAdapter({ invoke } as never);
      await c.run(adapter.ideas);
      expect(invoke).toHaveBeenCalledWith(c.cmd, c.args);
    });

    it(`${c.name} invokes ${c.cmd} on the Sync adapter too`, async () => {
      const invoke = vi.fn(async () => null);
      await c.run(syncAdapter(invoke).ideas);
      expect(invoke).toHaveBeenCalledWith(c.cmd, c.args);
    });
  }

  it("never reaches for the unregistered get_authorized_preview", async () => {
    const invoke = vi.fn(async () => null);
    const adapter = new TauriPlatformAdapter({ invoke } as never);
    await adapter.ideas.filePreview("/tmp/a.png");
    expect(
      invoke.mock.calls.map((c) => (c as unknown as string[])[0]),
    ).not.toContain("get_authorized_preview");
  });

  it("surfaces an invoke rejection instead of resolving ok", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("Command ideas_list_captures not found");
    });
    const adapter = new TauriPlatformAdapter({ invoke } as never);
    const res = await adapter.ideas.listCaptures();
    expect(res.ok).toBe(false);
  });
});

describe("hq_idea_board ideas adapter — web", () => {
  it("fails closed on every call so the board shows an error, not an empty board", async () => {
    const web = new WebPlatformAdapter({
      baseUrl: "https://example.invalid",
      getToken: () => "",
      fetch: (async () => {
        throw new Error("no network in this test");
      }) as never,
    } as never);
    for (const c of CASES) {
      const res = (await c.run(web.ideas as never)) as { ok: boolean };
      expect(res.ok).toBe(false);
    }
  });
});
