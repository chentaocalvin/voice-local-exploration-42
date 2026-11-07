import { encodePcm32 } from '../../issue42/pcm.mjs';
import { sha256 } from '../../issue42/identity.mjs';
const n=352800, frames=1601, expiry=10000, runExpiry=9000;
function soloWav() {
  const bytes=new Uint8Array(44+2*n), view=new DataView(bytes.buffer);
  for(const [at,text]of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])bytes.set(new TextEncoder().encode(text),at);
  for(const [at,v]of [[4,bytes.length-8],[16,16],[24,44100],[28,88200],[40,n*2]])view.setUint32(at,v,true);
  for(const [at,v]of [[20,1],[22,1],[32,2],[34,16]])view.setUint16(at,v,true);
  for(let i=0;i<n;i++)view.setInt16(44+i*2,Math.round((1+.15*Math.sin(2*Math.PI*3*i/44100))*(4000*Math.sin(2*Math.PI*300*i/44100)+1200*Math.sin(2*Math.PI*4200*i/44100))),true);
  return bytes;
}
export async function explorationFixture(kind=null) {
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const voiceBytes=soloWav(), soloHash=await sha256(voiceBytes);
  const voice=Float64Array.from({length:n},(_,i)=>(1+.15*Math.sin(2*Math.PI*3*i/44100))*(.12*Math.sin(2*Math.PI*300*i/44100)+.025*Math.sin(2*Math.PI*4200*i/44100)));
  const mix=voice.map((v,i)=>v+.04*Math.sin(2*Math.PI*180*i/44100));
  const pianoVoice=encodePcm32(voice,n,n), pianoMix=encodePcm32(mix,n,n);
  const decode=bytes=>{const view=new DataView(bytes.buffer);return Float64Array.from({length:n},(_,i)=>view.getInt32(44+4*i,true)/2147483648);};
  const hashes={voiceSha256:await sha256(pianoVoice),mixSha256:await sha256(pianoMix),neutralVoiceSha256:await sha256(encodePcm32(decode(pianoVoice),n,n)),neutralMixSha256:await sha256(encodePcm32(decode(pianoMix),n,n))};
  const prove=async(input,claims)=>{const payload=new TextEncoder().encode(JSON.stringify({expires:expiry,frames:n,...claims}));return {...input,payload,signature:new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,payload))};};
  const solo=await prove({voiceBytes},{schema:'voice-private-solo-v1',role:'solo_recording',axis:'mono-pcm16-44100',voice_sha256:soloHash,preferred:[621,870]});
  const piano=await prove({voiceBytes:pianoVoice,mixBytes:pianoMix},{schema:'voice-piano-source-v1',role:'estimated_vocal_component',axis:'mono-pcm32-44100',voice_sha256:hashes.voiceSha256,mix_sha256:hashes.mixSha256});
  const analysis={frames,time:Float64Array.from({length:frames},(_,i)=>i/200),f0:Float64Array.from({length:frames},(_,i)=>300*2**(12*Math.sin(2*Math.PI*6*i/200)/1200)),sp:new Float64Array(frames*1025).fill(1),ap:new Float64Array(frames*1025).fill(.2)};
  const events=[], calls={pitch:0,analyze:0,synthesize:0}; let clock=0;
  const sdk={pitch:async()=>{calls.pitch++;return Array.from(analysis.time,(time,i)=>({time,hz:analysis.f0[i],undefined:false}));},analyze:async()=>{calls.analyze++;return analysis;},synthesize:async()=>{calls.synthesize++;throw new Error('unexpected_synthesis');},voiceQuality:async()=>1};
  const options={sdk,publicKey:key.publicKey,now:()=>clock,reserve:async e=>events.push(e),privateSourceExpiries:{solo:expiry,piano:expiry},privateRunExpires:runExpiry,privateExploration:{profile:'issue38-joint-exploration-v1',solo:{sourceSha256:soloHash,expires:expiry},piano:{...hashes,expires:expiry}}};
  return {solo,piano,input:kind==='piano'?piano:solo,options,events,analysis,calls,clock:v=>{clock=v;}};
}
