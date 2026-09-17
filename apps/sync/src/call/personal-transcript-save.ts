import type {CallWindowHandle} from './bootstrap';
import type {TranscriptRow} from './live-transcript';
import {type SaveInvoke,type TranscriptSaveState} from './transcript-save';
const timestamp=(ms:number)=>{const s=Math.floor(ms/1000);return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,'0')).join(':');};
export function createPersonalTranscriptSave(invoke:SaveInvoke,handle:CallWindowHandle,publish:(state:TranscriptSaveState)=>void){
 const account=invoke<{accountId:string|null;generation:number}>('get_auth_session');
 const rows=new Map<string,TranscriptRow>();let revision=0,saved=0,disposed=false,busy:Promise<void>|null=null;
 let ended=false,paused=false;
 let startedAt=0,updatedAt=0,conversationId='',sourceId='',sourcePath:string|null=null;
 const emit=(status:TranscriptSaveState['status'],detail:string)=>{if(!disposed)publish({status,detail,sourcePath});};
 async function write(reveal=false){
  if(!rows.size)return;
  // The native local writer checks the current cached account identity.
  // Auth-envelope generations also change on temporary network refresh failures;
  // they must not prevent this account's already-captured notes from reaching disk.
  const original=await account;
  if(!original.accountId)throw new Error('Account unavailable');
  if(!sourceId){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${original.accountId}\0${conversationId}`));sourceId='native-'+Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');}
  const writing=revision,segments=[...rows.values()].sort((a,b)=>a.startMs-b.startMs||a.segmentId.localeCompare(b.segmentId));
  const raw={version:1,conversationId,revision:writing,segments:segments.map(segment=>({speakerName:'You',segment})),provisional:!ended};
  const metadata={id:`meeting:${sourceId}`,channel:'meeting',source_id:sourceId,title:'Personal notes',origin:'hq-meet',created_at:new Date(startedAt).toISOString(),updated_at:new Date(updatedAt).toISOString(),meeting_platform:'hq-meet',capture_source:'hq-meet-native',conversation_id:conversationId,visibility:'personal',storage:'local',provisional:!ended,session_status:ended?'ended':paused?'paused':'active',revision:writing};
  const markdown='---\n'+Object.entries(metadata).map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join('\n')+'\n---\n\n## Transcript\n\n'+segments.map(r=>`**You** · \`[${timestamp(r.startMs)}–${timestamp(r.endMs)}]\`\n\n${r.text}`).join('\n\n')+'\n';
  const result=await invoke<{markdownPath:string}>('meet_personal_transcript_project',{accountId:original.accountId,reveal,projection:{sourceId,revision:writing,accessRevision:0,markdown,rawJson:JSON.stringify(raw)}});
  saved=writing;sourcePath=result.markdownPath;emit(saved===revision?'saved':'saving',saved===revision?'Saved to personal vault · only on this device':'Saving personal notes…');
 }
 async function flush(){
  if(busy){await busy;return flush();}
  if(saved===revision)return;
  busy=(async()=>{try{while(saved<revision)await write();}catch{emit('error','Personal save pending · retrying automatically');}finally{busy=null;}})();await busy;
 }
 const timer=setInterval(()=>{if(!disposed)void flush();},5000);
 return {
  async enqueue(row:TranscriptRow){
   if(disposed||!row.final||!row.conversationId.startsWith('personal-')||row.personUid!==handle.target?.self.personUid||row.deviceId!==handle.target?.self.deviceId)return;
   if(conversationId&&conversationId!==row.conversationId)return;
   if(!conversationId){conversationId=row.conversationId;startedAt=Date.now()-row.endMs;}
   const key=`${row.streamId}/${row.segmentId}`,prior=rows.get(key);if(prior&&prior.revision>=row.revision)return;
   rows.set(key,{...row});revision++;updatedAt=Date.now();emit('saving','Saving personal notes…');await flush();
  },
  flush,
  async setPaused(value:boolean){if(paused!==value&&!ended){paused=value;if(rows.size){revision++;updatedAt=Date.now();}}await flush();},
  async end(){if(!ended){ended=true;if(rows.size){revision++;updatedAt=Date.now();}}await flush();},
  hasUnsaved:()=>saved!==revision,
  async showInVault(){await flush();if(saved!==revision)return;try{await write(true);}catch{emit('error','Personal notes could not be opened');}},
  dispose(){disposed=true;clearInterval(timer);},
 };
}
