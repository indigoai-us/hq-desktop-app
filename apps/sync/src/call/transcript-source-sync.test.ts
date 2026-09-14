import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {SaveInvoke} from './transcript-save';
const api=vi.hoisted(()=>({preflight:vi.fn(),liveTranscript:vi.fn(),listWorkspaces:vi.fn()}));
vi.mock('@hq/platform',()=>({createSyncPlatformAdapter:()=>({calls:api,identity:api})}));
import {createTranscriptSourceSync} from './transcript-source-sync';
const sourceId='native-'+'a'.repeat(64);
const projection={sourceId,revision:1,updatedAt:1000,markdown:'---\nchannel: meeting\n---\n## Transcript',raw:{segments:[]}};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(){let auth={accountId:'account',generation:1,status:'active'};const project=vi.fn(async(_args?:Record<string,unknown>)=>({}));const invoke=vi.fn(async(command:string,args?:Record<string,unknown>)=>command==='get_auth_session'?{...auth}:project(args));return {invoke:invoke as unknown as SaveInvoke,project,switchAccount:()=>{auth={accountId:'other',generation:2,status:'active'};}};}
beforeEach(()=>{vi.useFakeTimers();api.preflight.mockResolvedValue({ok:true});api.listWorkspaces.mockResolvedValue({ok:true,value:[{cloudUid:'company',syncEnabled:true,hasLocalFolder:true}]});api.liveTranscript.mockImplementation(async op=>({ok:true,value:op==='list'?{documents:[{sourceId,revision:1,updatedAt:1000}],cursor:null}:projection}));});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.resetAllMocks();});
describe('authorized transcript source sync',()=>{
 it('only queries companies with enabled sync and a local folder',async()=>{
  api.listWorkspaces.mockResolvedValue({ok:true,value:[{cloudUid:'disabled',syncEnabled:false,hasLocalFolder:true},{cloudUid:'remote',syncEnabled:true,hasLocalFolder:false},{cloudUid:'company',syncEnabled:true,hasLocalFolder:true}]});
  const f=fixture();const sync=createTranscriptSourceSync(f.invoke);await flush();expect(api.liveTranscript.mock.calls.map(c=>c[1].companyUid)).toEqual(['company','company']);expect(f.project).toHaveBeenCalledOnce();sync.dispose();
 });
 it('materializes authorized projection and skips the already-written revision',async()=>{
  const f=fixture();const sync=createTranscriptSourceSync(f.invoke);await flush();await sync.sync();expect(f.project).toHaveBeenCalledOnce();expect(f.project.mock.calls[0][0]).toEqual({accountId:'account',companyUid:'company',projection:{sourceId,revision:1,accessRevision:0,markdown:projection.markdown,rawJson:JSON.stringify(projection.raw)}});expect(api.liveTranscript.mock.calls.filter(c=>c[0]==='read')).toHaveLength(1);sync.dispose();
 });
 it('retries the same revision after disk failure',async()=>{
  const f=fixture();f.project.mockRejectedValueOnce(new Error('disk unavailable'));const sync=createTranscriptSourceSync(f.invoke);await flush();await sync.sync();expect(f.project).toHaveBeenCalledTimes(2);sync.dispose();
 });
 it('checks the current account after reading remote bytes and before local writes',async()=>{
  const f=fixture();api.liveTranscript.mockImplementation(async op=>{if(op==='read'){f.switchAccount();return {ok:true,value:projection};}return {ok:true,value:{documents:[{sourceId,revision:1}]}};});
  const sync=createTranscriptSourceSync(f.invoke);await flush();expect(f.project).not.toHaveBeenCalled();sync.dispose();
 });
 it.each([{...projection,sourceId:'native-'+'b'.repeat(64)},{...projection,revision:0},{...projection,markdown:null},{...projection,raw:undefined}])('ignores malformed or mismatched read projection',async bad=>{
  api.liveTranscript.mockImplementation(async op=>({ok:true,value:op==='list'?{documents:[{sourceId,revision:1}]}:bad}));const f=fixture();const sync=createTranscriptSourceSync(f.invoke);await flush();expect(f.project).not.toHaveBeenCalled();sync.dispose();
 });
 it('does not materialize after disposal while read is in flight',async()=>{
  let finish!:(r:unknown)=>void;api.liveTranscript.mockImplementation(async op=>op==='list'?{ok:true,value:{documents:[{sourceId,revision:1}]}}:new Promise(r=>finish=r));
  const f=fixture();const sync=createTranscriptSourceSync(f.invoke);await flush();sync.dispose();finish({ok:true,value:projection});await flush();expect(f.project).not.toHaveBeenCalled();
 });
});

it('refreshes an expanded authorized view even when the source revision is unchanged',async()=>{
 let accessRevision=1;
 api.liveTranscript.mockImplementation(async op=>({ok:true,value:op==='list'?{documents:[{sourceId,revision:1,projectionRevision:String(accessRevision),accessRevision}]}:{...projection,projectionRevision:String(accessRevision),accessRevision}}));
 const f=fixture();const sync=createTranscriptSourceSync(f.invoke);await flush();
 accessRevision=2;await sync.sync();expect(f.project).toHaveBeenCalledTimes(2);
 expect(f.project.mock.calls[1][0]).toMatchObject({projection:{revision:1,accessRevision:2}});sync.dispose();
});
