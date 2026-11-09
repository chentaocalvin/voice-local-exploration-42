/** Ticket 41 qualification candidate: source_plan/r6_source, not yet run.
 * Caller must authenticate input bytes, Praat implementation and WORLD arrays.
 * This code does not certify sound quality or replace comparison against native.
 */
const FS = 44100, STEP = 0.005, WINDOW = 176400;
const fail = (reason) => { throw new Error(reason); };
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const tieEven = (x) => { const a = Math.floor(x), d = x - a; return d < .5 ? a : d > .5 ? a + 1 : a % 2 === 0 ? a : a + 1; };
const median = (a) => { if (!a.length) fail('empty_median'); const b = [...a].sort((x,y) => x-y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m-1] + b[m]) / 2; };
function intervals(mask) {
  const r=[]; let start=-1;
  for(let i=0;i<=mask.length;i++) { const on=i<mask.length && mask[i]; if(on && start<0) start=i; if(!on && start>=0){r.push([start,i]);start=-1;} }
  return r;
}

/** Map a regular track exactly halfway between frames to the later frame. */
function regularHalfGrid(track) {
  const stepNs = 5_000_000, halfNs = stepNs / 2;
  if (track.length < 2) return null;
  const firstNs = Math.round(track[0].time * 1e9);
  if (!Number.isSafeInteger(firstNs) || firstNs % stepNs !== halfNs) return null;
  for (let i = 0; i < track.length; i++) {
    const expectedNs = firstNs + i * stepNs;
    if (!Number.isSafeInteger(expectedNs) || track[i].time !== expectedNs / 1e9) return null;
  }
  return (firstNs + halfNs) / stepNs;
}

export function alignPraat(frames, track) {
  if (!Number.isSafeInteger(frames) || frames<1 || !Array.isArray(track) || !track.length) fail('invalid_track');
  let previous = -1;
  for (const row of track) {
    if(!row || !finite(row.time) || row.time<0 || row.time<=previous || typeof row.undefined!=='boolean' ||
       !finite(row.hz) || row.hz<0 || (row.undefined && (row.hz!==0 || Object.is(row.hz,-0)))) fail('invalid_track');
    previous = row.time;
  }
  const seen = new Set();
  let collision = false;
  const legacy = track.map((row) => {
    const index = tieEven(row.time / STEP);
    if (index < 0 || index >= frames || Math.abs(row.time - index * STEP) > .0025) return null;
    if (seen.has(index)) collision = true;
    seen.add(index);
    return index;
  });
  const halfGridStart = collision ? regularHalfGrid(track) : null;
  if (collision && halfGridStart === null) fail('ambiguous_independent_mapping');
  const result = new Float64Array(frames).fill(NaN);
  for (const [offset, row] of track.entries()) {
    const index = halfGridStart === null ? legacy[offset] : halfGridStart + offset;
    if (index !== null && index < frames && !row.undefined) result[index] = row.hz;
  }
  return result;
}

function kernel101() {
  const k=new Float64Array(101); let mean=0;
  const sinc=(x)=>x===0?1:Math.sin(Math.PI*x)/(Math.PI*x);
  for(let i=0;i<101;i++){const t=i-50; k[i]=(18/200*sinc(18/200*t)-8/200*sinc(8/200*t))*(.5-.5*Math.cos(2*Math.PI*i/100));mean+=k[i];}
  mean/=101; let real=0,imag=0;
  for(let i=0;i<101;i++){k[i]-=mean;const angle=-2*Math.PI*6.5/200*(i-50);real+=k[i]*Math.cos(angle);imag+=k[i]*Math.sin(angle);}
  const norm=Math.hypot(real,imag); if(!finite(norm)||norm===0) fail('invalid_kernel');
  for(let i=0;i<101;i++) k[i]/=norm; return k;
}
function legalStarts(samples) {
  if(samples<WINDOW) return []; const out=[], n=Math.floor((2*(samples-WINDOW)+1)/441);
  for(let k=0;k<=n;k++){const q=Math.floor(441*k/2), rem=(441*k)%2, s=q+(rem===1&&q%2===1?1:0);if(s+WINDOW<=samples)out.push(s);}
  return out;
}
function better(a,b){return !b || a[0]>b[0] || (a[0]===b[0] && (a[1]>b[1] || (a[1]===b[1] && a[2]>b[2])));}

export const frozenCalibrationStart=(hash)=>hash==='bc05e72ecdc1e6855ed00a029836265ce103a03bccb9756fbdf3e93c404618db'?1092578:null;

// A frozen cross-runtime window may resolve a true tie only. Recompute both
// candidates locally; do not import the native masks or accept near-equality.
export function selectSharedCalibration(best, shared) {
  const equal=(a,b)=>a instanceof Float64Array&&b instanceof Float64Array&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  if(!best||!shared||!Number.isFinite(best.component_rms_whole_cents)||
      !Object.is(best.component_rms_whole_cents,shared.component_rms_whole_cents)||
      best.longest_support_frames!==shared.longest_support_frames||
      !equal(best.component_cents,shared.component_cents)||!equal(best.weight,shared.weight)||
      best.eligible.length!==shared.eligible.length||!best.eligible.every((v,i)=>v===shared.eligible[i])||
      JSON.stringify(best.segments)!==JSON.stringify(shared.segments)||
      best.native_source_estimable!==shared.native_source_estimable||
      best.source_bias_cents!==shared.source_bias_cents||best.source_noise_proxy_cents!==shared.source_noise_proxy_cents)
    fail('shared_calibration_not_exact_tie');
  return shared;
}

/** Native scoring and gates, plus an authenticated frozen-input exact-tie anchor. */
export function sourcePlan(f0, independent, samples, sharedStart=null, accept=null, onCondition=null) {
  if(!(f0 instanceof Float64Array) || !(independent instanceof Float64Array) || f0.length!==independent.length ||
      !Number.isSafeInteger(samples) || samples<=0 || f0.length!==Math.floor(1000*samples/FS/5)+1) fail('invalid_source_tracks');
  if(sharedStart!==null&&(!Number.isSafeInteger(sharedStart)||sharedStart<0))fail('invalid_shared_calibration');
  let shared=null;const n=f0.length, eligible=new Uint8Array(n), band=new Float64Array(n), pitch=new Float64Array(n), voiced=new Uint8Array(n);
  for(let i=0;i<n;i++){if(!finite(f0[i])||f0[i]<0||f0[i]>=FS/2 || !(finite(independent[i]) || Number.isNaN(independent[i])) || independent[i]<0) fail('invalid_source_tracks');
    if(f0[i]>0){voiced[i]=1;pitch[i]=1200*Math.log2(f0[i]);}}
  const voicedRuns = intervals(voiced);
  const edgeSupport = new Uint8Array(n), transitionSupport = new Uint8Array(n);
  const search = {
    schema: 'voice-motion-search-diagnostic-v1',
    longest_voiced_run_frames: Math.max(0, ...voicedRuns.map(([a, b]) => b - a)),
    runs_at_least_250_frames: voicedRuns.filter(([a, b]) => b - a >= 250).length,
    after_minimum_run_frames: voicedRuns.reduce((sum, [a, b]) => sum + (b - a >= 250 ? b - a : 0), 0),
    independent_supported_frames: independent.reduce((sum, value) => sum + (finite(value) && value > 0 ? 1 : 0), 0),
    legal_windows: 0, windows_with_750ms_support: 0, windows_with_1200ms_span: 0, windows_with_headroom: 0,
  };
  const kernel=kernel101();
  for(const [first,last] of voicedRuns) {
    const len=last-first; if(len<250)continue;
    const slow=new Float64Array(len), p=pitch.subarray(first,last);
    for(let i=0;i<len;i++){const a=[];for(let j=-50;j<=50;j++)a.push(p[Math.max(0,Math.min(len-1,i+j))]);slow[i]=median(a);}
    const support=new Uint8Array(len).fill(1); support.fill(0,0,50);support.fill(0,len-50);
    for(let i=0;i<len;i++) if(Math.abs(slow[Math.min(i+10,len-1)]-slow[Math.max(i-10,0)])>100) support.fill(0,Math.max(0,i-50),Math.min(len,i+51));
    for(let i=0;i<len;i++){
      edgeSupport[first+i] = i >= 50 && i < len - 50 ? 1 : 0;
      transitionSupport[first+i] = support[i];
      eligible[first+i]=support[i] && finite(independent[first+i]) && independent[first+i]>0 ? 1:0;
      let sum=0;for(let j=-50;j<=50;j++){let x=i+j;if(x<0)x=-x;if(x>=len)x=2*len-2-x;sum+=(p[x]-p[i])*kernel[j+50];} band[first+i]=sum;
    }
  }
  let best=null, score=null, candidates=0, overLimit=0; const low=1200*Math.log2(71), high=1200*Math.log2(800);
  for(const start of legalStarts(samples)) {
    search.legal_windows++;
    const end=start+WINDOW, mask=new Uint8Array(n);
    for(let i=0;i<n;i++) if(eligible[i] && 441*i>=2*(start+4410) && 441*i<2*(end-4410))mask[i]=1;
    const runs=intervals(mask).filter(([a,b])=>(b-a)*STEP>=.75); if(!runs.length)continue;
    search.windows_with_750ms_support++;
    let [a,b]=runs[0];for(const [x,y] of runs)if(y-x>b-a || (y-x===b-a&&x<a)){a=x;b=y;}
    if((b-1)*STEP-a*STEP<1.2)continue;
    search.windows_with_1200ms_span++;
    let headroomOk=true;
    for(let i=a;i<b;i++)if(pitch[i]-50<low || pitch[i]+50>high){headroomOk=false;break;} if(!headroomOk)continue;
    search.windows_with_headroom++;
    const component=new Float64Array(n), weights=new Float64Array(n), segments=[];
    for(const [first,last] of runs){
      let rawPeak=0, minHead=Infinity; for(let i=first;i<last;i++){rawPeak=Math.max(rawPeak,Math.abs(band[i]));minHead=Math.min(minHead,pitch[i]-low,high-pitch[i]);}
      const alpha=rawPeak?Math.min(1,50/rawPeak):1, fade=Math.min(.1,((last-1)*STEP-first*STEP)/2);let ws=0,dot=0;
      for(let i=first;i<last;i++){const dist=Math.min(i*STEP-first*STEP,(last-1)*STEP-i*STEP), w=(.5-.5*Math.cos(Math.PI*Math.min(dist/fade,1)))*Math.min(1,Math.min(pitch[i]-low,high-pitch[i])/200);weights[i]=w;ws+=w;dot+=w*alpha*band[i];}
      if(minHead<0 || ws===0){weights.fill(0,first,last);continue;}
      const center=dot/ws;for(let i=first;i<last;i++)component[i]=weights[i]*(alpha*band[i]-center);
      segments.push({start_frame:first,end_frame:last,rawband_peak_cents:rawPeak,alpha,minimum_headroom_cents:minHead});
    }
    candidates++;let square=0, selected=0, supportSq=0,supportN=0;const errors=[];
    for(let i=0;i<n;i++){if(441*i>=2*start&&441*i<2*end){square+=component[i]*component[i];selected++;}if(component[i]!==0){supportSq+=component[i]*component[i];supportN++;if(finite(independent[i])&&independent[i]>0)errors.push(1200*Math.log2(f0[i]/independent[i]));}}
    const rms=selected?Math.sqrt(square/selected):NaN, candidate=[b-a,rms,-start];const wins=better(candidate,score);if(!wins&&start!==sharedStart)continue;
    const rmsSupport=supportN?Math.sqrt(supportSq/supportN):0,bias=errors.length?median(errors):null,noise=errors.length?1.4826*median(errors.map(x=>Math.abs(x-bias))):null;
    const computed={start_sample:start,end_sample:end,longest_support_frames:b-a,calibration_a_seconds:a*STEP,calibration_b_seconds:(b-1)*STEP,calibration_eligible:true,
      component_rms_whole_cents:rms,component_rms_support_cents:rmsSupport,component_nonzero_frames:supportN,source_bias_cents:bias,source_noise_proxy_cents:noise,
      native_source_estimable:rmsSupport>0&&bias!==null&&Math.abs(bias)<rmsSupport&&noise!==null&&noise<rmsSupport,segments,component_cents:component,weight:weights,rawband_cents:band,eligible};
    if (accept && computed.component_cents.some((x) => Math.abs(x) > 50)) {
      overLimit++;
      onCondition?.('condition_insufficient_postcenter_over50');
      continue;
    }
    if (accept && !accept(computed)) continue;
    if(start===sharedStart)shared=computed;if(wins){best=computed;score=candidate;}
  }
  if (!best) {
    const reason = accept && candidates ? 'condition_insufficient_no_fully_qualified_window' : 'condition_insufficient_no_calibration_window';
    throw Object.assign(new Error(reason), { motionSearch: {
      ...search,
      after_edges_frames: edgeSupport.reduce((sum, value) => sum + value, 0),
      longest_after_edges_run_frames: Math.max(0, ...intervals(edgeSupport).map(([a, b]) => b - a)),
      after_transitions_frames: transitionSupport.reduce((sum, value) => sum + value, 0),
      longest_after_transitions_run_frames: Math.max(0, ...intervals(transitionSupport).map(([a, b]) => b - a)),
      eligible_frames: eligible.reduce((sum, value) => sum + value, 0),
      longest_eligible_run_frames: Math.max(0, ...intervals(eligible).map(([a, b]) => b - a)),
      compiled_candidates: candidates, postcenter_rejected_windows: overLimit,
    } });
  }
  if(sharedStart!==null)best=selectSharedCalibration(best,shared);
  if(best.component_cents.some(x=>Math.abs(x)>50))fail('condition_insufficient_postcenter_over50');
  best.legal_calibration_candidates=candidates;best.postcenter_over50_rejected_windows=overLimit;
  best.independent_missing_frames=independent.reduce((n,x)=>n+(!finite(x)?1:0),0);best.source_voiced_frames=voiced.reduce((n,x)=>n+x,0);
  return best;
}

export function localQualityTimbreIntervals({ f0, ap }, [first, last]) {
  const q = new Uint8Array(f0.length), t = new Uint8Array(f0.length);
  for (let i = first; i < last; i++) {
    t[i] = f0[i] >= FS / 2048 + 1 ? 1 : 0;
    q[i] = t[i] && ap[i * 1025] ** 2 <= .999 ? 1 : 0;
  }
  return { Q: intervals(q), T: intervals(t) };
}

/** Producer-derived intervals for the original frame and immutable AP parent. */
export function qualifySource({f0,time,ap,frames,samples,track,inputSha256,methodVersion}, verifyFallback=null, historicalDefault=false, requireJointSupport=false, onCondition=null) {
  if(!Number.isSafeInteger(frames)||frames!==f0?.length || !(time instanceof Float64Array)||time.length!==frames ||
      !(ap instanceof Float64Array)||ap.length!==frames*1025 || !/^[0-9a-f]{64}$/.test(inputSha256) || typeof methodVersion!=='string'||!methodVersion) fail('invalid_input');
  for(let i=0;i<frames;i++){if(!finite(time[i])||Math.abs(time[i]-i*STEP)>1e-12)fail('invalid_time');}
  for(const x of ap)if(!finite(x)||x<0||x>1)fail('invalid_ap');
  const independent = alignPraat(frames, track);
  const sharedStart = frozenCalibrationStart(inputSha256);
  function qualify(plan) {
    if(plan.native_source_estimable!==true)fail('condition_insufficient_independent_track');
    const outer=new Uint8Array(frames), m=new Uint8Array(frames);
    for(let i=0;i<frames;i++){outer[i]=441*i>=2*plan.start_sample&&441*i<2*plan.end_sample?1:0;
      m[i]=outer[i]&&plan.weight[i]>0?1:0;}
    const motion=intervals(m).filter(([a,b])=>(b-a-1)*STEP>=.75);if(!motion.length||!plan.segments.length)fail('condition_insufficient_motion');
    const region=motion.reduce((best,x)=>!best || x[1]-x[0]>best[1]-best[0]?x:best,null), win=intervals(outer);
    if(win.length!==1)fail('invalid_window');
    return {schema:'issue41-qualification-candidate-v1',input_sha256:inputSha256,method_version:methodVersion,sample_rate:FS,input_frames:samples,
      window_samples:[plan.start_sample,plan.end_sample],window_frames:win[0],eligible_intervals:{M:motion,...localQualityTimbreIntervals({f0,ap},win[0])},default_region:region,plan,independent};
  }
  try {
    const source = qualify(sourcePlan(f0, independent, samples, sharedStart));
    const [first, last] = source.default_region;
    if (!historicalDefault && !source.eligible_intervals.T.some(([a, b]) => a <= first && last <= b)) {
      fail('condition_insufficient_T_region');
    }
    if (requireJointSupport && !verifyFallback?.(source)) fail('condition_insufficient_joint_region');
    return source;
  } catch (error) {
    if (sharedStart !== null || !verifyFallback || ![
      'condition_insufficient_postcenter_over50', 'condition_insufficient_independent_track',
      'condition_insufficient_motion', 'condition_insufficient_T_region', 'condition_insufficient_joint_region',
    ].includes(error.message)) throw error;
    onCondition?.(error.message);
  }
  let selected;
  sourcePlan(f0, independent, samples, null, (plan) => {
    let candidate;
    try {
      candidate = qualify(plan);
    } catch (error) {
      if (['condition_insufficient_independent_track', 'condition_insufficient_motion'].includes(error.message)) {
        onCondition?.(error.message);
        return false;
      }
      throw error;
    }
    const [first, last] = candidate.default_region;
    if (!candidate.eligible_intervals.T.some(([a, b]) => a <= first && last <= b)) {
      onCondition?.('condition_insufficient_T_region');
      return false;
    }
    if (!verifyFallback(candidate)) return false;
    selected = candidate;
    return true;
  }, onCondition);
  return selected;
}
