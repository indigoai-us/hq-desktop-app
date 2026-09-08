/** Native WebDriver calls are external boundary fakes, never native transport evidence. */
import { describe, expect, it } from 'vitest';
import { establishNativeConnections, exchangeIce, type ProbeClient } from './webdriver-driver';
function fixture(connect = true) {
  const log: string[] = [], received: unknown[][] = [[],[]];
  const queues: unknown[][] = [[],[]];
  const clients: ProbeClient[] = [0,1].map(i=>({ async call(method, ...args) {
    log.push(`${i}:${method}`);
    if (method === 'offer' || method === 'answer') return { description:{type:method,sdp:'PRIVATE_SDP'} };
    if (method === 'drainIce') return queues[i].splice(0);
    if (method === 'addIce') { received[i].push(...args[1] as unknown[]); return; }
    if (method === 'connection') return { state:connect && received[i].length ? 'connected':'connecting',channelState:connect && received[i].length?'open':'connecting',errors:[] };
    return;
  } }));
  return {clients,log,received,queues,endpoints:[{id:'a'},{id:'b'}]};
}
describe('bounded trickle ICE orchestration',()=>{
  it('exchanges SDP before gathering ends, forwards sixteen late candidates, then requires connection',async()=>{
    const f=fixture(); let time=0;
    await establishNativeConnections(f.clients,f.endpoints,{},new AbortController().signal,{now:()=>time,wait:async()=>{
      time+=100;
      for(let i=0;i<2;i++) f.queues[i].push(...Array.from({length:16},(_,n)=>({candidate:`PRIVATE_${i}_${n}`})));
    }});
    expect(f.log.slice(0,3)).toEqual(['0:offer','1:answer','0:acceptAnswer']);
    expect(f.received.map(r=>r.length)).toEqual([16,16]); expect(time).toBe(100);
    await exchangeIce(f.clients,f.endpoints); expect(f.received.map(r=>r.length)).toEqual([16,16]);
  });
  it('never accepts SDP or candidate exchange as connection readiness',async()=>{
    const f=fixture(false); let time=0;
    await expect(establishNativeConnections(f.clients,f.endpoints,{},new AbortController().signal,{now:()=>time,wait:async()=>{time+=10000;}})).rejects.toThrow('deadline');
    expect(time).toBe(20000);
  });
  it('rejects cancellation and oversized queues without echoing candidate content',async()=>{
    const f=fixture(); const abort=new AbortController();abort.abort();
    await expect(establishNativeConnections(f.clients,f.endpoints,{},abort.signal)).rejects.toThrow('cancelled'); expect(f.log).toEqual([]);
    f.queues[0].push(...Array(257).fill({candidate:'PRIVATE'}));
    await expect(exchangeIce(f.clients,f.endpoints)).rejects.toThrow('invalid bounded ICE queue');
    expect(f.received[1]).toEqual([]);
  });
});
