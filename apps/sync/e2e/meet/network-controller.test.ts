/** Command boundary mocks only. No host network rules are executed by this suite. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withNetworkProfile, shapingArguments, type NetworkScope, type NetworkCommand } from './network-controller';
import { collectNativeDiagnostics } from './webdriver-driver';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'meet-net-unit-'));
  const scope: NetworkScope = { namespace: 'hq-meet-0123456789abcdef', runId: '0123456789abcdef', deviceId: 'a', auditPath: join(root,'audit.jsonl') };
  const calls: string[][] = [], states = new Map<string,string[]>();
  let traffic = false, failAdd = false, failCleanup = false, unowned = false;
  const command: NetworkCommand = async args => {
    calls.push(args);
    if (args.includes('-j')) return JSON.stringify(['uplink','guest'].map(ifname => ({ ifname, linkinfo: { info_kind: 'veth' }, ifalias: unowned ? 'production' : `hq-meet:${scope.runId}:a:${ifname}` })));
    const iface = args[args.indexOf('dev') + 1];
    if (args.includes('add') || args.includes('change')) { if (failAdd) throw new Error('injected add failure'); states.set(iface,args); return ''; }
    if (args.includes('del')) { if (failCleanup) throw new Error('injected cleanup failure'); states.delete(iface); return ''; }
    const state = states.get(iface);
    if (!state) return 'qdisc noqueue 0: root refcnt 2\n';
    const val = (name: string) => state[state.indexOf(name)+1];
    return `qdisc netem 712: root refcnt 2 limit 1000 delay ${val('delay')} ${state[state.indexOf('delay')+2]} loss ${val('loss')} rate ${val('rate').replace('mbit','Mbit')}\n Sent ${traffic ? 100 : 0} bytes 1 pkt\n`;
  };
  return { root, scope, calls, command, states, setTraffic() { traffic = true; }, failAdd() { failAdd = true; }, failCleanup() { failCleanup = true; }, unowned() { unowned = true; } };
}
describe('isolated namespace controller (mocked commands)', () => {
  it('derives only namespace-scoped 2/10 Mbps constrained rules', () => {
    const scope = { namespace: 'hq-meet-0123456789abcdef', runId: '0123456789abcdef', deviceId: 'a', auditPath: '/tmp/audit' };
    expect(shapingArguments(scope,'constrained','uplink','add')).toEqual(['netns','exec',scope.namespace,'tc','qdisc','add','dev','uplink','root','handle','712:','netem','limit','1000','delay','75ms','30ms','loss','2%','rate','2mbit']);
    expect(shapingArguments(scope,'constrained','guest','add').at(-1)).toBe('10mbit');
    expect(() => shapingArguments({ ...scope, namespace: 'default' },'direct','guest','add')).toThrow('scope');
  });
  it('requires observed traffic, preserves audit and verifies cleanup', async () => {
    const f = await fixture(); try {
      const result = await withNetworkProfile({ scope:f.scope,profile:'constrained',durationMs:30000 },async c => { c.collectionStarted(); f.setTraffic(); return 'captured'; },f.command);
      expect(result.result).toBe('captured'); expect(result.networkArtifact.status).toBe('verified-and-cleaned'); expect(f.states.size).toBe(0);
      const audit = await readFile(f.scope.auditPath,'utf8'); expect(audit).toContain('traffic-verified'); expect(audit).toContain('cleanup-verified');
    } finally { await rm(f.root,{recursive:true,force:true}); }
  });
  it('cleans up on capture failure and on ambiguous application failure', async () => {
    for (const addFailure of [false,true]) {
      const f = await fixture(); try {
        if (addFailure) f.failAdd();
        await expect(withNetworkProfile({scope:f.scope,profile:'constrained',durationMs:30000},async () => { throw new Error('capture failed'); },f.command)).rejects.toThrow(addFailure ? 'add failure' : 'capture failed');
        expect(f.calls.some(a => a.includes('del'))).toBe(true); expect(f.states.size).toBe(0);
      } finally { await rm(f.root,{recursive:true,force:true}); }
    }
  });
  it('fails closed for unowned links and failed cleanup', async () => {
    const f = await fixture(); try {
      f.unowned(); await expect(withNetworkProfile({scope:f.scope,profile:'constrained',durationMs:30000},async()=>{},f.command)).rejects.toThrow('unowned');
      expect(f.calls.some(a=>a.includes('add'))).toBe(false);
    } finally { await rm(f.root,{recursive:true,force:true}); }
    const g = await fixture(); try {
      g.failCleanup(); await expect(withNetworkProfile({scope:g.scope,profile:'constrained',durationMs:30000},async c=>{c.collectionStarted();g.setTraffic();},g.command)).rejects.toThrow('cleanup failed');
    } finally { await rm(g.root,{recursive:true,force:true}); }
  });
  it('applies and restores a timed network disconnect with verifiable audit events', async () => {
    const f = await fixture(); const waits: number[] = []; try {
      await withNetworkProfile({scope:f.scope,profile:'sleep-reconnect',durationMs:30000},async c=>{c.collectionStarted();f.setTraffic();},f.command,async ms=>{waits.push(ms);});
      expect(waits).toEqual([10000,3000]); expect(f.calls.filter(a=>a.includes('100%'))).toHaveLength(2);
      const audit = await readFile(f.scope.auditPath,'utf8'); expect(audit).toContain('disconnect-verified'); expect(audit).toContain('network-return-verified'); expect(f.states.size).toBe(0);
    } finally { await rm(f.root,{recursive:true,force:true}); }
  });
  it('rejects constrained/reconnect collection without an applied controller', async () => {
    for (const profile of ['constrained','sleep-reconnect'] as const) await expect(collectNativeDiagnostics({ endpoints: [], profile, durationMs:30000, speechWav:new Uint8Array(44) })).rejects.toThrow('requires verified');
  });
});
