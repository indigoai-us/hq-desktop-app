import { describe, expect, it, vi } from "vitest";
import { createDesktopAdapter } from "./index.js";
import { TAURI_CAPABILITIES } from "../capabilities.js";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ channels: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("createDesktopAdapter (composite)", () => {
  it("reports desktop kind and TAURI capabilities", () => {
    const adapter = createDesktopAdapter({
      invoke: vi.fn(),
      baseUrl: "https://hqapi.getindigo.ai",
    });
    expect(adapter.kind).toBe("desktop");
    expect(adapter.capabilities).toEqual(TAURI_CAPABILITIES);
    expect(adapter.isAvailable("localFiles")).toBe(true);
    expect(adapter.isAvailable("agentLaunch")).toBe(true);
    expect(adapter.isAvailable("localWorkMeshCache")).toBe(true);
  });

  it("reads the local work-mesh snapshot through Tauri invoke()", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "read_work_mesh_snapshot") {
        return { projects: [], channels: [], genesis: [] };
      }
      throw new Error(cmd);
    });
    const adapter = createDesktopAdapter({
      invoke,
      baseUrl: "https://hqapi.getindigo.ai",
    });
    const result = await adapter.workMesh.readLocalSnapshot();
    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("read_work_mesh_snapshot", undefined);
  });

  it("routes library to the cloud shelf, not Tauri", async () => {
    const { fetch, calls } = recordingFetch();
    const invoke = vi.fn();
    const adapter = createDesktopAdapter({
      invoke,
      baseUrl: "https://hqapi.getindigo.ai",
      fetch,
    });

    await adapter.library.getRoot();

    expect(invoke).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.includes("/membership/me"))).toBe(
      true,
    );
  });

  it("routes cloud groups (messaging) to the web REST base URL", async () => {
    const { fetch, calls } = recordingFetch();
    const invoke = vi.fn();
    const adapter = createDesktopAdapter({
      invoke,
      baseUrl: "https://hqapi.getindigo.ai",
      fetch,
    });

    await adapter.messaging.listChannels();
    await adapter.messaging.listChannelMembers(
      "chn_01M091YAPDGFBR8C8VZD2917AC",
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(calls[0].url.startsWith("https://hqapi.getindigo.ai")).toBe(true);
    expect(calls[1].url).toBe(
      "https://hqapi.getindigo.ai/v1/notify/channels/chn_01M091YAPDGFBR8C8VZD2917AC/members",
    );
  });

  it("routes local groups (files) through Tauri invoke()", async () => {
    const { fetch, calls } = recordingFetch();
    const invoke = vi.fn(
      async (_cmd: string, _args?: Record<string, unknown>) => [],
    );
    const adapter = createDesktopAdapter({
      invoke,
      baseUrl: "https://hqapi.getindigo.ai",
      fetch,
    });

    await adapter.files.listDir("projects");

    expect(calls).toHaveLength(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe("list_dir");
  });

  it("passes bearer headers to the cloud adapter", async () => {
    const { fetch, calls } = recordingFetch();
    const adapter = createDesktopAdapter({
      invoke: vi.fn(),
      baseUrl: "https://hqapi.getindigo.ai",
      fetch,
      headers: { authorization: "Bearer test-token" },
    });

    await adapter.notifications.fetchNotifications();

    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
  });
});
