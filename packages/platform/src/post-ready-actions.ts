export const POST_READY_ACTIONS = [
  'open_folder',
  'start_sync',
  'open_cli',
  'invite',
  'close_window',
] as const;

export type PostReadyAction = (typeof POST_READY_ACTIONS)[number];

export const POST_READY_ACTION_EVENT = 'hq:desktop-post-ready-action';

export function dispatchPostReadyAction(
  action: PostReadyAction,
  company?: { uid?: string; slug?: string },
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(POST_READY_ACTION_EVENT, {
    detail: { action, companyUid: company?.uid, companySlug: company?.slug },
  }));
}
