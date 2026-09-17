import type { CallWindowHandle, CallViewState } from './bootstrap';
import type { TranscriptMessage } from '@hq/meet-core';
import { conversationElapsed, type Conversation } from './conversation';

export interface TranscriptRow extends TranscriptMessage { personUid: string; deviceId: string; }
export interface TranscriptionSession {
  id:string;scope:'personal'|'company';ownerPersonUid:string;state:'active'|'paused'|'ended';
  startedAt:number;activeSince:number|null;elapsedMs:number;pausedAt:number|null;endedAt:number|null;interval:number;
}
export interface LiveTranscriptState {
  session:TranscriptionSession|null;
  sessionNotice?:string;
  conversation: Conversation | null;
  mode: "personal" | "room";
  elapsedMs: number;
  status: 'waiting'|'connecting'|'setup'|'muted'|'listening'|'processing'|'paused'|'unavailable';
  detail: string;
  rows: TranscriptRow[];
  modelReady: boolean;
  policyReady: boolean;
  gaps: number;
}
export const initialTranscript=():LiveTranscriptState=>({session:null,mode:"room",conversation:null,elapsedMs:0,status:'connecting',detail:'Connecting to conversation…',rows:[],modelReady:false,policyReady:false,gaps:0});
type Invoke=<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;

/** Bounded, call-window lifetime only. Recognition never opens a microphone. */
export function createLiveTranscript(handle:CallWindowHandle,invoke:Invoke,publish:(state:LiveTranscriptState)=>void, storage?:Pick<Storage,"getItem"|"setItem">, saver?:{prepare(conversationId:string,streamId:string,recordingInterval?:number):void;enqueue(row:TranscriptRow):Promise<void>;enqueuePersonal?(row:TranscriptRow):Promise<void>}){
  let state=initialTranscript();
  // Retained argument only for old hosts; no persisted automatic-recording preference.
  void storage;
  let companySession:TranscriptionSession|null=null;
  let lastServerTime=Number.NEGATIVE_INFINITY;
  let personalSession:TranscriptionSession|null=null;
  let mutation=0;let changing=false;
  const rowHistory=new Map<string,TranscriptRow[]>(); let disposed=false;let polling=false;let offset=0;let authorityAt=0;
  let context:AudioContext|null=null; let source:MediaStreamAudioSourceNode|null=null;let tap:AudioWorkletNode|null=null;
  let track:MediaStreamTrack|null=null;let generation=0;let captureStarting=false;let inferenceBusy=false;
  let streamId=crypto.randomUUID();let sequence=0;
  let sessionOff:(()=>void)|undefined;
  let subscribedSession:CallWindowHandle["session"] = null;
  const pending=new Map<string,{message:TranscriptMessage;until:number;sent:Set<string>;recipients:Set<string>}>();
  const emit=()=>{if(!disposed)publish({...state,rows:[...state.rows]});};
  function status(next:LiveTranscriptState['status'],detail:string){state={...state,status:next,detail};emit();}
  function add(row:TranscriptRow){
    const key=(r:TranscriptRow)=>`${r.personUid}/${r.deviceId}/${r.streamId}/${r.segmentId}`;
    const previous=state.rows.find(r=>key(r)===key(row));
    if(previous && previous.revision>=row.revision)return;
    state.rows=[...state.rows.filter(r=>key(r)!==key(row)),row].sort((a,b)=>a.startMs-b.startMs).slice(-1000);emit();
  }
  function stopTap(){
    generation++;captureStarting=false;
    if(tap){tap.port.onmessage=null;tap.disconnect();tap=null;}
    source?.disconnect();source=null;
    const old=context;context=null;track=null;
    void old?.close().catch(()=>{});
  }
  const asConversation=(session:TranscriptionSession|null):Conversation|null=>session?{conversationId:session.id,state:session.state==='ended'?'finalized':session.state,startedAt:session.startedAt,activeSince:session.activeSince,elapsedMs:session.elapsedMs,pausedAt:session.pausedAt,endedAt:session.endedAt}:null;
  function chooseSession(){
    const companyLive=companySession && companySession.state!=='ended';
    if(companyLive && personalSession && personalSession.state!=='ended'){
      const now=Date.now();personalSession={...personalSession,state:'ended',elapsedMs:conversationElapsed(asConversation(personalSession),now),activeSince:null,pausedAt:null,endedAt:now};
      state.sessionNotice='Personal session ended when company transcription started. Notes are in your personal vault.';
    }
    const latestEnded=[companySession,personalSession].filter((s):s is TranscriptionSession=>s!==null).sort((a,b)=>b.startedAt-a.startedAt)[0]??null;
    const next=companyLive?companySession:personalSession && personalSession.state!=='ended'?personalSession:latestEnded;
    const mode=next?.scope==='personal'?'personal':'room';
    if(state.session?.id!==next?.id || state.session?.interval!==next?.interval || state.session?.state!==next?.state){
      stopTap();pending.clear();streamId=crypto.randomUUID();
      if(state.session?.id){rowHistory.set(state.session.id,state.rows);if(rowHistory.size>10)rowHistory.delete(rowHistory.keys().next().value!);}
      if(state.session?.id!==next?.id){state.rows=next?rowHistory.get(next.id)??[]:[];state.gaps=0;}
    }
    state.mode=mode;state.session=next;state.conversation=asConversation(next);
  }
  function eligible(v:CallViewState){
    return !disposed && !changing && v.status==='joined' && v.identityResolved && !v.authorityPaused && handle.content.open() && !v.roster?.trafficStopped && state.session?.state==='active' && (state.session.scope==='personal' || (state.policyReady && Date.now()-authorityAt<7000));
  }
  function broadcast(){
    if(state.mode!=="room")return;
    for(const [key,entry] of pending){
      if(Date.now()>entry.until){pending.delete(key);continue;}
      for(const peer of handle.state().roster?.peers??[]){
        if(!entry.recipients.has(peer.peerId)||entry.sent.has(peer.peerId)||!handle.content.allows(peer.peerId))continue;
        if(handle.session?.sendTranscript(peer.peerId,entry.message))entry.sent.add(peer.peerId);
      }
      if([...entry.recipients].every(id=>entry.sent.has(id)))pending.delete(key);
    }
  }
  async function consume(samples:Float32Array,token:number){
    if(!eligible(handle.state())||token!==generation||!handle.state().media.microphone.active)return;
    if(inferenceBusy){state.gaps++;status('processing','Recognition is catching up · an audio gap was skipped');return;}
    const conversation=state.conversation!;const endMs=Math.round(conversationElapsed(conversation,Date.now()+(state.mode==="personal"?0:offset)));
    const segmentId=String(++sequence);let failed=false;inferenceBusy=true;status('processing','Transcribing on this device');
    try{
      const interval=state.session!.interval;
      const scope=state.session!.scope;
      const result=await invoke<{text:string}>('meet_transcribe_pcm',{samples:Array.from(samples),sampleRate:16000});
      if(scope==='company'){
        const raw=await handle.transcriptionSession?.('read');
        if(disposed||token!==generation||!accept(raw))return;
        chooseSession();emit();
        if(state.session?.id!==conversation.conversationId||state.session.interval!==interval||state.session.state!=='active')return;
      }
      if(token!==generation||!eligible(handle.state())||!handle.state().media.microphone.active||state.conversation?.conversationId!==conversation.conversationId)return;
      const text=result.text?.trim();if(!text)return;
      const message:TranscriptMessage={kind:'transcript',version:1,conversationId:conversation.conversationId,streamId,segmentId,revision:1,startMs:Math.max(0,Math.round(endMs-samples.length/16)),endMs,text:text.slice(0,4000),final:true};
      add({...message,personUid:handle.target!.self.personUid,deviceId:handle.target!.self.deviceId});
      if(state.mode==="personal"){void saver?.enqueuePersonal?.({...message,personUid:handle.target!.self.personUid,deviceId:handle.target!.self.deviceId});return;}
      void saver?.enqueue({...message,personUid:handle.target!.self.personUid,deviceId:handle.target!.self.deviceId});
      if(pending.size>=128)pending.delete(pending.keys().next().value!);
      pending.set(segmentId,{message,until:Date.now()+15000,sent:new Set(),recipients:new Set(handle.state().roster?.peers.map(p=>p.peerId)??[])});broadcast();
    }catch{failed=true;if(token===generation){state.gaps++;status('unavailable','Local transcription failed · retrying on the next phrase');}}
    finally{inferenceBusy=false;if(!failed&&token===generation&&eligible(handle.state()))status('listening',state.mode==='personal'?'Listening locally · private notes, only on this device':'Listening locally · shared with this room');}
  }
  async function startTap(next:MediaStreamTrack){
    if(captureStarting||track===next)return;
    stopTap();captureStarting=true;const token=generation;track=next;
    try{
      const audio=new AudioContext();context=audio;
      await audio.audioWorklet.addModule('/meet/pcm-tap.js');
      if(token!==generation||!eligible(handle.state())){void audio.close().catch(()=>{});return;}
      source=audio.createMediaStreamSource(new MediaStream([next]));
      tap=new AudioWorkletNode(audio,'meet-pcm-tap');
      tap.port.onmessage=e=>{if(e.data instanceof Float32Array && e.data.length<=96000)void consume(e.data,token);};
      source.connect(tap); // Worklet output is silence; keeps graph alive without monitoring the mic.
      tap.connect(audio.destination);await audio.resume();
      if(token===generation)status('listening',state.mode==='personal'?'Listening locally · private notes, only on this device':'Listening locally · shared with this room');
    }catch{if(token===generation){stopTap();status('unavailable','Could not start local audio processing');}}
    finally{if(token===generation)captureStarting=false;}
  }
  function update(v:CallViewState){
    if(disposed)return;
    bindSession();
    chooseSession();
    if(!eligible(v)){
      if(context||captureStarting)stopTap();
      if(v.code==='ACCOUNT_CHANGED'){pending.clear();state.rows=[];rowHistory.clear();personalSession=null;companySession=null;state.session=null;state.conversation=null;}
      if(personalSession?.state==='active' && v.code!=='ACCOUNT_CHANGED'){
        const now=Date.now();personalSession={...personalSession,state:v.status==='left'?'ended':'paused',elapsedMs:conversationElapsed(asConversation(personalSession),now),activeSince:null,pausedAt:v.status==='left'?null:now,endedAt:v.status==='left'?now:null};
        chooseSession();
      }
      if(!state.session)status('waiting','Start a personal or company transcription when you are ready');
      else if(state.session.state==='ended')status('waiting','Transcription ended · your notes are still here');
      else if(state.session.state==='paused')status('paused','Transcription paused · nothing is being recorded');
      else status('paused','Transcription connection paused');
      return;
    }
    if(state.mode==='room' && state.conversation)saver?.prepare(state.conversation.conversationId,streamId,state.session?.interval);
    if(!state.modelReady){status('setup','Local speech model is not installed');return;}
    const next=handle.media?.tracksFor('microphone').find(t=>t.readyState!=='ended') as MediaStreamTrack|undefined;
    if(!v.media.microphone.active||!next){if(context)stopTap();status('muted',state.mode==='personal'?'Unmute your microphone to capture your thoughts':'Your microphone is muted · other participants’ text appears here');return;}
    void startTap(next);broadcast();
  }
  function accept(raw:unknown){
    const value=raw as {session?:{sessionId?:unknown;starterPersonUid?:unknown;state?:unknown;startedAt?:unknown;activeSince?:unknown;elapsedMs?:unknown;pausedAt?:unknown;endedAt?:unknown;interval?:unknown};serverTime?:number}|null;
    if(!value || !('session' in value)||typeof value.serverTime!=='number'||!Number.isFinite(value.serverTime)||value.serverTime<lastServerTime)return false;
    if(value.session===null){if(companySession)return false;lastServerTime=value.serverTime;state.policyReady=true;authorityAt=Date.now();return true;}
    const v=value.session!;
    if(typeof v.sessionId!=='string'||!v.sessionId||typeof v.starterPersonUid!=='string'||!['recording','paused','ended'].includes(String(v.state)))return false;
    for(const key of ['startedAt','elapsedMs','interval'] as const)if(typeof v[key]!=='number'||!Number.isFinite(v[key])||Number(v[key])<0)return false;
    for(const key of ['activeSince','pausedAt','endedAt'] as const)if(v[key]!==null&&(typeof v[key]!=='number'||!Number.isFinite(v[key])||Number(v[key])<0))return false;
    if(companySession?.id===v.sessionId){
      if((v.interval as number)<companySession.interval)return false;
      if(companySession.state==='ended'&&v.state!=='ended')return false;
      if((v.interval as number)===companySession.interval&&companySession.state==='paused'&&v.state==='recording')return false;
    } else if(companySession && (v.startedAt as number)<companySession.startedAt)return false;
    lastServerTime=value.serverTime;
    companySession={id:v.sessionId,scope:'company',ownerPersonUid:v.starterPersonUid,state:v.state==='recording'?'active':v.state as 'paused'|'ended',startedAt:v.startedAt as number,activeSince:v.activeSince as number|null,elapsedMs:v.elapsedMs as number,pausedAt:v.pausedAt as number|null,endedAt:v.endedAt as number|null,interval:v.interval as number};
    state.policyReady=true;authorityAt=Date.now();if(typeof value.serverTime==='number'&&Number.isFinite(value.serverTime))offset=value.serverTime-Date.now();return true;
  }
  async function poll(){
    if(disposed||polling||changing)return;polling=true;const token=mutation;
    try{const raw=await handle.transcriptionSession?.('read');if(!disposed&&token===mutation)accept(raw);}catch{/* Failed polls never extend freshness. */}
    try{if(!state.modelReady){const model=await invoke<{ready:boolean}>('meet_transcription_status');if(!disposed)state.modelReady=model.ready;}}catch{}
    finally{polling=false;if(!disposed)update(handle.state());}
  }
  async function control(operation:'start'|'pause'|'resume'|'end',scope?:'personal'|'company'){
    if(disposed||changing)throw new Error('Transcription is unavailable');
    const current=state.session;
    const view=handle.state();
    if((operation==='start'||operation==='resume')&&(!handle.target||view.status!=='joined'||!view.identityResolved||view.authorityPaused||!handle.content.open()||view.roster?.trafficStopped))throw new Error('Join the room before starting transcription');
    if(operation==='resume'&&current?.state!=='paused')throw new Error('Only a paused transcription can resume');
    if(operation==='pause'&&current?.state!=='active')throw new Error('Only an active transcription can pause');
    if(operation!=='start'&&(!current||current.ownerPersonUid!==handle.target?.self.personUid))throw new Error('Only the person who started transcription can control it');
    if(operation==='start'&&scope==='personal'&&companySession&&companySession.state!=='ended')throw new Error('End company transcription before starting personal notes');
    if(operation==='start'&&current&&current.state!=='ended')throw new Error('End the current transcription before starting another');
    if(operation==='start')state.sessionNotice=undefined;
    stopTap();pending.clear();mutation++;changing=true;authorityAt=0;
    try{
      if(scope==='personal'||(operation!=='start'&&current?.scope==='personal')){
        const now=Date.now();
        if(operation==='start')personalSession={id:`personal-${crypto.randomUUID()}`,scope:'personal',ownerPersonUid:handle.target!.self.personUid,state:'active',startedAt:now,activeSince:now,elapsedMs:0,pausedAt:null,endedAt:null,interval:1};
        else if(personalSession){
          const elapsed=conversationElapsed(asConversation(personalSession),now);
          personalSession={...personalSession,elapsedMs:elapsed,state:operation==='resume'?'active':operation==='end'?'ended':'paused',activeSince:operation==='resume'?now:null,pausedAt:operation==='pause'?now:null,endedAt:operation==='end'?now:null,interval:personalSession.interval+(operation==='resume'?1:0)};
        }
      }else{
        const raw=await handle.transcriptionSession?.(operation,current?.id);
        if(!accept(raw))throw new Error('The transcription service could not confirm that change');
      }
    }finally{changing=false;update(handle.state());emit();}
  }
  function bindSession(){
    if(subscribedSession===handle.session)return;
    sessionOff?.();subscribedSession=handle.session;
    sessionOff=subscribedSession?.on('transcript',event=>{
      if(state.mode!=='room'||!eligible(handle.state())||!handle.content.allows(`${event.from.personUid} ${event.from.deviceId}`)||event.message.conversationId!==state.conversation?.conversationId)return;
      add({...event.message,personUid:event.from.personUid,deviceId:event.from.deviceId});
    });
  }
  bindSession();
  const timer=setInterval(()=>{state.elapsedMs=conversationElapsed(state.conversation,Date.now()+(state.mode==="personal"?0:offset));update(handle.state());emit();},1000);
  const poller=setInterval(()=>void poll(),2000);void poll();
  return {update,startSession:(scope:'personal'|'company')=>control('start',scope),pauseSession:()=>control('pause'),resumeSession:()=>control('resume'),endSession:()=>control('end'),dispose(){disposed=true;clearInterval(timer);clearInterval(poller);sessionOff?.();stopTap();pending.clear();state.rows=[];}};
}
