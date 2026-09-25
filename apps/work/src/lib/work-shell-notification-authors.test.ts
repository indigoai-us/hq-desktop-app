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
    await vi.waitFor(()=>expect(desktopAppProps.current?.self).toMatchObject({uid:'prs_ada'}));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function cachedRows(): Array<Record<string, unknown>> {
  return Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)!)
    .filter(key=>key.includes('channel-notifications'))
    .flatMap(key=>JSON.parse(localStorage.getItem(key) || '[]'));
}

async function setupPendingLookup() {
  const native = makeHost([()=>({workspaces:[]})]);
  const original = native.invoke.getMockImplementation()!;
  const lookup = deferred<unknown>();
  const readAll = deferred<unknown>();
  native.invoke.mockImplementation(async(command:string) => {
    if (command === 'fetch_channel') return lookup.promise;
    if (command === 'read_all_notifications') return readAll.promise;
    return original(command);
  });
  const wakes = createChatWakeBus();
  component = mount(Page,{target:host,props:{data:{user:null},runtimeKind:'desktop',invoke:native.invoke as never,listen:native.listen as never,wakes,rosterRetryDelaysMs:[5]}});
  await vi.waitFor(()=>expect(desktopAppProps.current?.self).toMatchObject({uid:'prs_ada'}));
  const api = desktopAppProps.current!.notificationsApi as {
    readAllNotifications(): Promise<void>;
    ackNotification(id:string): Promise<void>;
  };
  const emit = (channelId='chan') => wakes.emit('channel:new-message',{channelId,unread:1,absoluteUnread:true});
  emit();
  await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('fetch_channel',{channelId:'chan',limit:1,cursor:null}));
  return {native, lookup, readAll, api, emit};
}

const incomingMessage = {messages:[{eventId:'incoming',fromPersonUid:'prs_kai',fromDisplayName:'Kai',createdAt:'2026-09-19T12:00:00Z'}]};

describe('notification acknowledgment during sender lookup', () => {
  it('keeps pending activity read when mark-all succeeds before lookup resolves, with no feed rows yet', async () => {
    const {lookup,readAll,api} = await setupPendingLookup();
    const reading = api.readAllNotifications();
    readAll.resolve(null);
    await reading;
    lookup.resolve(incomingMessage);
    await vi.waitFor(()=>expect(cachedRows()).toMatchObject([{actorName:'Kai',status:'read'}]));
  });

  it('marks the resolved row read if lookup completes while mark-all is pending', async () => {
    const {lookup,readAll,api} = await setupPendingLookup();
    const reading = api.readAllNotifications();
    lookup.resolve(incomingMessage);
    await vi.waitFor(()=>expect(cachedRows()).toMatchObject([{status:'unread'}]));
    readAll.resolve(null);
    await reading;
    expect(cachedRows()).toMatchObject([{actorName:'Kai',status:'read'}]);
  });

  it('preserves an individual summary acknowledgment across enrichment', async () => {
    const {lookup,api} = await setupPendingLookup();
    await api.ackNotification('local:channel:chan:summary');
    lookup.resolve(incomingMessage);
    await vi.waitFor(()=>expect(cachedRows()).toMatchObject([{actorName:'Kai',status:'read'}]));
  });

  it('leaves arrivals after mark-all starts unread', async () => {
    const {lookup,readAll,api,emit} = await setupPendingLookup();
    const reading = api.readAllNotifications();
    emit('later');
    lookup.resolve(incomingMessage);
    await vi.waitFor(()=>expect(cachedRows()).toHaveLength(2));
    readAll.resolve(null);
    await reading;
    expect(cachedRows().find(row=>row.targetRef==='/channels/chan')?.status).toBe('read');
    expect(cachedRows().find(row=>row.targetRef==='/channels/later')?.status).toBe('unread');
  });

  it('does not mark a newer summary for the same channel read', async () => {
    const {lookup,readAll,api,emit} = await setupPendingLookup();
    const reading = api.readAllNotifications();
    emit();
    lookup.resolve({messages:[]});
    await vi.waitFor(()=>expect(cachedRows()).toMatchObject([{status:'unread'}]));
    readAll.resolve(null);
    await reading;
    expect(cachedRows()).toMatchObject([{id:'local:channel:chan:summary',status:'unread'}]);
  });

  it('does not apply a read-all snapshot to a replacement summary with the same id', async () => {
    const {lookup,readAll,api,emit} = await setupPendingLookup();
    lookup.resolve({messages:[]});
    await vi.waitFor(()=>expect(cachedRows()).toHaveLength(1));
    const reading = api.readAllNotifications();
    const sequence = Number(desktopAppProps.current!.notificationWakeSeq);
    emit();
    await vi.waitFor(()=>expect(Number(desktopAppProps.current!.notificationWakeSeq)).toBeGreaterThan(sequence));
    readAll.resolve(null);
    await reading;
    expect(cachedRows()).toMatchObject([{id:'local:channel:chan:summary',status:'unread'}]);
  });

  it('keeps activity unread if mark-all fails', async () => {
    const {lookup,readAll,api} = await setupPendingLookup();
    const reading = api.readAllNotifications();
    const failed = expect(reading).rejects.toThrow();
    readAll.reject(new Error('offline'));
    await failed;
    lookup.resolve(incomingMessage);
    await vi.waitFor(()=>expect(cachedRows()).toMatchObject([{actorName:'Kai',status:'unread'}]));
  });

  it('does not lose the unread rollup when our reply becomes the latest message', async () => {
    const {lookup} = await setupPendingLookup();
    lookup.resolve({messages:[{eventId:'my-reply',fromPersonUid:'prs_ada',fromDisplayName:'Ada'}]});
    await vi.waitFor(()=>expect(cachedRows()).toMatchObject([{id:'local:channel:chan:summary',status:'unread',actorName:''}]));
  });
});
