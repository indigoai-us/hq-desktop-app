// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), calls: [] as string[] }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
import { flushSync, mount, unmount } from 'svelte';
import ChannelView from './ChannelView.svelte';
import roomTasksFixture from './__fixtures__/room-tasks.json';

// The strip only keeps finished tasks for a short while after their last
// event, so re-stamp the captured fixture as "just now" — the shapes are
// what matter here, not the capture time.
const roomTasks = {
  ...roomTasksFixture,
  tasks: roomTasksFixture.tasks.map((t) => ({ ...t, lastEventAt: new Date().toISOString() })),
};

const DEACON = 'agt_01KTX6WQ6SYH3TZGF3DSDRPGGD';
const ROOM = 'chn_01M0VBWPD2SQ41EQV2SACNQ23J';
let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('ChannelView task strip (live payload shapes)', () => {
  it('renders the room task chips from the room-scoped route', async () => {
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      tauri.calls.push(command);
      switch (command) {
        case 'list_channel_members':
          return { members: [
            { channelId: ROOM, personUid: DEACON, displayName: 'Deacon', role: 'member' },
            { channelId: ROOM, personUid: 'per_01CORY', displayName: 'Corey', role: 'owner' },
          ] };
        case 'list_channel_agent_tasks':
          expect(args).toMatchObject({ agentUid: DEACON, channelId: ROOM });
          return roomTasks;
        case 'list_agent_tasks':
          return { agentUid: DEACON, running: { count: 0, tasks: [] }, queued: { count: 0, tasks: [] }, recentTerminal: [] };
        default:
          return { messages: [], items: [], reactions: {}, events: [] };
      }
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(ChannelView, {
      target: host,
      props: { channel: { channelId: ROOM, name: 'work-desktop-dogfood', scope: 'company', companyUid: 'cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG', membership: 'joined' } },
    });
    flushSync();
    for (let i = 0; i < 20 && !host.querySelector('[data-testid="agent-task-strip"]'); i++) { await tick(25); flushSync(); }
    const uniq = [...new Set(tauri.calls)];
    // eslint-disable-next-line no-console
    console.log('INVOKED:', uniq.join(', '));
    const strip = host.querySelector('[data-testid="agent-task-strip"]');
    expect(uniq, 'room task command must be invoked').toContain('list_channel_agent_tasks');
    expect(strip, 'strip must render').not.toBeNull();
    expect(strip!.querySelectorAll('.task-chip').length).toBe(roomTasks.tasks.length);
  });
});
