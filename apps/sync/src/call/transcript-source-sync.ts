import { createSyncPlatformAdapter, type Json } from '@hq/platform';
import type { SaveInvoke } from './transcript-save';
import { SERVICE_EVIDENCE, BUNDLED_EVIDENCE_MAX_AGE_MS } from './service-evidence';
interface SourceDocument {sourceId:string;revision:number;updatedAt:number;projectionRevision?:string;accessRevision?:number}
interface Projection extends SourceDocument {markdown:string;raw:Json}
interface Auth {accountId:string|null;generation:number;status:string}

/** Authorized native source projections have their own read-only vault route. */
export function createTranscriptSourceSync(invoke:SaveInvoke) {
  const adapter=createSyncPlatformAdapter({invoke,fetch:(()=>{throw new Error('Native transport required');}) as typeof fetch});
  const ready=adapter.calls.preflight(SERVICE_EVIDENCE,{maxAgeMs:BUNDLED_EVIDENCE_MAX_AGE_MS});
  const revisions=new Map<string,string>();
  const cursors=new Map<string,string>();
  let busy=false;let disposed=false;let accountKey='';
  async function sync(){
    if(busy||disposed)return;busy=true;
    try{
      if(!(await ready).ok)return;
      const auth=await invoke<Auth>('get_auth_session');
      if(!auth.accountId || auth.status!=='active')return;
      const nextKey=`${auth.accountId}/${auth.generation}`;
      if(accountKey!==nextKey){accountKey=nextKey;revisions.clear();cursors.clear();}
      const workspaces=await adapter.identity.listWorkspaces();
      if(!workspaces.ok || !Array.isArray(workspaces.value))return;
      const companies=new Set(workspaces.value.flatMap(value=>{
        const workspace=value as {cloudUid?:unknown;syncEnabled?:boolean;hasLocalFolder?:boolean};
        return typeof workspace?.cloudUid==='string' && workspace.syncEnabled===true && workspace.hasLocalFolder===true ? [workspace.cloudUid] : [];
      }));
      for(const companyUid of companies){
        let cursor:string|undefined=cursors.get(companyUid);
        for(let page=0;page<20 && !disposed;page++){
          const listing=await adapter.calls.liveTranscript('list',{version:'hq-meet/1',companyUid,...cursor?{cursor}:{}});
          if(!listing.ok)break;
          const data=listing.value as unknown as {documents:SourceDocument[];cursor?:string|null};
          if(!Array.isArray(data?.documents))break;
          for(const doc of data.documents){
            if(disposed)return;
            if(!/^native-[a-f0-9]{64}$/.test(doc.sourceId) || !Number.isSafeInteger(doc.revision))continue;
            const key=`${companyUid}/${doc.sourceId}`;
            if(revisions.get(key)===`${doc.revision}/${doc.projectionRevision??''}`)continue;
            const response=await adapter.calls.liveTranscript('read',{version:'hq-meet/1',companyUid,sourceId:doc.sourceId});
            if(!response.ok)continue;
            const projection=response.value as unknown as Projection;
            if(!projection || projection.sourceId!==doc.sourceId || !projection.raw || typeof projection.raw!=='object' || Array.isArray(projection.raw) || typeof projection.markdown!=='string' || !Number.isSafeInteger(projection.revision) || projection.revision<doc.revision)continue;
            const current=await invoke<Auth>('get_auth_session');
            if(disposed || current.accountId!==auth.accountId || current.generation!==auth.generation || current.status!=='active')return;
            try{
              await invoke('meet_transcript_project',{accountId:auth.accountId,companyUid,
                projection:{sourceId:projection.sourceId,revision:projection.revision,accessRevision:projection.accessRevision??0,markdown:projection.markdown,rawJson:JSON.stringify(projection.raw)}});
              revisions.set(key,`${projection.revision}/${projection.projectionRevision??''}`);
            }catch{/* Preserve local edits and retry transient failures without overwriting them. */}
          }
          if(!data.cursor || data.cursor===cursor){cursors.delete(companyUid);break;}
          cursor=data.cursor;cursors.set(companyUid,cursor);
        }
      }
    }catch{/* API/connection errors do not remove previously saved local files. */}
    finally{busy=false;}
  }
  const timer=setInterval(()=>void sync(),15000);void sync();
  return {sync,dispose(){disposed=true;clearInterval(timer);}};
}
