/** Whether the conversation rail has completed a successful first paint. */

export function shouldReportShellReady(state: {
  loading: boolean;
  loadError: string | null;
  firstRefreshSettled: boolean;
  conversationCount: number;
}): boolean {
  if (state.loadError) return false;
  if (state.conversationCount > 0) return true;
  if (!state.firstRefreshSettled || state.loading) return false;
  return true;
}
