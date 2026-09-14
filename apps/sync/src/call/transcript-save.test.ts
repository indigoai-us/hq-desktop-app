import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {CallWindowHandle} from './bootstrap';
import type {TranscriptRow} from './live-transcript';
const api=vi.hoisted(()=>({preflight:vi.fn(),liveTranscript:vi.fn()}));
vi.mock('@hq/platform',()=>({createSyncPlatformAdapter:()=>({calls:api})}));
import {createTranscriptSave,createTranscriptOutboxDrain,type SaveInvoke,type OutboxRow} from './transcript-save';
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const sourceId='native-'+'a'.repeat(64);
const receipt={saved:true,sourceId,sourceRef:{key:`sources/meetings/${sourceId}.md`},revision:1,updatedAt:1000};
const row:TranscriptRow={kind:'transcript',version:1,conversationId:'conversation',streamId:'stream',segmentId:'segment',revision:1,startMs:0,endMs:10,text:'speech',final:true,personUid:'person',deviceId:'device'};
function fixture(){
 let auth={accountId:'account',generation:1,status:'active'};const disk:OutboxRow[]=[];const operations:string[]=[];
 const begin=vi.fn(async()=>({conversationId:'conversation',uploadToken:'token',expiresAt:Date.now()+100000,sourceId}));
 const invoke=vi.fn(async(command:string,args?:Record<string,unknown>)=>{
  operations.push(command);
  if(command==='get_auth_session')return {...auth};
  if(command==='meet_transcript_outbox_read')return {rows:disk.map(r=>({...r})),hasMore:false,totalCount:disk.length};
  if(command==='meet_transcript_outbox_enqueue'){const value=args!.row as OutboxRow;const i=disk.findIndex(r=>r.segmentId===value.segmentId);if(i<0)disk.push(value);else disk[i]=value;return {};}
  if(command==='meet_transcript_outbox_ack'){disk.splice(0);return {};}
  return {};
 });
 const handle={target:{companyUid:'company',roomId:'room',callId:'call',epoch:1,self:{personUid:'person',deviceId:'device'}},beginTranscriptSave:begin} as unknown as CallWindowHandle;
 return {invoke:invoke as unknown as SaveInvoke,spy:invoke,handle,disk,operations,begin,switchAccount:()=>{auth={accountId:'other',generation:2,status:'active'};},revoke:()=>{auth.status='signed-out';}};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1000000);api.preflight.mockResolvedValue({ok:true});api.liveTranscript.mockResolvedValue({ok:true,value:receipt});});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.clearAllMocks();});
describe('transcript durable save',()=>{
 it('durably enqueues before sending and acknowledges only after server acceptance',async()=>{
  const f=fixture();let finish!:(r:unknown)=>void;api.liveTranscript.mockImplementation(()=>new Promise(r=>finish=r));
  const save=createTranscriptSave(f.invoke,f.handle,()=>{});await flush();await save.enqueue(row);await flush();
  expect(f.disk).toHaveLength(1);expect(api.liveTranscript).toHaveBeenCalled();expect(f.operations).not.toContain('meet_transcript_outbox_ack');
  finish({ok:true,value:receipt});await flush();expect(f.disk).toEqual([]);expect(f.operations.indexOf('meet_transcript_outbox_enqueue')).toBeLessThan(f.operations.indexOf('meet_transcript_outbox_ack'));save.dispose();
 });
 it('cannot upload while the native durable enqueue is still pending',async()=>{
  const f=fixture();let release!:()=>void;const persisted=new Promise<void>(resolve=>release=resolve);
  const invoke:SaveInvoke=async<T>(command:string,args?:Record<string,unknown>)=>{if(command==='meet_transcript_outbox_enqueue')await persisted;return f.invoke<T>(command,args);};
  const save=createTranscriptSave(invoke,f.handle,()=>{});await flush();const enqueued=save.enqueue(row);await flush();
  expect(api.liveTranscript).not.toHaveBeenCalled();expect(f.disk).toEqual([]);release();await enqueued;await flush();expect(api.liveTranscript).toHaveBeenCalled();save.dispose();
 });
 it('retains failed appends and drains on reconnect',async()=>{
  const f=fixture();api.liveTranscript.mockResolvedValue({ok:false});const publish=vi.fn();const save=createTranscriptSave(f.invoke,f.handle,publish);await flush();save.prepare('conversation','stream');await flush();await save.enqueue(row);await flush();expect(f.disk).toHaveLength(1);expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({status:'error',detail:expect.stringContaining('kept on this device')}));
  api.liveTranscript.mockResolvedValue({ok:true,value:receipt});await vi.advanceTimersByTimeAsync(5000);expect(f.disk).toEqual([]);save.dispose();
 });
 it.each([{...row,conversationId:'personal-private'},{...row,personUid:'other'},{...row,deviceId:'other'},{...row,final:false}])('never queues personal, other-speaker, or interim text',async invalid=>{
  const f=fixture();const save=createTranscriptSave(f.invoke,f.handle,()=>{});await flush();await save.enqueue(invalid);await flush();expect(f.disk).toEqual([]);expect(f.begin).not.toHaveBeenCalled();save.dispose();
 });
 it('refuses new disk writes and authority requests after account change',async()=>{
  const f=fixture();const save=createTranscriptSave(f.invoke,f.handle,()=>{});await flush();f.switchAccount();await save.enqueue(row);await flush();expect(f.disk).toEqual([]);expect(f.begin).not.toHaveBeenCalled();save.dispose();
 });
 it('retains a server-accepted row if the account becomes inactive before disk acknowledgement',async()=>{
  const f=fixture();f.disk.push({...row,companyUid:'company',roomId:'room',callId:'call',epoch:1,uploadToken:'token',expiresAt:Date.now()+100000});
  let finish!:(r:unknown)=>void;api.liveTranscript.mockImplementation(()=>new Promise(r=>finish=r));const drain=createTranscriptOutboxDrain(f.invoke);await flush();f.revoke();finish({ok:true,value:receipt});await flush();expect(f.disk).toHaveLength(1);drain.dispose();
 });
});
