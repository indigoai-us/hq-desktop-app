import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {it,expect} from 'vitest';
it('bounds continuous speech chunks at common device sample rates and drops silence',()=>{
 for(const rate of [16000,44100,48000]){
  const chunks:Float32Array[]=[];let Processor:any;
  runInNewContext(readFileSync(new URL('../../public/meet/pcm-tap.js',import.meta.url),'utf8'),{
   sampleRate:rate,Float32Array,AudioWorkletProcessor:class{port={postMessage:(v:Float32Array)=>chunks.push(v)};},registerProcessor:(_name:string,p:any)=>Processor=p,
  });
  const processor=new Processor();
  for(let i=0;i<Math.ceil(rate*14/128);i++)processor.process([[new Float32Array(128).fill(.2)]]);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks.every(c=>c.length<=96000)).toBe(true);
  expect(chunks[0].length).toBe(96000);
  chunks.length=0;const silent=new Processor();
  for(let i=0;i<Math.ceil(rate*8/128);i++)silent.process([[new Float32Array(128)]]);
  expect(chunks).toHaveLength(0);
 }
});
