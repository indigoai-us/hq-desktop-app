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
