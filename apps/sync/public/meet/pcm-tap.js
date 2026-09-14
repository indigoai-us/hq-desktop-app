// Tap the existing call microphone. No capture device is opened here.
class MeetPcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.samples=[]; this.phase=0; this.silent=0; this.speech=false; }
  process(inputs) {
    const input=inputs[0]?.[0];
    if (!input) return true;
    let energy=0;
    for (const value of input) energy+=value*value;
    const speaking=Math.sqrt(energy/input.length)>0.008;
    this.speech ||= speaking;
    this.silent=speaking ? 0 : this.silent+input.length/sampleRate;
    for (const value of input) {
      this.phase+=16000;
      if(this.phase>=sampleRate){this.phase-=sampleRate;this.samples.push(value);
        if(this.samples.length===96000){
          if(this.speech)this.port.postMessage(new Float32Array(this.samples));
          this.samples=[];this.speech=speaking;this.silent=0;
        }}
    }
    if(this.samples.length>=96000 || (this.speech && this.silent>=0.6 && this.samples.length>=8000)) {
      if(this.speech) this.port.postMessage(new Float32Array(this.samples));
      this.samples=[];this.speech=false;this.silent=0;
    } else if (!this.speech && this.samples.length>=8000) this.samples=[];
    return true;
  }
}
registerProcessor('meet-pcm-tap',MeetPcmTap);
