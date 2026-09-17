import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveTranscript, initialTranscript } from './live-transcript';
import type { CallWindowHandle, CallViewState } from './bootstrap';
import { parseTranscript, type TranscriptEvent, type TranscriptMessage } from '@hq/meet-core';

const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
const contexts: FakeAudio[]=[];
const taps: FakeTap[]=[];
class FakeAudio {
  destination={}; close=vi.fn(async()=>{}); resume=vi.fn(async()=>{});
  audioWorklet={addModule:vi.fn(async()=>{})};
  createMediaStreamSource=vi.fn(()=>({connect:vi.fn(),disconnect:vi.fn()}));
  constructor(){contexts.push(this);}
}
class FakeTap {
  port:{onmessage:((e:{data:Float32Array})=>void)|null}={onmessage:null};
  connect=vi.fn(); disconnect=vi.fn();
  constructor(){taps.push(this);}
}
const message:TranscriptMessage={kind:'transcript',version:1,conversationId:'c1',streamId:'s1',segmentId:'1',revision:1,startMs:0,endMs:10,text:'hello',final:true};
function fixture(options:{solo?:boolean;unsupported?:boolean;personUid?:string;companyUid?:string;storage?:Pick<Storage,"getItem"|"setItem">}={}) {
  let state=initialTranscript(); let receiver:((e:TranscriptEvent)=>void)|undefined;
  const view={status:'joined',identityResolved:true,authorityPaused:false,code:null,media:{microphone:{active:true}},roster:{trafficStopped:false,admitted:[{personUid:options.personUid??'self'},...options.solo?[]:[{personUid:'peer'}]],peers:[{peerId:'peer dev'}]}} as unknown as CallViewState;
  const send=vi.fn((_peerId:string,_message:TranscriptMessage)=>true);const off=vi.fn();let allowed=true;
  let serverSession:any=null;
  const sessionCommand=vi.fn(async(operation:string)=>{
    if(options.unsupported)return null;
    const now=Date.now();
    if(operation==='start')serverSession={sessionId:'c1',starterPersonUid:options.personUid??'self',state:'recording',startedAt:now,activeSince:now,elapsedMs:0,pausedAt:null,endedAt:null,interval:1};
    else if(serverSession&&operation!=='read')serverSession={...serverSession,state:operation==='resume'?'recording':operation==='end'?'ended':'paused',activeSince:operation==='resume'?now:null,pausedAt:operation==='pause'?now:null,endedAt:operation==='end'?now:null,interval:serverSession.interval+(operation==='resume'?1:0)};
    return {session:serverSession,serverTime:now};
  });
  const handle={state:()=>view,target:{companyUid:options.companyUid??'company',self:{personUid:options.personUid??'self',deviceId:'local'}},content:{open:()=>allowed,allows:()=>allowed},media:{tracksFor:()=>[{readyState:'live',kind:'audio'}]},session:{on:(_kind:string,cb:(e:TranscriptEvent)=>void)=>{receiver=cb;return off;},sendTranscript:send},transcriptionSession:sessionCommand} as unknown as CallWindowHandle;
  const recognize=vi.fn(async()=>({text:'recognized'}));
  const invoke=vi.fn(async(command:string)=>command==='meet_transcription_status'?{ready:true}:recognize());
  const controller=createLiveTranscript(handle,invoke as Parameters<typeof createLiveTranscript>[1],next=>state=next,options.storage);
  return {controller,view,send,recognize,off,sessionCommand,setServerSession:(value:any)=>{serverSession=value;},get state(){return state;},remote:(m:TranscriptMessage,personUid='peer',deviceId='dev')=>receiver?.({sessionId:'test',generation:1,from:{personUid,deviceId,peerKey:'key'},message:m}),revoke:()=>{allowed=false;view.code='ACCOUNT_CHANGED';view.identityResolved=false;},pcm:(length=16000)=>taps.at(-1)?.port.onmessage?.({data:new Float32Array(length)})};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100000);contexts.length=0;taps.length=0;vi.stubGlobal('AudioContext',FakeAudio);vi.stubGlobal('AudioWorkletNode',FakeTap);vi.stubGlobal('MediaStream',class {});});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
describe('live transcript host lifecycle',()=>{
  it.each([{solo:true},{unsupported:true}])('never starts audio processing without eligible conversation %j',async options=>{
    const f=fixture(options);await flush();await vi.advanceTimersByTimeAsync(5000);expect(contexts).toHaveLength(0);expect(f.recognize).not.toHaveBeenCalled();f.controller.dispose();
  });
  it.each(['mute','account'] as const)('drops in-flight recognition after %s even before the next render update',async reason=>{
    const f=fixture();await flush();await f.controller.startSession('company');await flush();let finish!:(value:{text:string})=>void;
    f.recognize.mockImplementation(()=>new Promise(resolve=>finish=resolve));f.pcm();await flush();
    if(reason==='mute')f.view.media.microphone.active=false;else f.revoke();
    finish({text:'must not publish'});await flush();expect(f.state.rows).toEqual([]);expect(f.send).not.toHaveBeenCalled();
    f.controller.update(f.view);f.controller.dispose();expect(contexts[0].close).toHaveBeenCalled();expect(f.off).toHaveBeenCalled();
  });
  it('binds remote revisions to transport identity and rejects stale or wrong-conversation text',async()=>{
    const f=fixture();await flush();await f.controller.startSession('company');await flush();f.remote(message);f.remote({...message,revision:0,text:'old'});f.remote({...message,revision:2,text:'revised'});f.remote(message,'other');f.remote({...message,conversationId:'old'});
    expect(f.state.rows.map(r=>[r.personUid,r.text])).toEqual([['peer','revised'],['other','hello']]);
    f.revoke();f.controller.update(f.view);f.remote({...message,revision:3});expect(f.state.rows).toEqual([]);f.controller.dispose();
  });
  it('emits wire-valid integer timestamps for non-integer millisecond audio frames',async()=>{
    const f=fixture();await flush();await f.controller.startSession('company');await flush();f.pcm(8001);await flush();expect(f.send).toHaveBeenCalled();expect(parseTranscript(f.send.mock.calls[0]?.[1])).not.toBeNull();f.controller.dispose();
  });
  it('bounds undelivered backlog and expires it instead of replaying all captured phrases',async()=>{
    const f=fixture();await flush();await f.controller.startSession('company');await flush();f.send.mockReturnValue(false);
    for(let i=0;i<200;i++){f.pcm();await flush();}
    f.send.mockClear();f.send.mockReturnValue(true);f.controller.update(f.view);
    expect(f.send.mock.calls.length).toBeLessThanOrEqual(128);
    f.send.mockClear();await vi.advanceTimersByTimeAsync(16000);expect(f.send).not.toHaveBeenCalled();f.controller.dispose();
  });
  it('expires undeliverable text before a disconnected peer returns',async()=>{
    const f=fixture();await flush();await f.controller.startSession('company');await flush();f.send.mockReturnValue(false);f.pcm();await flush();
    await vi.advanceTimersByTimeAsync(16000);f.send.mockClear();f.send.mockReturnValue(true);f.controller.update(f.view);
    expect(f.send).not.toHaveBeenCalled();f.controller.dispose();
  });
  it('bounds visible remote transcript history',async()=>{
    const f=fixture();await flush();await f.controller.startSession('company');await flush();for(let i=0;i<1100;i++)f.remote({...message,segmentId:String(i),startMs:i,endMs:i+1});expect(f.state.rows).toHaveLength(1000);f.controller.dispose();
  });
});


describe('explicit transcription sessions',()=>{
  it('ignores stored automatic opt-in',async()=>{const f=fixture({storage:{getItem:()=>"true",setItem:vi.fn()}});await flush();await vi.advanceTimersByTimeAsync(5000);expect(contexts).toHaveLength(0);expect(f.state.session).toBeNull();f.controller.dispose();});
  it('personal captures own microphone with other people without sharing',async()=>{const f=fixture({unsupported:true});await flush();await f.controller.startSession('personal');await flush();f.pcm();await flush();expect(f.state.rows[0]?.text).toBe('recognized');expect(f.state.session?.scope).toBe('personal');expect(f.send).not.toHaveBeenCalled();f.controller.dispose();});
  it('company starts while alone without unmuting',async()=>{const f=fixture({solo:true});f.view.media.microphone.active=false;await flush();await f.controller.startSession('company');await flush();expect(f.state.session?.scope).toBe('company');expect(contexts).toHaveLength(0);expect(f.state.status).toBe('muted');f.controller.dispose();});
  it('pause discards in-flight audio and resume uses fresh interval',async()=>{const f=fixture();await flush();await f.controller.startSession('company');await flush();let finish!:(v:{text:string})=>void;f.recognize.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));f.pcm();await flush();const old=taps.at(-1)!;await f.controller.pauseSession();finish({text:'off record'});await flush();expect(old.port.onmessage).toBeNull();expect(f.state.rows).toEqual([]);expect(f.state.session?.state).toBe('paused');await f.controller.resumeSession();await flush();f.pcm();await flush();expect(f.state.rows).toHaveLength(1);expect(f.state.session?.interval).toBe(2);f.controller.dispose();});
  it('new personal start has new identity',async()=>{const f=fixture({unsupported:true});await flush();await f.controller.startSession('personal');const first=f.state.session?.id;await f.controller.endSession();expect(f.state.session?.state).toBe('ended');await f.controller.startSession('personal');expect(f.state.session?.id).not.toBe(first);f.controller.dispose();});
  it('late joiners follow authority but cannot pause another starter',async()=>{const f=fixture();await flush();f.setServerSession({sessionId:'remote',starterPersonUid:'peer',state:'recording',startedAt:0,activeSince:0,elapsedMs:0,pausedAt:null,endedAt:null,interval:1});await vi.advanceTimersByTimeAsync(2000);expect(f.state.session?.id).toBe('remote');await expect(f.controller.pauseSession()).rejects.toThrow('Only the person');f.controller.dispose();});
  it('expires authority before processing more audio',async()=>{const f=fixture();await flush();await f.controller.startSession('company');await flush();f.sessionCommand.mockRejectedValue(new Error('offline'));await vi.advanceTimersByTimeAsync(8000);expect(f.state.status).toBe('paused');f.pcm();await flush();expect(f.recognize).not.toHaveBeenCalled();f.controller.dispose();});
  it('revalidates server interval after ASR and drops remotely paused results',async()=>{
    const f=fixture();await flush();await f.controller.startSession('company');await flush();
    let finish!:(v:{text:string})=>void;f.recognize.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));f.pcm();await flush();
    f.setServerSession({sessionId:'c1',starterPersonUid:'self',state:'paused',startedAt:0,activeSince:null,elapsedMs:10,pausedAt:Date.now(),endedAt:null,interval:1});
    finish({text:'must stay off record'});await flush();expect(f.state.rows).toEqual([]);expect(f.send).not.toHaveBeenCalled();expect(f.state.session?.state).toBe('paused');f.controller.dispose();
  });
  it('company session preempts personal capture without sharing personal text',async()=>{
    const f=fixture();await flush();await f.controller.startSession('personal');await flush();f.pcm();await flush();
    f.setServerSession({sessionId:'shared',starterPersonUid:'peer',state:'recording',startedAt:0,activeSince:0,elapsedMs:0,pausedAt:null,endedAt:null,interval:1});
    await vi.advanceTimersByTimeAsync(2000);expect(f.state.mode).toBe('room');expect(f.state.rows).toEqual([]);expect(f.state.sessionNotice).toContain('Personal session ended');expect(f.send).not.toHaveBeenCalled();await expect(f.controller.startSession('personal')).rejects.toThrow('End company');f.controller.dispose();
  });

  it('refuses start after account authority is lost',async()=>{const f=fixture();await flush();f.revoke();await expect(f.controller.startSession('personal')).rejects.toThrow('Join the room');expect(f.state.session).toBeNull();f.controller.dispose();});

  it.each([0,1])('rejects a reversed stale recording response after paused authority (time offset %s)',async delta=>{
    const f=fixture();await flush();await f.controller.startSession('company');await flush();
    const base={sessionId:'c1',starterPersonUid:'self',startedAt:100000,elapsedMs:0,pausedAt:null,endedAt:null,interval:1};
    let late!:(value:any)=>void;
    f.sessionCommand.mockImplementationOnce(()=>new Promise(resolve=>late=resolve));
    await vi.advanceTimersByTimeAsync(2000); // Background poll is delayed.
    f.sessionCommand.mockResolvedValue({serverTime:102000,session:{...base,state:'paused',activeSince:null,pausedAt:102000}});
    f.pcm();await flush();expect(f.state.session?.state).toBe('paused');
    late({serverTime:102000-delta,session:{...base,state:'recording',activeSince:100000}});await flush();
    expect(f.state.session?.state).toBe('paused');expect(f.state.rows).toEqual([]);expect(f.send).not.toHaveBeenCalled();f.controller.dispose();
  });
  it('never reopens ended session even with newer interval and server time',async()=>{
    const f=fixture();await flush();await f.controller.startSession('company');await f.controller.endSession();
    f.setServerSession({sessionId:'c1',starterPersonUid:'self',state:'recording',startedAt:100000,activeSince:102000,elapsedMs:0,pausedAt:null,endedAt:null,interval:2});
    await vi.advanceTimersByTimeAsync(2000);expect(f.state.session?.state).toBe('ended');f.controller.dispose();
  });

  it.each(['left','error'] as const)('preserves ended personal notes through %s transport state',async status=>{
    const f=fixture({unsupported:true});await flush();await f.controller.startSession('personal');await flush();f.pcm();await flush();await f.controller.endSession();
    const id=f.state.session?.id;f.view.status=status;f.view.code='ACCOUNT_RECONNECT_REQUIRED';f.controller.update(f.view);
    expect(f.state.session?.id).toBe(id);expect(f.state.session?.state).toBe('ended');expect(f.state.rows[0]?.text).toBe('recognized');f.controller.dispose();
  });
  it('pauses active personal notes on connection loss without resuming implicitly',async()=>{
    const f=fixture({unsupported:true});await flush();await f.controller.startSession('personal');await flush();f.pcm();await flush();
    f.view.authorityPaused=true;f.controller.update(f.view);expect(f.state.session?.state).toBe('paused');expect(f.state.rows).toHaveLength(1);
    f.view.authorityPaused=false;f.controller.update(f.view);expect(f.state.session?.state).toBe('paused');await f.controller.resumeSession();expect(f.state.session?.state).toBe('active');f.controller.dispose();
  });
  it('still erases private rows and session on a real account switch',async()=>{
    const f=fixture({unsupported:true});await flush();await f.controller.startSession('personal');await flush();f.pcm();await flush();f.revoke();f.controller.update(f.view);expect(f.state.session).toBeNull();expect(f.state.rows).toEqual([]);f.controller.dispose();
  });

});
