// @vitest-environment happy-dom
import { it, expect, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import NotificationsView from './NotificationsView.svelte';
it('explains a legacy DM with no destination instead of silently acknowledging it', async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const onopen = vi.fn();
  const component = mount(NotificationsView, {target: host, props: {onopen, api: {
    fetchNotifications: async () => ({notifications: [{id:'legacy',type:'dm',actorName:'Deacon',body:'Control C received.',targetRef:'/messages',status:'read',createdAt:'2026-09-06T03:36:00Z'}]}),
    ackNotification: async () => {}, readAllNotifications: async () => {}, runNotificationAction: async () => ({}),
  }}});
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('Control C received.'));
    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]') ?? host.querySelector<HTMLElement>('[role="button"]');
    expect(row).toBeTruthy(); row!.click();
    await vi.waitFor(() => expect(host.textContent).toContain('does not include a conversation link'));
    expect(onopen).not.toHaveBeenCalled();
  } finally {await unmount(component); host.remove();}
});

it('loads older notifications on demand and stops offering when the cursor runs out', async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const pages = [
    {notifications: [{id:'n1',type:'dm',actorName:'Ada',body:'first page',targetRef:'/messages',status:'read',createdAt:'2026-09-06T03:36:00Z'}], nextCursor: 'cur-1'},
    {notifications: [{id:'n2',type:'dm',actorName:'Ada',body:'older page',targetRef:'/messages',status:'read',createdAt:'2026-09-05T03:36:00Z'}], nextCursor: null},
  ];
  const fetchNotifications = vi.fn(async (opts: {cursor?: string | null}) => (opts?.cursor ? pages[1] : pages[0]));
  const component = mount(NotificationsView, {target: host, props: {api: {
    fetchNotifications, ackNotification: async () => {}, readAllNotifications: async () => {}, runNotificationAction: async () => ({}),
  }}});
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('first page'));
    const more = host.querySelector<HTMLButtonElement>('[data-testid="notifications-load-more"]');
    expect(more, 'a cursor in the response must offer a way to reach older rows').toBeTruthy();

    more!.click();
    await vi.waitFor(() => expect(host.textContent).toContain('older page'));
    // The first page must still be on screen — this appends, it does not replace.
    expect(host.textContent).toContain('first page');
    // Cursor exhausted, so the control retires rather than fetching nothing.
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="notifications-load-more"]')).toBeNull(),
    );
  } finally {await unmount(component); host.remove();}
});

it('does not offer to load more when the first page is the whole feed', async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const component = mount(NotificationsView, {target: host, props: {api: {
    fetchNotifications: async () => ({notifications: [{id:'only',type:'dm',actorName:'Ada',body:'just this',targetRef:'/messages',status:'read',createdAt:'2026-09-06T03:36:00Z'}], nextCursor: null}),
    ackNotification: async () => {}, readAllNotifications: async () => {}, runNotificationAction: async () => ({}),
  }}});
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('just this'));
    expect(host.querySelector('[data-testid="notifications-load-more"]')).toBeNull();
  } finally {await unmount(component); host.remove();}
});

it('keeps the rows on screen when a page fails, and offers a retry', async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const fetchNotifications = vi.fn(async (opts: {cursor?: string | null}) => {
    if (opts?.cursor) throw new Error('upstream down');
    return {notifications: [{id:'n1',type:'dm',actorName:'Ada',body:'still here',targetRef:'/messages',status:'read',createdAt:'2026-09-06T03:36:00Z'}], nextCursor: 'cur-1'};
  });
  const component = mount(NotificationsView, {target: host, props: {api: {
    fetchNotifications, ackNotification: async () => {}, readAllNotifications: async () => {}, runNotificationAction: async () => ({}),
  }}});
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('still here'));
    host.querySelector<HTMLButtonElement>('[data-testid="notifications-load-more"]')!.click();
    await vi.waitFor(() => expect(host.textContent).toContain("Couldn't load older notifications"));
    // A failed page must not blank the list the reader was reading.
    expect(host.textContent).toContain('still here');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="notifications-load-more"]')!.textContent).toContain('Try again');
  } finally {await unmount(component); host.remove();}
});
