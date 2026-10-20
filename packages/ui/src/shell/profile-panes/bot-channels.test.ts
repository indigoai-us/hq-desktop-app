import { describe, expect, it } from 'vitest';
import { channelRows } from './bot-channels.js';

describe('bot channel status', () => {
  it('shows supported defaults without inventing a connection status', () => {
    const rows = channelRows(null, null, false);
    expect(rows.map(row => row.id)).toEqual(['slack', 'telegram']);
    expect(rows.every(row => row.state === 'unknown' && !row.canConnect)).toBe(true);
  });
  it('requires inbound capability before Slack is connected', () => {
    expect(channelRows({ agent: { channels: { slack: {} } } }, null, true)[0].state).toBe('pending');
    expect(channelRows({ agent: { channelDiagnostics: { slack: { inboundCapability: 'socket-mode' } } } }, null, true)[0].state).toBe('connected');
  });
  it('reads runtime statuses and includes discovered channels', () => {
    const rows = channelRows(null, { box: { platforms: [{ name: 'Telegram', state: 'connected' }, { name: 'WhatsApp', state: 'disconnected' }, { name: 'Matrix', state: 'pending' }] } }, false);
    expect(rows.map(row => row.state)).toEqual(['unknown', 'connected', 'pending']);
    expect(rows[2].id).toBe('matrix');
    expect(rows.some(row => row.id === 'whatsapp')).toBe(false);
  });
  it('does not present cached connections as live', () => {
    expect(channelRows(null, { boxFreshness: { source: 'cache' }, box: { platforms: [{ name: 'Telegram', state: 'connected' }] } }, false)[1].state).toBe('unknown');
  });
  it('enables Slack setup only with a successful status read and supported adapter', () => {
    expect(channelRows({}, null, true)[0]).toMatchObject({ state: 'not-connected', canConnect: true });
    expect(channelRows(null, null, true)[0].canConnect).toBe(false);
  });
});
