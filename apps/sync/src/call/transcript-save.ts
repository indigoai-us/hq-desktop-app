import type { CallWindowHandle } from './bootstrap';
import type { TranscriptRow } from './live-transcript';
import { createSyncPlatformAdapter, type Json } from '@hq/platform';
import { BUNDLED_EVIDENCE_MAX_AGE_MS, SERVICE_EVIDENCE } from './service-evidence';

export type SaveInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export interface OutboxRow {
  companyUid: string; personUid: string; roomId: string; callId: string; epoch: number;
  conversationId: string; streamId: string; segmentId: string; revision: number;
  startMs: number; endMs: number; text: string; deviceId: string;
  uploadToken?: string; expiresAt?: number;
}
export interface TranscriptSaveState {
  status: 'idle' | 'saving' | 'queued' | 'saved' | 'error';
  detail: string;
  sourcePath: string | null;
}
export const initialTranscriptSave = (): TranscriptSaveState => ({status:'idle', detail:'Transcript saving is ready', sourcePath:null});
interface Auth {accountId: string | null; status: string; generation: number}
interface Grant {uploadToken: string; expiresAt: number; conversationId: string; sourceId: string}
interface SavedReceipt {companyUid:string;personUid:string;conversationId:string;sourcePath:string;revision:number;updatedAt:number}
interface Page {rows: OutboxRow[]; totalCount: number; hasMore: boolean; receipts?:SavedReceipt[]}
interface Receipt {saved: true; sourceId:string; revision:number; updatedAt:number; sourceRef:{key:string}}
const key = (r: OutboxRow) => ({companyUid:r.companyUid, personUid:r.personUid, conversationId:r.conversationId, streamId:r.streamId, segmentId:r.segmentId, revision:r.revision});

/** Runs in both the call and main desktop windows; server and disk acknowledgements are idempotent. */
export function createTranscriptOutboxDrain(invoke: SaveInvoke, onSaved?: (row: OutboxRow, receipt: Receipt) => void, onSnapshot?: (page:Page) => void, onFailure?: (row:OutboxRow) => void) {
  const adapter = createSyncPlatformAdapter({invoke, fetch: (()=>{throw new Error('Native transport required');}) as typeof fetch});
  const ready = adapter.calls.preflight(SERVICE_EVIDENCE, {maxAgeMs:BUNDLED_EVIDENCE_MAX_AGE_MS});
  let busy=false; let disposed=false;
  async function drain() {
    if (busy || disposed) return;
    busy=true;
    try {
      if (!(await ready).ok) return;
      const auth = await invoke<Auth>('get_auth_session');
      if (!auth.accountId || auth.status!=='active') return;
      // Bounded scan. Rows without authority remain on disk, never silently discarded.
      let offset=0;
      for (let pageCount=0; pageCount<10 && !disposed; pageCount++) {
        const page = await invoke<Page>('meet_transcript_outbox_read', {accountId:auth.accountId, offset});
        if (!Array.isArray(page?.rows)) break;
        if(offset===0)onSnapshot?.(page);
        if (!page.rows.length) break;
        let removed=0;
        for (const row of page.rows) {
          if (disposed) break;
          if (!row.uploadToken || !row.expiresAt || row.expiresAt<=Date.now()) continue;
          const current = await invoke<Auth>('get_auth_session');
          if (current.accountId!==auth.accountId || current.generation!==auth.generation || current.status!=='active') return;
          const result = await adapter.calls.liveTranscript('append', {
            version:"hq-meet/1", companyUid:row.companyUid, uploadToken:row.uploadToken,
            event:{kind:'transcript',version:1,conversationId:row.conversationId,streamId:row.streamId,
              segmentId:row.segmentId,revision:row.revision,startMs:row.startMs,endMs:row.endMs,text:row.text,final:true},
          } as Json);
          if (!result.ok) {onFailure?.(row);continue;}
          const receipt = result.value as unknown as Receipt;
          if (receipt?.saved!==true || !Number.isSafeInteger(receipt.revision) || !Number.isSafeInteger(receipt.updatedAt) ||
              !/^native-[a-f0-9]{64}$/.test(receipt.sourceId) || receipt.sourceRef?.key!==`sources/meetings/${receipt.sourceId}.md`) continue;
          const after = await invoke<Auth>('get_auth_session');
          if (after.accountId!==auth.accountId || after.generation!==auth.generation || after.status!=='active') return;
          await invoke('meet_transcript_outbox_ack', {accountId:auth.accountId, keys:[key(row)],receipt:{saved:true,sourceId:receipt.sourceId,sourceRef:{key:receipt.sourceRef.key},revision:receipt.revision,updatedAt:receipt.updatedAt}});
          removed++; onSaved?.(row, receipt);
        }
        if (!page.hasMore) break;
        offset += page.rows.length-removed;
      }
    } catch { /* Disk retains all unacknowledged rows for the next retry. */ }
    finally {busy=false;}
  }
  const timer=setInterval(()=>void drain(),5000);
  void drain();
  return {drain, dispose(){disposed=true;clearInterval(timer);}};
}

/** Own-speaker writes only. Personal notes never enter this service. */
export function createTranscriptSave(invoke:SaveInvoke, handle:CallWindowHandle, publish:(state:TranscriptSaveState)=>void) {
  let disposed=false; let state=initialTranscriptSave(); let activeConversation:string|null=null;
  const account=invoke<Auth>('get_auth_session');
  async function currentAccount(){
    const original=await account;const current=await invoke<Auth>('get_auth_session');
    if(!original.accountId || current.accountId!==original.accountId || current.generation!==original.generation ||
      !['active','refresh_temporarily_unavailable'].includes(current.status))throw new Error('Account changed');
    return current;
  }
  const intervals=new Map<string,number>();
  const grantKey=(conversationId:string,streamId:string)=>`${conversationId}/${streamId}/${intervals.get(`${conversationId}/${streamId}`)??0}`;
  const attempted=new Map<string,number>();
  const grants=new Map<string,Grant>(); const authorizing=new Map<string,Promise<Grant|null>>();
  const pending=new Set<string>();
  const sourceAdapter=createSyncPlatformAdapter({invoke,fetch:(()=>{throw new Error('Native transport required');}) as typeof fetch});
  const sourceReady=sourceAdapter.calls.preflight(SERVICE_EVIDENCE,{maxAgeMs:BUNDLED_EVIDENCE_MAX_AGE_MS});
  let sourceReadAt=0;let sourceReading=false;
  async function refreshSaved(grant:Grant){
    if(disposed || sourceReading || Date.now()-sourceReadAt<5000 || !handle.target)return;
    sourceReading=true;sourceReadAt=Date.now();
    try{
      await currentAccount();if(!(await sourceReady).ok)return;
      const result=await sourceAdapter.calls.liveTranscript('read',{version:'hq-meet/1',companyUid:handle.target.companyUid,sourceId:grant.sourceId});
      await currentAccount();if(disposed || activeConversation!==grant.conversationId || !result.ok)return;
      const saved=result.value as unknown as {sourceId:string;sourceRef?:{key?:string}};
      if(saved.sourceId!==grant.sourceId || saved.sourceRef?.key!==`sources/meetings/${grant.sourceId}.md`)return;
      emit({sourcePath:saved.sourceRef.key,...pending.size===0?{status:'saved',detail:'Vault copy available'}:{}});
    }catch{/* Missing or offline source stays visibly unconfirmed. */}finally{sourceReading=false;}
  }
  const rowKey=(row:OutboxRow)=>JSON.stringify(key(row));
  const emit=(next:Partial<TranscriptSaveState>)=>{state={...state,...next};if(!disposed)publish({...state});};
  const drain=createTranscriptOutboxDrain(invoke,(row,receipt)=>{
    pending.delete(rowKey(row));
    if(row.conversationId===activeConversation)emit({status:pending.size?'queued':'saved',detail:pending.size?'Saving remaining transcript…':'Saved to company vault',sourcePath:receipt.sourceRef.key});
  },page=>{
    if(!activeConversation)return;
    const saved=page.receipts?.find(receipt=>receipt.companyUid===handle.target?.companyUid && receipt.personUid===handle.target?.self.personUid && receipt.conversationId===activeConversation);
    const remaining=page.rows.filter(row=>row.conversationId===activeConversation && row.companyUid===handle.target?.companyUid);
    if(saved && page.totalCount===0){pending.clear();emit({status:'saved',detail:'Saved to company vault',sourcePath:saved.sourcePath});}
    else if(remaining.length)emit({status:'queued',detail:remaining.some(row=>!row.uploadToken||!row.expiresAt||row.expiresAt<=Date.now())?'Saved on this device · upload authorization pending':'Saved on this device · waiting for vault sync',sourcePath:saved?.sourcePath??state.sourcePath});
  },row=>{
    if(row.conversationId===activeConversation)emit({status:'error',detail:'Vault save failed · transcript kept on this device; retrying'});
  });
  async function authorize(conversationId:string,streamId:string):Promise<Grant|null> {
    const id=grantKey(conversationId,streamId); const prior=grants.get(id);
    if(prior && prior.expiresAt>Date.now()+60000)return prior;
    const running=authorizing.get(id);if(running)return running;
    if(attempted.has(id) && Date.now()-attempted.get(id)!<15000)return null;
    attempted.set(id,Date.now());
    const task=(async()=>{
      try{
        await currentAccount();
        const raw=await handle.beginTranscriptSave?.(conversationId,streamId,intervals.get(`${conversationId}/${streamId}`)) as Grant|undefined;
        if(disposed || !raw || raw.conversationId!==conversationId || typeof raw.uploadToken!=='string' || !raw.uploadToken || !Number.isFinite(raw.expiresAt) || raw.expiresAt<=Date.now())return null;
        grants.set(id,raw);
        const auth=await currentAccount();
        // Attach authority to speech already queued while the network was unavailable.
        let offset=0;
        for(let n=0;n<10;n++){
          const page=await invoke<Page>('meet_transcript_outbox_read',{accountId:auth.accountId,offset});
          if(!Array.isArray(page?.rows))break;
          for(const row of page.rows)if(row.companyUid===handle.target?.companyUid && row.personUid===handle.target?.self.personUid && row.conversationId===conversationId && row.streamId===streamId)
            await invoke('meet_transcript_outbox_enqueue',{accountId:auth.accountId,audience:'room',row:{...row,uploadToken:raw.uploadToken,expiresAt:raw.expiresAt}});
          if(!page.hasMore)break;offset+=page.rows.length;
        }
        void drain.drain();return raw;
      }catch{return null;}finally{authorizing.delete(id);}
    })();
    authorizing.set(id,task);return task;
  }
  return {
    prepare(conversationId:string,streamId:string,recordingInterval=0){
      if(disposed || conversationId.startsWith('personal-'))return;
      intervals.set(`${conversationId}/${streamId}`,recordingInterval);
      if(activeConversation!==conversationId){activeConversation=conversationId;emit(initialTranscriptSave());}
      void authorize(conversationId,streamId).then(grant=>{if(grant)void refreshSaved(grant);});
    },
    async enqueue(row:TranscriptRow){
      const target=handle.target;
      if(disposed || !target || !row.final || row.conversationId.startsWith('personal-') || row.personUid!==target.self.personUid || row.deviceId!==target.self.deviceId)return;
      const queued:OutboxRow={companyUid:target.companyUid,personUid:row.personUid,roomId:target.roomId,callId:target.callId,epoch:target.epoch,
        conversationId:row.conversationId,streamId:row.streamId,segmentId:row.segmentId,revision:row.revision,startMs:row.startMs,endMs:row.endMs,text:row.text,deviceId:row.deviceId};
      const cachedGrant=grants.get(grantKey(row.conversationId,row.streamId));
      const grant=cachedGrant && cachedGrant.expiresAt>Date.now()+1000 ? cachedGrant : null;
      if(grant){queued.uploadToken=grant.uploadToken;queued.expiresAt=grant.expiresAt;}
      emit({status:'saving',detail:'Saving transcript…'});
      try{
        const auth=await currentAccount();
        await invoke('meet_transcript_outbox_enqueue',{accountId:auth.accountId,audience:'room',row:queued});
        pending.add(rowKey(queued));
        emit({status:'queued',detail:'Saved on this device · waiting for vault sync'});
        if(!grant)await authorize(row.conversationId,row.streamId);
        void drain.drain();
      }catch{emit({status:'error',detail:'Could not save this transcript to the device'});}
    },
    async showInVault(){
      if(disposed || !handle.target || !state.sourcePath)return;
      const match=/^sources\/meetings\/(native-[a-f0-9]{64})\.md$/.exec(state.sourcePath);
      if(!match)return;
      try{
        const auth=await currentAccount();
        const adapter=createSyncPlatformAdapter({invoke,fetch:(()=>{throw new Error('Native transport required');}) as typeof fetch});
        if(!(await adapter.calls.preflight(SERVICE_EVIDENCE,{maxAgeMs:BUNDLED_EVIDENCE_MAX_AGE_MS})).ok)throw new Error('Unavailable');
        const result=await adapter.calls.liveTranscript('read',{version:'hq-meet/1',companyUid:handle.target.companyUid,sourceId:match[1]});
        if(!result.ok)throw new Error('Unavailable');
        const projection=result.value as unknown as {sourceId:string;revision:number;accessRevision?:number;markdown:string;raw:Json};
        if(!projection || projection.sourceId!==match[1] || !projection.raw || typeof projection.raw!=='object' || Array.isArray(projection.raw) || typeof projection.markdown!=='string' || !Number.isSafeInteger(projection.revision))throw new Error('Invalid projection');
        await currentAccount();if(disposed)return;
        await invoke('meet_transcript_project',{accountId:auth.accountId,companyUid:handle.target.companyUid,reveal:true,
          projection:{sourceId:projection.sourceId,revision:projection.revision,accessRevision:projection.accessRevision??0,markdown:projection.markdown,rawJson:JSON.stringify(projection.raw)}});
      }catch{emit({detail:'Saved in the vault · local copy could not be opened'});}
    },
    dispose(){disposed=true;drain.dispose();},
  };
}
