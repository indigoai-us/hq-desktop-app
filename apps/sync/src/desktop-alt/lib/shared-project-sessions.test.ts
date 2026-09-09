import { expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { sharedRows, loadSharedRows } from './shared-project-sessions';
import { historySessionParam, newSessionParam } from './session-project-links';
import { parseSessionsParam } from '../pages/sessions-route-param';
const row = { sessionId: 'shared-1', channelId: 'chn_project', ownerUid: 'prs_owner', title: 'Plan launch', tool: 'codex', createdAt: '', nextSequence: 1 };
it('uses a read-only route and filters the owner cloud twin', () => {
  const sessions = sharedRows([{ ...row, isOwner: true }, { ...row, sessionId: 'shared-2', isOwner: false }]);
  expect(sessions).toHaveLength(1);
  expect(parseSessionsParam(historySessionParam('indigo', 'launch', sessions[0]))).toEqual({ kind: 'shared', sessionId: 'shared-2', channelId: 'chn_project' });
  expect(parseSessionsParam('shared?channel=chn_project')).toEqual({ kind: 'empty' });
});
it('passes exact channel authority only in the project launch route', () => {
  expect(parseSessionsParam(newSessionParam('indigo', 'launch', 'chn_project'))).toEqual({ kind: 'new', company: 'indigo', project: 'launch', channelId: 'chn_project' });
  const unbound = newSessionParam('indigo', null, 'chn_project');
  expect(parseSessionsParam(unbound)).toEqual({ kind: 'new', company: 'indigo', project: null });
  expect(unbound.startsWith('new?company=indigo')).toBe(true);
  expect(unbound).toContain('draft=');
  expect(unbound).not.toContain('channel=');
});
it('loads all list pages and rejects repeated cursors', async () => {
  invoke.mockResolvedValueOnce({ sessions: [row], nextCursor: 'cursor' }).mockResolvedValueOnce({ sessions: [{ ...row, sessionId: 'shared-2' }], nextCursor: null });
  const link = { project: 'launch', projectName: 'Launch', projectPath: '', channelId: 'chn_project', sessions: [] };
  expect(await loadSharedRows(link)).toHaveLength(2);
  invoke.mockResolvedValue({ sessions: [], nextCursor: 'cursor' });
  await expect(loadSharedRows(link)).rejects.toThrow('repeated page');
});
