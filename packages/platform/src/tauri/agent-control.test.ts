import { describe, expect, it } from "vitest";

import {
  AGENT_CONTROL_PATHS,
  agentControlFailure,
  agentControlRequestFromFetch,
  createAgentControlApi,
  type AgentControlApi,
} from "../agent-control.js";
import { failure } from "../adapter.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

type Respond = (args?: Record<string, unknown>) => { status: number; body: string };

function makeSync(respond: Respond) {
  const calls: Invocation[] = [];
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return respond(args);
    },
    requestPolicy: { maxAttempts: 1 },
  });
  return { adapter, calls };
}

const UID = "agt_01NOVA";

describe("AGENT_CONTROL_PATHS", () => {
  it("names every contract route under /v1/agents/{uid}/control", () => {
    expect(AGENT_CONTROL_PATHS.control(UID)).toBe("/v1/agents/agt_01NOVA/control");
    expect(AGENT_CONTROL_PATHS.channels(UID)).toBe("/v1/agents/agt_01NOVA/control/channels");
    expect(AGENT_CONTROL_PATHS.channel(UID, "slack")).toBe("/v1/agents/agt_01NOVA/control/channels/slack");
    expect(AGENT_CONTROL_PATHS.routines(UID)).toBe("/v1/agents/agt_01NOVA/control/routines");
    expect(AGENT_CONTROL_PATHS.routine(UID, "r 1")).toBe("/v1/agents/agt_01NOVA/control/routines/r%201");
    expect(AGENT_CONTROL_PATHS.runRoutine(UID, "r1")).toBe("/v1/agents/agt_01NOVA/control/routines/r1/run");
    expect(AGENT_CONTROL_PATHS.persona(UID)).toBe("/v1/agents/agt_01NOVA/control/persona");
    expect(AGENT_CONTROL_PATHS.brain(UID)).toBe("/v1/agents/agt_01NOVA/control/brain");
    expect(AGENT_CONTROL_PATHS.brainModel(UID)).toBe("/v1/agents/agt_01NOVA/control/brain/model");
    expect(AGENT_CONTROL_PATHS.memory(UID)).toBe("/v1/agents/agt_01NOVA/control/brain/memory");
    expect(AGENT_CONTROL_PATHS.memoryEntry(UID, "m/1")).toBe("/v1/agents/agt_01NOVA/control/brain/memory/m%2F1");
    expect(AGENT_CONTROL_PATHS.knowledge(UID, "notes/a b.md")).toBe(
      "/v1/agents/agt_01NOVA/control/brain/knowledge?path=notes%2Fa%20b.md",
    );
  });
});

describe("sync adapter agentControl", () => {
  const cases: Array<[string, (api: AgentControlApi) => Promise<unknown>, string, string, unknown]> = [
    ["getControl", (a) => a.getControl(UID), "GET", AGENT_CONTROL_PATHS.control(UID), null],
    ["listChannels", (a) => a.listChannels(UID), "GET", AGENT_CONTROL_PATHS.channels(UID), null],
    ["updateChannel", (a) => a.updateChannel(UID, "telegram", { enabled: false }), "PATCH", AGENT_CONTROL_PATHS.channel(UID, "telegram"), { enabled: false }],
    ["listRoutines", (a) => a.listRoutines(UID), "GET", AGENT_CONTROL_PATHS.routines(UID), null],
    ["createRoutine", (a) => a.createRoutine(UID, { name: "Brief", schedule: "0 9 * * 1-5", prompt: "Go" }), "POST", AGENT_CONTROL_PATHS.routines(UID), { name: "Brief", schedule: "0 9 * * 1-5", prompt: "Go" }],
    ["updateRoutine", (a) => a.updateRoutine(UID, "r1", { enabled: false }), "PATCH", AGENT_CONTROL_PATHS.routine(UID, "r1"), { enabled: false }],
    ["deleteRoutine", (a) => a.deleteRoutine(UID, "r1"), "DELETE", AGENT_CONTROL_PATHS.routine(UID, "r1"), null],
    ["runRoutine", (a) => a.runRoutine(UID, "r1"), "POST", AGENT_CONTROL_PATHS.runRoutine(UID, "r1"), null],
    ["getPersona", (a) => a.getPersona(UID), "GET", AGENT_CONTROL_PATHS.persona(UID), null],
    ["updatePersona", (a) => a.updatePersona(UID, { instructions: "Be brief." }), "PUT", AGENT_CONTROL_PATHS.persona(UID), { instructions: "Be brief." }],
    ["getBrain", (a) => a.getBrain(UID), "GET", AGENT_CONTROL_PATHS.brain(UID), null],
    ["setModel", (a) => a.setModel(UID, "claude-opus-5-5"), "PATCH", AGENT_CONTROL_PATHS.brainModel(UID), { model: "claude-opus-5-5" }],
    ["createMemory", (a) => a.createMemory(UID, { content: "Likes tea" }), "POST", AGENT_CONTROL_PATHS.memory(UID), { content: "Likes tea" }],
    ["getMemory", (a) => a.getMemory(UID, "m1"), "GET", AGENT_CONTROL_PATHS.memoryEntry(UID, "m1"), null],
    ["updateMemory", (a) => a.updateMemory(UID, "m1", "Likes coffee"), "PUT", AGENT_CONTROL_PATHS.memoryEntry(UID, "m1"), { content: "Likes coffee" }],
    ["deleteMemory", (a) => a.deleteMemory(UID, "m1"), "DELETE", AGENT_CONTROL_PATHS.memoryEntry(UID, "m1"), null],
    ["getKnowledge", (a) => a.getKnowledge(UID, "faq.md"), "GET", AGENT_CONTROL_PATHS.knowledge(UID, "faq.md"), null],
    ["putKnowledge", (a) => a.putKnowledge(UID, "faq.md", "# FAQ"), "PUT", AGENT_CONTROL_PATHS.knowledge(UID, "faq.md"), { content: "# FAQ" }],
    ["deleteKnowledge", (a) => a.deleteKnowledge(UID, "faq.md"), "DELETE", AGENT_CONTROL_PATHS.knowledge(UID, "faq.md"), null],
  ];

  it.each(cases)("%s sends %s to the contract path through hq_pro_fetch", async (_name, run, method, url, body) => {
    const { adapter, calls } = makeSync(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const res = await run(adapter.agentControl!);
    expect(res).toEqual({ ok: true, value: { ok: true } });
    expect(calls).toEqual([
      { cmd: "hq_pro_fetch", args: { url, method, body: body === null ? null : JSON.stringify(body) } },
    ]);
  });

  it("surfaces the server's { error: { code, message } } with the HTTP status", async () => {
    const { adapter } = makeSync(() => ({
      status: 409,
      body: JSON.stringify({ error: { code: "BOX_OFFLINE", message: "The bot's computer is offline." } }),
    }));
    const res = await adapter.agentControl!.updatePersona(UID, { title: "Analyst" });
    expect(res).toMatchObject({ ok: false, reason: "error", code: "BOX_OFFLINE", message: "The bot's computer is offline.", status: 409 });
  });

  it("keeps a read-back mismatch a failure, never a success", async () => {
    const { adapter } = makeSync(() => ({
      status: 502,
      body: JSON.stringify({ error: { code: "READBACK_MISMATCH", message: "The box did not keep the change." } }),
    }));
    const res = await adapter.agentControl!.setModel(UID, "gpt-5.5");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("READBACK_MISMATCH");
  });

  it("falls back to the status code when the body has no error", async () => {
    const { adapter } = makeSync(() => ({ status: 404, body: JSON.stringify({ message: "Not Found" }) }));
    const res = await adapter.agentControl!.getControl(UID);
    expect(res).toMatchObject({ ok: false, code: "http-404", status: 404 });
  });
});

describe("agentControlFailure", () => {
  const fallback = failure("http-500", "PUT /x failed");

  it("reads the nested contract shape", () => {
    expect(agentControlFailure(400, JSON.stringify({ error: { code: "PATH_INVALID", message: "Bad path." } }), fallback)).toEqual({
      ok: false, reason: "error", code: "PATH_INVALID", message: "Bad path.", status: 400,
    });
  });

  it("reads the flat { code, error } shape other hq-pro routes send", () => {
    expect(agentControlFailure(403, JSON.stringify({ code: "FORBIDDEN", error: "Not your bot." }), fallback)).toMatchObject({
      code: "FORBIDDEN", message: "Not your bot.", status: 403,
    });
  });

  it("keeps the fallback for a body that is not JSON", () => {
    expect(agentControlFailure(500, "<html>", fallback)).toMatchObject({ code: "http-500", message: "PUT /x failed", status: 500 });
  });
});

describe("agentControlRequestFromFetch", () => {
  it("builds the same client on a plain REST transport", async () => {
    const seen: Array<{ path: string; method: string; body?: string }> = [];
    const api = createAgentControlApi(
      agentControlRequestFromFetch(async (path, init) => {
        seen.push({ path, method: init.method, body: init.body });
        if (init.method === "DELETE") return { status: 204, text: async () => "" };
        if (path.endsWith("/persona")) {
          return { status: 503, text: async () => JSON.stringify({ error: { code: "BOX_OFFLINE", message: "Offline." } }) };
        }
        return { status: 200, text: async () => JSON.stringify([{ id: "r1" }]) };
      }),
    );
    expect(await api.listRoutines(UID)).toEqual({ ok: true, value: [{ id: "r1" }] });
    expect(await api.deleteRoutine(UID, "r1")).toEqual({ ok: true, value: null });
    expect(await api.getPersona(UID)).toMatchObject({ ok: false, code: "BOX_OFFLINE", message: "Offline.", status: 503 });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /v1/agents/agt_01NOVA/control/routines",
      "DELETE /v1/agents/agt_01NOVA/control/routines/r1",
      "GET /v1/agents/agt_01NOVA/control/persona",
    ]);
  });

  it("turns a thrown transport into a network failure", async () => {
    const api = createAgentControlApi(agentControlRequestFromFetch(async () => { throw new Error("socket closed"); }));
    expect(await api.getBrain(UID)).toMatchObject({ ok: false, code: "network" });
  });
});
