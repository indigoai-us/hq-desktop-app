// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktopAppProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("svelte", async () => {
  // @ts-expect-error happy-dom tests need Svelte's client runtime.
  return await import("../../node_modules/svelte/src/index-client.js");
});

vi.mock("@hq/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hq/ui")>();
  return {
    ...actual,
    DesktopApp: (_anchor: Node, props: Record<string, unknown>) => {
      desktopAppProps.current = props;
    },
  };
});

vi.mock("$lib/hq-pro-client.js", () => ({
  configureHqProApiUrl: vi.fn(),
  hqProFetch: vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
  hqProApiUrl: vi.fn(() => "https://hq-pro.test"),
  redirectToSigninWithCallback: vi.fn(),
}));

vi.mock("$lib/mesh-runtime", () => ({
  startWebMeshForAdapter: vi.fn(() => null),
}));

import { mount, unmount } from "svelte";
import { createChatWakeBus } from "@hq/ui";
import Page from "./WorkShell.svelte";

type NativeHandler = (event: { payload: unknown }) => void;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function makeHost(
  rosterResponses: Array<() => unknown>,
  whoamiResponses: Array<() => unknown> = [],
) {
  const handlers = new Map<string, NativeHandler[]>();
  const listCalls = { count: 0 };
  const whoamiCalls = { count: 0 };
  const invoke = vi.fn(async (command: string) => {
    switch (command) {
      case "get_auth_session":
        return { accountId: "acct_ada", generation: 1, status: "active" };
      case "get_auth_state":
        return { authenticated: true, accountId: "acct_ada", email: "ada@example.com" };
      case "whoami": {
        whoamiCalls.count += 1;
        const scripted = whoamiResponses.shift();
        if (scripted) return scripted();
        return { personUid: "prs_ada", email: "ada@example.com", displayName: "Ada" };
      }
      case "list_syncable_workspaces": {
        listCalls.count += 1;
        // The last scripted response is sticky, so a retry after the script
        // ends sees the same outcome instead of an accidental empty success.
        const next =
          rosterResponses.length > 1 ? rosterResponses.shift() : rosterResponses[0];
        return next ? next() : { workspaces: [] };
      }
      default:
        return null;
    }
  });
  const listen = vi.fn(async (event: string, handler: NativeHandler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return () => {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    };
  });
  function emit(event: string, payload: unknown): void {
    for (const handler of handlers.get(event) ?? []) handler({ payload });
  }
  return { invoke, listen, emit, listCalls, whoamiCalls, handlers };
}

beforeEach(() => {
  desktopAppProps.current = null;
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});


describe('WorkShell native notification authors', () => {
  it('reconciles a count-only native wake before persisting a named notification', async () => {
    const native = makeHost([()=>({workspaces:[]})]);
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation(async(command:string) => command === 'fetch_channel'
      ? {messages:[{eventId:'evt_actual',fromPersonUid:'prs_kai',fromDisplayName:'Kai',createdAt:'2026-09-19T12:00:00Z'}]}
      : original(command));
    const wakes = createChatWakeBus();
    component = mount(Page,{target:host,props:{data:{user:null},runtimeKind:'desktop',invoke:native.invoke as never,listen:native.listen as never,wakes,rosterRetryDelaysMs:[5]}});
    await vi.waitFor(()=>expect(native.whoamiCalls.count).toBeGreaterThan(0));
    await new Promise(resolve=>setTimeout(resolve,20));
    wakes.emit('channel:new-message',{channelId:'chan',unread:2,absoluteUnread:true});
    await vi.waitFor(()=>{
      const cache = Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)!).filter(key=>key.includes('channel-notifications')).map(key=>localStorage.getItem(key)).join('');
      expect(cache).toContain('Kai');
      expect(cache).toContain('evt_actual');
      expect(cache).not.toContain('Someone');
    });
    expect(native.invoke).toHaveBeenCalledWith('fetch_channel',{channelId:'chan',limit:1,cursor:null});
  });
});
