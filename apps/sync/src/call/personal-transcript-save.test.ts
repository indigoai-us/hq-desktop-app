import {afterEach,expect,it,vi} from 'vitest';
import {createPersonalTranscriptSave} from './personal-transcript-save';
import type {CallWindowHandle} from './bootstrap';
import type {SaveInvoke} from './transcript-save';
import type {TranscriptRow} from './live-transcript';
const handle={target:{self:{personUid:'me',deviceId:'device'}}} as CallWindowHandle;
const row={conversationId:'personal-123',streamId:'s',segmentId:'1',revision:1,startMs:0,endMs:1000,text:'A thought',final:true,personUid:'me',deviceId:'device'} as TranscriptRow;
afterEach(()=>vi.restoreAllMocks());
it('writes only personal own-speaker finals locally and reuses exact content when revealing',async()=>{
 const calls:Array<{command:string,args?:Record<string,unknown>}>=[];
 const invoke:SaveInvoke=async<T>(command:string,args?:Record<string,unknown>)=>{calls.push({command,args});return (command==='get_auth_session'?{accountId:'a',generation:1}:{markdownPath:'/personal/sources/meetings/n.md'}) as T;};
 const save=createPersonalTranscriptSave(invoke,handle,()=>{});
 try{
  for(const invalid of [{...row,conversationId:'room'},{...row,personUid:'other'},{...row,final:false}])await save.enqueue(invalid);
  expect(calls.filter(c=>c.command!=='get_auth_session')).toEqual([]);
  await save.enqueue(row);await save.showInVault();
  const writes=calls.filter(c=>c.command==='meet_personal_transcript_project');expect(writes).toHaveLength(2);
  expect(writes[0].args!.projection).toEqual(writes[1].args!.projection);
  expect(writes[0].args).not.toHaveProperty('companyUid');expect(JSON.stringify(writes[0])).toContain('## Transcript');expect(save.hasUnsaved()).toBe(false);
 }finally{save.dispose();}
});
it('retains failed writes for retry and fences account changes',async()=>{
 let accountId='a',fail=true;const project=vi.fn();
 const invoke:SaveInvoke=async<T>(command:string,args?:Record<string,unknown>)=>{if(command==='get_auth_session')return {accountId,generation:1} as T;if(args?.accountId!==accountId)throw new Error('Native account binding rejected');project();if(fail)throw new Error('disk full');return {markdownPath:'/personal/n.md'} as T;};
 const save=createPersonalTranscriptSave(invoke,handle,()=>{});
 try{await save.enqueue(row);expect(save.hasUnsaved()).toBe(true);fail=false;await save.flush();expect(save.hasUnsaved()).toBe(false);accountId='b';await save.enqueue({...row,segmentId:'2'});expect(save.hasUnsaved()).toBe(true);expect(project).toHaveBeenCalledTimes(2);}finally{save.dispose();}
});
it('persists pause/resume/end as revisions of the same personal document',async()=>{
 const writes:Array<{sourceId:string;revision:number;markdown:string;rawJson:string}>=[];
 const invoke:SaveInvoke=async<T>(command:string,args?:Record<string,unknown>)=>{
  if(command==='get_auth_session')return {accountId:'a',generation:1} as T;
  writes.push(args!.projection as typeof writes[number]);return {markdownPath:'/personal/n.md'} as T;
 };
 const save=createPersonalTranscriptSave(invoke,handle,()=>{});
 try{
  await save.enqueue(row);await save.setPaused(true);await save.setPaused(false);await save.end();
  expect(new Set(writes.map(w=>w.sourceId)).size).toBe(1);
  expect(writes.map(w=>w.revision)).toEqual([1,2,3,4]);
  expect(writes[1].markdown).toContain('session_status: "paused"');
  expect(writes[3].markdown).toContain('session_status: "ended"');
  expect(JSON.parse(writes[3].rawJson).provisional).toBe(false);
  await save.showInVault();expect(writes[4]).toEqual(writes[3]);
 }finally{save.dispose();}
});

it('finalizes locally through same-account auth generation changes without refreshing the network',async()=>{
 let generation=1,authReads=0;const writes:Record<string,unknown>[]=[];
 const invoke:SaveInvoke=async<T>(command:string,args?:Record<string,unknown>)=>{
  if(command==='get_auth_session'){authReads++;return {accountId:'a',generation,status:generation===1?'active':'refresh_temporarily_unavailable'} as T;}
  expect(args?.accountId).toBe('a');writes.push(args!);return {markdownPath:'/personal/n.md'} as T;
 };
 const save=createPersonalTranscriptSave(invoke,handle,()=>{});
 try{await save.enqueue(row);generation=2;await save.end();expect(save.hasUnsaved()).toBe(false);expect(authReads).toBe(1);expect(JSON.parse((writes.at(-1)!.projection as {rawJson:string}).rawJson).provisional).toBe(false);}finally{save.dispose();}
});
