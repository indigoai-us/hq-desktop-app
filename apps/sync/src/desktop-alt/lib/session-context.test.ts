import { describe, it, expect } from 'vitest';
import { missingInheritedPrefix, type SessionContext } from './session-context';
const history: SessionContext['history'] = { before: null, events: [1, 2, 3].map(receivedAtMs => ({ receivedAtMs, event: { kind: 'userMessage', text: 'again', imageCount: 0 } })) };
const context: SessionContext = { sourceSessionId: 'parent', sourceTitle: 'Parent', startedBy: 'alex@example.test', history };
describe('inherited transcript prefix', () => {
  it('restores all inherited context after replay eviction', () => expect(missingInheritedPrefix(context, [], [])).toEqual(history.events));
  it('does not duplicate a replay that still contains its seed', () => expect(missingInheritedPrefix(context, history.events.map(i => i.event), [1, 2, 3])).toEqual([]));
  it('restores only evicted messages and distinguishes repeated text by time', () => expect(missingInheritedPrefix(context, [history.events[2].event], [3])).toEqual(history.events.slice(0, 2)));
});
