import './style.css';
import { defaultRig, automaticEdges, layout, parseRig, setOverlap, resetCalibration, overlapFromSeam, type ResetPart, type Rig } from './rig';
import { ProjectorRenderer, type CalibrationPattern } from './renderer';
import { dimensions, sampleWarp, changeWarp, blendBoundary, usablePerspective, type WarpType } from './warp';
import { drawTestPattern } from './testPatterns';

type Display = { id: string; name: string; width: number; height: number; operator: boolean; refreshRate?:number };
type Frame = { width: number; height: number; sequence: number; fps: number; ageMs: number; data: Uint8Array };
type Bridge = {
  exportFile?(kind:'rig'|'diagnostics',text:string):Promise<string|null>;
  readRig?():Promise<{current:string|null;previous:string|null}>; saveRig?(text:string):Promise<boolean>;
  outputStatus?():Promise<{id:string;displayId:string;fullscreen:boolean}[]>;
  status(): Promise<{ available: boolean; error: string; smoke?: boolean }>;
  statistics?():Promise<{running:boolean;received?:number;dropped?:number;queued?:number;connections?:number}|null>;
  sources(): Promise<string[]>; connect(name: string): Promise<void>; disconnect(): Promise<void>;
  frame(): Promise<Frame | null>; displays(): Promise<Display[]>;
  openOutput(id: string, displayId: string): Promise<void>; closeOutputs(): Promise<void>;
  ready?(info: { outputs: number; width: number; frameTextureTest: boolean; outputStreams?:boolean; calibrationTests?:boolean; liveModeTest?:boolean; outputDetails?:unknown }): Promise<unknown>;
};
declare global { interface Window { mapper?: Bridge; mapperStreams?: Record<string, MediaStream> } }
const root = document.querySelector<HTMLDivElement>('#app')!;
const outputId = new URLSearchParams(location.search).get('output');
const escape = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

if (outputId && /^projector-[0-2]$/.test(outputId)) {
  document.body.className = 'output-window';
  root.innerHTML = '<video autoplay muted playsinline></video><span class="waiting">Waiting for operator preview stream… · Escape closes output</span>';
  const video = root.querySelector('video')!;
  let presentedFrames=0,whiteFrames=0,grayFrames=0,pixel:number[]|undefined;
  const probe=new URLSearchParams(location.search).has('probe');
  const sample=document.createElement('canvas');sample.width=sample.height=1;
  const sampleContext=sample.getContext('2d')!;
  const onFrame=()=>{
    presentedFrames++;
    if(probe&&video.readyState>=2){
      sampleContext.drawImage(video,960,540,1,1,0,0,1,1);pixel=Array.from(sampleContext.getImageData(0,0,1,1).data);
      if(pixel.slice(0,3).every(n=>n>240))whiteFrames++;
      if(pixel.slice(0,3).every(n=>Math.abs(n-128)<6))grayFrames++;
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  const report=setInterval(()=>{
    if(!window.opener||window.opener.closed){clearInterval(report);window.close();return;}
    window.opener.postMessage({type:'mapper-output',id:outputId,width:video.videoWidth,height:video.videoHeight,frames:presentedFrames,ready:video.readyState>=2,pixel,whiteFrames,grayFrames},'*');
  },1000);
  const wait = setInterval(() => {
    try {
      const stream = window.opener?.mapperStreams?.[outputId];
      if (stream) {
        video.srcObject=stream;
        void video.play().then(()=>root.querySelector('.waiting')?.remove()).catch(()=>{const message=root.querySelector('.waiting');if(message)message.textContent='Playback failed. Close and reopen this output.';});
        clearInterval(wait);
      } else if (!window.opener || window.opener.closed) { clearInterval(wait); window.close(); }
    } catch { const message=root.querySelector('.waiting');if(message)message.textContent='Output link unavailable. Reopen from the operator window.';clearInterval(wait); }
  }, 100);
  addEventListener('keydown', e => { if (e.key === 'Escape') window.close(); });
} else {
  void start();
}

async function start() {
  let rig = defaultRig(), selected = 0, editMode: 'mesh' | 'mask' = 'mesh';
  let sourceMode: 'pattern' | 'ndi' = 'pattern', connected = false, blackout = false, locked = false;
  let displays: Display[] = [], sources: string[] = [], lastFrameAt = 0, sequence = 0, nominalFps = 0, measuredFps = 0;
  let sampleSequence = 0, sampleTime = performance.now(), receiveError = '', nativeAvailable = false;
  let busy = false, connectionGeneration = 0, tickCount = 0, patternCount = 0, renderFailed = false;
  let ndiStatistics:Awaited<ReturnType<NonNullable<Bridge['statistics']>>>=null;
  let latestFrame:Frame|null=null, uploadedSequence=-1, smokeMode=false;
  let activePoint=0, sourceRevision=0, contentKey='', outputKey='', lastPreviewAt=0, presented=0, presentedFps=0, presentedSample=0, presentedAt=performance.now(), lastPresentedSequence=0, lastRenderMs=0;
  let calibrationPattern:CalibrationPattern='none',solo=false,identify=false,monitor=true,monitorSequence=-1;
  let liveMode=false,autoLivePending=false,monitorBeforeLive=true,lockBeforeLive=false;
  let monitorCopies=0,warpCopies=0;
  let recoveryCopy:string|null=null, recovered=false, smokeStarted=false;
  const routeErrors=new Map<string,string>();
  const outputReports=new Map<string,{width:number;height:number;frames:number;ready:boolean;pixel?:number[];whiteFrames?:number;grayFrames?:number;at:number}>();
  const undo: string[] = [], redo: string[] = [], children = new Map<string, Window>();
  try { const saved = localStorage.getItem('mapper-rig-v1'); if (saved) rig = parseRig(saved); } catch { /* default rig if old/corrupt */ }
  try {
    const saved=await window.mapper?.readRig?.();
    recoveryCopy=saved?.previous??null;
    if(saved?.current){try{rig=parseRig(saved.current);}catch{if(recoveryCopy){rig=parseRig(recoveryCopy);recovered=true;}}}
  } catch { /* local autosave remains available if desktop storage cannot be read */ }
  root.innerHTML = `
    <header><div class="brand"><span class="mark">◩</span><div><h1>Three Projector Mapper <small>PROTOTYPE 0.5 · WINDOWS x64</small></h1><p>One source. Three calibrated outputs.</p></div></div><div class="actions"><button id="live-mode">Live mode · previews off</button><button id="setup-help">Setup guide</button><button id="undo">Undo</button><button id="redo">Redo</button><button id="load">Load rig</button><button id="save">Save rig</button><button id="blackout" class="danger">Blackout outputs</button></div></header>
    <div id="live-banner" class="live-banner" hidden>LIVE MODE · Operator previews paused. NDI reception and all projector outputs continue. Choose Calibrate to resume previews.</div><div id="notice" role="status" aria-live="polite">Starting previews…</div>
    <main>
      <section class="panel input"><div class="section-head"><h2><span class="step">01</span> Input</h2><span id="input-state" class="badge">TEST SOURCE</span></div>
        <div class="source-controls"><label>Source<select id="source-mode"><option value="pattern">Animated test pattern</option><option value="ndi">NDI® from ProPresenter</option></select></label><label class="grow">NDI source<select id="ndi-source"><option value="">Select a discovered source</option></select></label><button id="refresh">Refresh sources</button><button id="connect">Connect</button><button id="disconnect">Disconnect</button></div>
        <p id="runtime" class="muted"></p><label class="inline-check"><input id="monitor-enabled" type="checkbox" checked>Input monitor · disable to reduce CPU work</label>
        <div class="input-preview" id="input-monitor-panel"><canvas id="input-preview"></canvas><span id="source-label">TEST SOURCE · NOT NDI</span></div>
        <div class="metrics"><div><span>RECEIVED</span><strong id="count">—</strong></div><div><span>INPUT SIZE</span><strong id="resolution">—</strong></div><div><span>RECEIVED / PRESENTED / SOURCE FPS</span><strong id="fps">—</strong></div><div><span>APP FRAME AGE · NOT END-TO-END</span><strong id="age">—</strong></div></div>
        <p id="ndi-statistics" class="muted"></p><p class="muted attribution"><a href="https://ndi.video/" target="_blank" rel="noreferrer">NDI®</a> is a registered trademark of Vizrt NDI AB.</p>
      </section>
      <section class="panel calibration"><div class="section-head"><h2><span class="step">02</span> Calibration</h2><strong id="canvas-size"></strong></div>
        <div class="setup-tools"><button id="open-all">Open all assigned outputs</button><label>Calibration pattern<select id="calibration-pattern"><option value="none">Live input / source</option><option value="grid">Continuous alignment grid</option><option value="white">White · blend seams</option><option value="gray">50% gray · fine blend</option><option value="black">Black · projector black floor</option><option value="bars">Color bars</option></select></label><label class="inline-check"><input id="solo" type="checkbox">Solo selected projector</label><label class="inline-check"><input id="identify" type="checkbox">Identify outputs · raster labels</label><button id="live-output">Return to live input</button></div>
        <p id="output-summary" class="muted"></p><p id="aspect-warning" class="warning" hidden></p><div class="canvas-controls"><label>Left / center overlap (px)<input id="overlap" type="number" min="0" max="768" step="1"></label><label class="overlap-drag">Drag overlap<input id="overlap-slider" type="range" min="0" max="768" step="1"></label><label><input id="link-overlaps" type="checkbox" checked>Link both seams</label><label>Center / right overlap (px)<input id="right-overlap" type="number" min="0" max="768" step="1"></label><label class="overlap-drag">Drag right overlap<input id="right-overlap-slider" type="range" min="0" max="768" step="1"></label><button id="reset-overlap">Reset overlaps</button><label>Input scaling<select id="fit"><option value="contain">Fit — preserve entire input</option><option value="cover">Fill — crop to canvas</option><option value="stretch">Stretch to canvas</option></select></label><button id="refresh-displays">Refresh displays</button><button id="close-outputs">Close output windows</button></div>
        <div id="overview" aria-label="Three-projector source crop overview"></div><p class="muted" id="overlap-help">The overview fits your window. Output resolution stays 1920 × 1080. Drag either seam handle or the overlap slider. Link both seams or adjust them independently; hatched areas contain duplicated source pixels and automatic fades.</p>
      <div class="section-head projector-toolbar"><label>Selected projector<select id="projector-select">${rig.outputs.map((o,i)=>`<option value="${i}">${escape(o.name)}</option>`).join('')}</select></label><div class="actions"><button id="open-warp">Open warp adjustment…</button><button id="mesh-mode" class="active">Mesh warp</button><button id="mask-mode">Screen mask</button><button id="lock">Lock calibration</button></div></div>
        <div class="projectors">${rig.outputs.map((o, i) => `<article class="panel projector" data-index="${i}"><div class="section-head"><h3>${escape(o.name)}</h3><span class="badge">1920 × 1080</span></div><div class="projector-preview"><canvas id="projector-${i}"></canvas><svg id="handles-${i}" viewBox="0 0 1920 1080" tabindex="0" aria-label="${escape(o.name)} calibration handles"></svg></div><label>Output destination<select id="display-${i}"></select></label><div class="actions"><button id="preview-${i}">Open preview</button><button id="send-${i}">Send to display</button></div><p id="output-state-${i}" class="muted">Output closed</p><div class="resets">${(["mesh","mask","blend","all"] as const).map(part=>`<button data-reset="${part}" data-output="${i}">Reset ${part==='blend'?'blend/color':part}</button>`).join('')}</div></article>`).join('')}</div>
        <dialog id="warp-dialog" aria-labelledby="warp-title"><div class="panel warp-panel"><div class="section-head"><h3 id="warp-title">Warp adjustment</h3><button id="close-warp">Done</button></div><div class="section-head"><div class="actions"><label>Zoom<select id="warp-zoom"><option value="1">Fit route + margin</option><option value="1.5">150%</option><option value="2">200%</option><option value="0.5">50%</option></select></label><label><input id="show-blends" type="checkbox" checked>Show blend zones</label></div></div>
          <p id="warp-notice" class="warning" role="status" hidden></p><div class="warp-controls"><label>Warp type<select id="warp-type"><option value="perspective">Perspective · corner pin</option><option value="linear">Linear · mesh</option><option value="bezier">Bézier · curved surface</option></select></label><label>Horizontal mesh splits<select id="mesh-cols">${[1,2,4,8,16,32].map(n=>`<option value="${n+1}">${n}</option>`).join('')}</select></label><label>Vertical mesh splits<select id="mesh-rows">${[1,2,4,8,16,32].map(n=>`<option value="${n+1}">${n}</option>`).join('')}</select></label><label>Selected X · center origin<input id="point-x" type="number" step="1"></label><label>Selected Y · up<input id="point-y" type="number" step="1"></label></div>
          <div class="warp-workspace"><canvas id="warp-preview"></canvas><svg id="warp-editor" tabindex="0" role="application" aria-label="Selected projector warp editor" viewBox="-192 -108 2304 1296"></svg></div>
          <p class="muted">Warp the full region, including its blend zones. Drag a point or an edge handle; Alt-drag moves the region. Shift-drag fine-tunes; Ctrl disables snapping. Arrow keys nudge 1 px (Shift: 10 px); W/A/S/D select neighboring points. Geometry may extend beyond the route; the output clips to the projector raster.</p>
        </div></dialog>
        <div class="panel inspector"><div class="section-head"><h3 id="selected-title"></h3><button id="reset">Reset selected geometry</button></div><p id="edit-help" class="muted"></p><div class="calibration-controls">
          <label>Left blend (%)<input id="blend-left" type="number" min="0" max="50" step="0.1"></label><label>Right blend (%)<input id="blend-right" type="number" min="0" max="50" step="0.1"></label><label>Display gamma<input id="gamma" type="number" min="1" max="4" step="0.1"></label><label>Brightness<input id="brightness" type="number" min="0" max="2" step="0.05"></label><label><input id="auto-blend" type="checkbox">Auto edge blends</label><label>Blend gamma<input id="blend-gamma" type="number" min="0.2" max="4" step="0.1"></label><label>Black-level lift<input id="black" type="number" min="0" max="0.2" step="0.005"></label>
        </div></div>
      </section>
      <p id="autosave" class="muted">Calibration autosave ready</p><div class="actions"><button id="recover-rig">Restore previous autosave</button><button id="diagnostics">Save diagnostics</button><button id="restart-render">Restart preview engine</button></div>
    </main><dialog id="help-dialog" aria-labelledby="help-title"><div class="panel"><div class="section-head"><h2 id="help-title">One-hour projector setup</h2><button id="close-help">Done</button></div>
    <ol class="setup-guide"><li><b>0–10 min · Displays.</b> Connect all four displays before launch. Windows must use Extend, with each projector at 1920 × 1080, 60 Hz. Put this operator window on your control monitor before opening outputs. Avoid changing Windows scale/resolution during setup.</li>
    <li><b>10–20 min · Route and identify.</b> Assign Left, Center and Right to different displays. Open all assigned outputs; enable Identify outputs to check the cables. Disable Identify afterward. Use Solo to adjust one projector without light from the others.</li>
    <li><b>20–35 min · Geometry.</b> Choose the alignment grid. Start with Perspective for corners, then Linear mesh or Bézier for curvature. Warp the full region, including overlap. Use Screen mask to clip spill. A software mask cannot remove a projector’s black-floor glow.</li>
    <li><b>35–45 min · Seams.</b> Set physical overlap in source pixels; stage width is 5760 minus both overlaps. Align matching grid lines in both seams. Use White, then 50% gray, with Solo OFF and Identify OFF. Keep Auto edge blends on initially; tune blend gamma and projector brightness if needed. Disable any projector’s internal blending to avoid double fades.</li>
    <li><b>45–55 min · Live source.</b> Return to live input, choose NDI and Connect. ProPresenter’s output aspect should match the displayed stage size. A 1920 × 1080 input using Fit occupies only the center of a very wide stage; use a matching wide ProPresenter output. Stretch is available if distortion is intentional. Compare a source timer against the physical output for latency. On the first received NDI frame, Live mode pauses operator previews and locks calibration. Click Calibrate to resume previews and adjust the rig without disconnecting NDI. Live mode leaves NDI reception, metrics and projector outputs running.</li>
    <li><b>55–60 min · Save and lock.</b> Export the rig, verify all three outputs are playing, and lock calibration. Keep the exported JSON on the Windows PC. Do not open two mapper versions at once. Escape closes a focused output; reopen it from Calibration.</li></ol>
    <p class="muted">No source? Refresh sources, confirm ProPresenter NDI output is enabled, then Connect again. Calibration patterns work without NDI. A cable disconnect closes only its affected output; reconnect, Refresh displays, check its destination and reopen. Signal loss blacks live output after 2 seconds and recovers when frames resume. Blackout overrides patterns and identification.</p></div></dialog><footer>GPU mesh / mask / blend previews · Receiver runs independently of physical outputs · Escape exits fullscreen output</footer><input id="file" type="file" accept=".json,application/json" hidden>`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const value = (id: string) => $<HTMLInputElement>(id).value;
  const notify = (message: string, bad = false) => { $('notice').textContent = message; $('notice').classList.toggle('error', bad);const detail=$('warp-notice');detail.hidden=!$<HTMLDialogElement>('warp-dialog').open;detail.textContent=message; };
  const remember = () => { undo.push(JSON.stringify(rig)); if (undo.length > 100) undo.shift(); redo.length = 0; };
  const saveLocal = () => {
    const text=JSON.stringify(rig);
    try { localStorage.setItem('mapper-rig-v1',text); } catch { notify('Browser autosave unavailable. Export your rig.',true); }
    if(window.mapper?.saveRig)void window.mapper.saveRig(text).then(()=>{$('autosave').textContent=`Saved on this PC · ${new Date().toLocaleTimeString()}`;}).catch(e=>{$('autosave').textContent=`Disk autosave failed: ${String(e)}. Export your rig now.`;});
    else $('autosave').textContent='Saved in this browser · export your rig for transfer';
  };
  const warpDialog = $<HTMLDialogElement>('warp-dialog');
  $('open-warp').onclick = () => { if(liveMode)return; $('warp-notice').hidden=true;warpDialog.showModal(); outputKey=''; refreshControls(); };
  $('close-warp').onclick = () => warpDialog.close();
  $('projector-select').onchange = () => { selected=Number(value('projector-select'));activePoint=0;refreshControls(); };
  $('setup-help').onclick=()=>$<HTMLDialogElement>('help-dialog').showModal();
  $('close-help').onclick=()=>$<HTMLDialogElement>('help-dialog').close();
  $('recover-rig').onclick=async()=>{
    try{const saved=await window.mapper?.readRig?.();const text=saved?.previous??recoveryCopy;if(!text){notify('No previous disk autosave is available. Load an exported rig instead.',true);return;}const next=parseRig(text);remember();const before=rig;rig=next;closeChangedAssignments(before);saveLocal();refreshControls();await updateDisplays();notify('Previous autosave restored. Undo returns to the state before recovery.');}
    catch(e){notify(`Could not restore calibration: ${String(e)}`,true);}
  };
  $('restart-render').onclick=()=>location.reload();
  function setLiveMode(enabled:boolean) {
    if(enabled===liveMode)return;
    if(enabled){monitorBeforeLive=monitor;lockBeforeLive=locked;monitor=false;locked=true;warpDialog.close();}
    else {monitor=monitorBeforeLive;locked=lockBeforeLive;lastPreviewAt=0;monitorSequence=-1;}
    liveMode=enabled;document.body.classList.toggle('live-mode',liveMode);
    $('live-banner').hidden=!liveMode;
    $('live-mode').textContent=liveMode?'Calibrate · previews on':'Live mode · previews off';
    $('live-mode').classList.toggle('active',liveMode);
    $<HTMLInputElement>('monitor-enabled').checked=monitor;
    $<HTMLInputElement>('monitor-enabled').disabled=liveMode;
    $('input-monitor-panel').hidden=liveMode;
    document.querySelectorAll<HTMLElement>('.projector-preview').forEach(el=>el.hidden=liveMode);
    // Keep every output canvas and capture stream alive; only operator presentation
    // and the optional input/warp copies stop. No receive/render rate is reduced.
    outputKey='';refreshControls();
  }
  $('live-mode').onclick=()=>{autoLivePending=false;setLiveMode(!liveMode);notify(liveMode?'Live mode active. Operator previews are paused; all projector outputs keep rendering.':'Calibration previews resumed. NDI and projector outputs remain connected.');};
  $('monitor-enabled').onchange=()=>{monitor=$<HTMLInputElement>('monitor-enabled').checked;lastPreviewAt=0;monitorSequence=-1;};
  $('calibration-pattern').onchange=()=>{calibrationPattern=value('calibration-pattern') as CalibrationPattern;};
  $('solo').onchange=()=>{solo=$<HTMLInputElement>('solo').checked;};
  $('identify').onchange=()=>{identify=$<HTMLInputElement>('identify').checked;};
  $('live-output').onclick=()=>{calibrationPattern='none';solo=false;identify=false;blackout=false;$<HTMLSelectElement>('calibration-pattern').value='none';for(const id of ['solo','identify'])$<HTMLInputElement>(id).checked=false;$('blackout').textContent='Blackout outputs';$('blackout').classList.remove('blackout-on');notify('Calibration patterns and isolation cleared. Selected input is sent to all outputs.');};
  const raw = $<HTMLCanvasElement>('input-preview'), rawCtx = raw.getContext('2d')!;
  const shared = document.createElement('canvas'), sharedCtx = shared.getContext('2d')!;
  const rawFrame = document.createElement('canvas'), rawFrameCtx = rawFrame.getContext('2d')!;
  const size = layout(rig.overlap,rig.rightOverlap??rig.overlap); shared.width = size.width; shared.height = size.height;
  raw.width = size.width; raw.height = 1080;
  let renderers: ProjectorRenderer[];
  try { renderers = rig.outputs.map((_, i) => new ProjectorRenderer($<HTMLCanvasElement>(`projector-${i}`), shared)); }
  catch (e) { notify(`GPU preview could not initialize: ${String(e)}`, true); return; }
  window.mapperStreams = {};
  for (let i = 0; i < 3; i++) window.mapperStreams[rig.outputs[i].id] = $<HTMLCanvasElement>(`projector-${i}`).captureStream(60);

  addEventListener('message',event=>{
    const d=event.data;if(d?.type!=='mapper-output'||!children.has(d.id)||event.source!==children.get(d.id))return;
    outputReports.set(d.id,{...d,at:performance.now()});
  });
  function pointControls() {
    const o=rig.outputs[selected], list=editMode==='mesh'?o.mesh:o.mask;
    activePoint=Math.max(0,Math.min(list.length-1,activePoint));
    $('point-x').setAttribute('value',String(Math.round((list[activePoint].x-.5)*1920)));
    $('point-y').setAttribute('value',String(Math.round((.5-list[activePoint].y)*1080)));
    $<HTMLInputElement>('point-x').value=String(Math.round((list[activePoint].x-.5)*1920));
    $<HTMLInputElement>('point-y').value=String(Math.round((.5-list[activePoint].y)*1080));
  }
  function handles() {
    const path=(points:{x:number;y:number}[])=>points.map(p=>`${p.x*1920},${p.y*1080}`).join(' ');
    rig.outputs.forEach((o,i)=>{
      const points=editMode==='mesh'?o.mesh:o.mask;
      const dim=dimensions(o), lines:string[]=[];
      if(editMode==='mesh') {
        for(const u of [0,.25,.5,.75,1]) lines.push(`<polyline points="${path(blendBoundary(o,u))}"/>`);
        for(const v of [0,.25,.5,.75,1]) lines.push(`<polyline points="${path(Array.from({length:33},(_,n)=>sampleWarp(o,n/32,v)))}"/>`);
      } else lines.push(`<polygon points="${path(o.mask)}"/>`);
      let zones='';
      if($<HTMLInputElement>('show-blends').checked) for(const [a,b] of [[0,o.left],[1-o.right,1]]) {
        if(b>a) zones+=`<polygon class="blend-zone" points="${path([...blendBoundary(o,a),...blendBoundary(o,b).reverse()])}"/>`;
      }
      const edges=editMode==='mesh'?[[.5,0],[1,.5],[.5,1],[0,.5]].map(([u,v],edge)=>{const p=sampleWarp(o,u,v);return `<rect data-edge="${edge}" x="${p.x*1920-13}" y="${p.y*1080-13}" width="26" height="26"/>`;}).join(''):'';
      const nodes=points.map((p,n)=>`<circle data-point="${n}" class="${i===selected&&n===activePoint?'active-point':''}" cx="${p.x*1920}" cy="${p.y*1080}" r="${points.length>100?8:15}"/>`).join('');
      const content='<defs><pattern id="blend-hatch" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M-8 8L8 -8M0 32L32 0M24 40L40 24" stroke="#f0d686" stroke-width="3"/></pattern></defs>'+zones+lines.join('')+edges+nodes;
      const svg=$(`handles-${i}`);svg.innerHTML=content;svg.classList.toggle('locked',locked);
      $(`projector-${i}`).closest('article')!.classList.toggle('selected',i===selected);
      if(i===selected){ $('warp-editor').innerHTML=`<rect class="route-boundary" x="0" y="0" width="1920" height="1080"/>`+content; }
    });
    pointControls();
  }
  function refreshControls() {
    const o = rig.outputs[selected];
    $<HTMLSelectElement>('projector-select').value=String(selected);
    $('warp-title').textContent=`${o.name} · ${editMode==='mesh'?'Warp adjustment':'Screen mask'}${solo?' · SOLO':''}${calibrationPattern!=='none'?' · '+calibrationPattern.toUpperCase():''}`;
    document.querySelectorAll<HTMLElement>('.projector').forEach((card,i)=>{card.hidden=!liveMode&&i!==selected;});
    $('selected-title').textContent = `${o.name} · ${editMode === 'mesh' ? `${o.warpType??'linear'} warp` : 'four-point projector mask'}`;
    $('edit-help').textContent = locked ? 'Calibration is locked.' : editMode === 'mesh' ? 'Select a point to edit its coordinates, or drag points and edges in Warp adjustment. Blend zones move with the warp.' : 'Drag the four mask points to clip light to the screen boundary. Mask coordinates are independent of the mesh.';
    for (const [id, v] of Object.entries({ 'blend-left': o.left * 100, 'blend-right': o.right * 100, gamma: o.gamma, brightness: o.brightness, black: o.black, overlap: rig.overlap })) $<HTMLInputElement>(id).value = String(Math.round(v * 10000) / 10000);
    $<HTMLSelectElement>('fit').value = rig.fit;
    $<HTMLInputElement>('overlap-slider').value=String(rig.overlap);
    $<HTMLInputElement>('link-overlaps').checked=rig.linkOverlaps!==false;
    for(const id of ['right-overlap','right-overlap-slider']){$<HTMLInputElement>(id).value=String(rig.rightOverlap??rig.overlap);$<HTMLInputElement>(id).disabled=locked||rig.linkOverlaps!==false;}
    $<HTMLSelectElement>('warp-type').value=o.warpType??'linear';
    const dim=dimensions(o);
    for(const id of ['mesh-cols','mesh-rows']){$(id).querySelector('[data-cubic]')?.remove();if(o.warpType==='bezier')$(id).insertAdjacentHTML('beforeend','<option value="4" data-cubic>3 · cubic patch</option>');}
    $<HTMLSelectElement>('mesh-cols').value=String(dim.cols); $<HTMLSelectElement>('mesh-rows').value=String(dim.rows);
    $<HTMLSelectElement>('mesh-cols').disabled=locked||editMode==='mask'||o.warpType==='perspective'||o.warpType==='bezier';
    $<HTMLSelectElement>('mesh-rows').disabled=$<HTMLSelectElement>('mesh-cols').disabled;
    $<HTMLInputElement>('auto-blend').checked=o.autoBlend!==false;
    $<HTMLInputElement>('blend-gamma').value=String(o.blendGamma??1);
    $('mesh-mode').classList.toggle('active', editMode === 'mesh'); $('mask-mode').classList.toggle('active', editMode === 'mask');
    $('open-warp').toggleAttribute('disabled',liveMode);$('lock').toggleAttribute('disabled',liveMode);
    $('lock').textContent = locked ? 'Unlock calibration' : 'Lock calibration';
    for (const id of ['blend-left', 'blend-right', 'gamma', 'brightness', 'black', 'overlap', 'overlap-slider', 'reset-overlap', 'link-overlaps', 'fit', 'reset', 'warp-type', 'point-x', 'point-y', 'auto-blend', 'blend-gamma']) ($<HTMLInputElement>(id)).disabled = locked;
    for (let i = 0; i < 3; i++) $<HTMLSelectElement>(`display-${i}`).disabled = locked;
    for(const id of ['undo','redo','load','recover-rig'])$<HTMLButtonElement>(id).disabled=locked;
    document.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach(b=>b.disabled=locked);
    handles(); overview();
  }
  function overview() {
    const l = layout(rig.overlap,rig.rightOverlap??rig.overlap);
    $('canvas-size').textContent = `${l.width} × ${l.height}`;
    $('overview').style.aspectRatio = `${l.width} / 1080`;
    $('overview').innerHTML = rig.outputs.map((o, i) => `<div style="left:${l.starts[i] / l.width * 100}%;width:${1920 / l.width * 100}%"><span>${escape(o.name)} · ${Math.round(l.starts[i])}–${Math.round(l.starts[i] + 1920)} px</span></div>`).join('') + ([1,2] as const).map(i=>`<button class="seam-grip" data-seam="${i}" aria-label="Drag overlap seam ${i}" style="left:${l.starts[i]/l.width*100}%">↔</button>`).join('');
  }
  async function updateDisplays() {
    try { displays = window.mapper ? await window.mapper.displays() : []; }
    catch (e) { notify(String(e), true); }
    rig.outputs.forEach((o, i) => {
      const select = $<HTMLSelectElement>(`display-${i}`);
      if (document.activeElement===select)return;
      select.innerHTML = '<option value="">Preview only — no projector needed</option>' + displays.filter(d => !d.operator).map(d => `<option value="${escape(d.id)}">${escape(d.name)} [${escape(d.id)}] · ${d.width} × ${d.height}${d.refreshRate?` · ${Math.round(d.refreshRate)} Hz`:''}</option>`).join('');
      if (o.displayId && !displays.some(d => d.id === o.displayId && !d.operator)) select.insertAdjacentHTML('beforeend', `<option value="${escape(o.displayId)}">Saved display disconnected · preview only</option>`);
      select.value = o.displayId;
    });
    let states:{id:string;displayId:string;fullscreen:boolean}[]=[];try{states=await window.mapper?.outputStatus?.()??[];}catch{ /* show window heartbeat if routing IPC is unavailable */ }
    rig.outputs.forEach((o,i)=>{
      const child=children.get(o.id),report=outputReports.get(o.id),state=states.find(s=>s.id===o.id);
      const open=state||child&&!child.closed;
      $(`output-state-${i}`).textContent=routeErrors.has(o.id)?`Routing error: ${routeErrors.get(o.id)}`:!open?'Output closed':report&&performance.now()-report.at<4000&&report.ready?`${state?.fullscreen?'Fullscreen':'Preview'} · video ${report.width} × ${report.height} · ${report.frames} presented frames`:'Output open · waiting for video heartbeat';
    });
  }
  async function updateSources() {
    try {
      sources = window.mapper ? await window.mapper.sources() : [];
      const select = $<HTMLSelectElement>('ndi-source'), before = select.value || rig.source;
      if(document.activeElement===select)return;
      select.innerHTML = '<option value="">Select a discovered source</option>' + sources.map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join('');
      if (sources.includes(before)) select.value = before;
    } catch (e) { notify(`Discovery failed: ${String(e)}`, true); }
  }
  function openPreview(i: number) {
    const id = rig.outputs[i].id, previous = children.get(id);
    if (previous && !previous.closed) { previous.focus(); return previous; }
    const url = new URL(location.href); url.search = `?output=${id}${smokeMode?'&probe=1':''}`;
    const child = window.open(url, id, 'popup,width=960,height=580');
    if (!child) notify('Preview window blocked. Allow popups for this app.', true);
    else children.set(id, child);
    return child;
  }
  function wireEditor(svg:SVGSVGElement, index:()=>number, expanded:boolean) {
    let drag:null|{point:number;edge:number;start:{x:number;y:number};points:{x:number;y:number}[];move:boolean}=null;
    const position=(e:PointerEvent)=>{
      const r=svg.getBoundingClientRect(), zoom=expanded?Number(value('warp-zoom')):1;
      const span=expanded?1.2/zoom:1, origin=(1-span)/2;
      return {x:origin+(e.clientX-r.left)/r.width*span,y:origin+(e.clientY-r.top)/r.height*span};
    };
    svg.addEventListener('pointerdown',e=>{
      const point=(e.target as Element).getAttribute('data-point'), edge=(e.target as Element).getAttribute('data-edge');
      selected=index(); if(point!==null)activePoint=Number(point);refreshControls();
      if(locked||(point===null&&edge===null&&!e.altKey))return;
      remember(); const o=rig.outputs[selected];
      drag={point:point===null?-1:Number(point),edge:edge===null?-1:Number(edge),start:position(e),points:structuredClone(editMode==='mesh'?o.mesh:o.mask),move:e.altKey};
      svg.setPointerCapture(e.pointerId);svg.focus();e.preventDefault();
    });
    svg.addEventListener('pointermove',e=>{
      if(!drag)return;
      const o=rig.outputs[selected], list=editMode==='mesh'?o.mesh:o.mask, p=position(e), dim=dimensions(o), factor=e.shiftKey ? .1 : 1;
      const previous=structuredClone(list);
      let dx=(p.x-drag.start.x)*factor,dy=(p.y-drag.start.y)*factor;
      const snap=(v:number)=>{if(e.ctrlKey)return v;for(const guide of [0,.25,.5,.75,1])if(Math.abs(v-guide)<.004)return guide;return v;};
      if(drag.move){
        // One translation for the whole region; independent point snapping/clamping
        // would distort a calibrated mesh during Alt-drag.
        const min=editMode==='mesh'?-1:0,max=editMode==='mesh'?2:1,anchor=drag.points[activePoint];
        dx=Math.max(min-Math.min(...drag.points.map(p=>p.x)),Math.min(max-Math.max(...drag.points.map(p=>p.x)),snap(anchor.x+dx)-anchor.x));
        dy=Math.max(min-Math.min(...drag.points.map(p=>p.y)),Math.min(max-Math.max(...drag.points.map(p=>p.y)),snap(anchor.y+dy)-anchor.y));
      }
      list.forEach((point,n)=>{
        const x=n%dim.cols,y=Math.floor(n/dim.cols);
        const onEdge=editMode==='mesh'&&((drag!.edge===0&&y===0)||(drag!.edge===1&&x===dim.cols-1)||(drag!.edge===2&&y===dim.rows-1)||(drag!.edge===3&&x===0));
        if(drag!.move||drag!.point===n||onEdge){point.x=Math.max(editMode==='mesh'?-1:0,Math.min(editMode==='mesh'?2:1,drag!.move?drag!.points[n].x+dx:snap(drag!.points[n].x+dx)));point.y=Math.max(editMode==='mesh'?-1:0,Math.min(editMode==='mesh'?2:1,drag!.move?drag!.points[n].y+dy:snap(drag!.points[n].y+dy)));}
      });if(editMode==='mesh'&&!usablePerspective(o)){o.mesh=previous;notify('Corner pin cannot cross or collapse. Keep the four corners around the screen boundary.',true);}handles();
    });
    const finish=()=>{if(drag){drag=null;saveLocal();}};
    svg.addEventListener('pointerup',finish);svg.addEventListener('pointercancel',finish);svg.addEventListener('lostpointercapture',finish);
    svg.addEventListener('keydown',e=>{
      if(locked)return;const o=rig.outputs[selected], list=editMode==='mesh'?o.mesh:o.mask, cols=editMode==='mesh'?dimensions(o).cols:2;
      const navigation:Record<string,number>={w:-cols,a:-1,s:cols,d:1};
      if(e.key.toLowerCase() in navigation){activePoint=Math.max(0,Math.min(list.length-1,activePoint+navigation[e.key.toLowerCase()]));handles();e.preventDefault();return;}
      const nudge:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
      if(nudge[e.key]){remember();const [dx,dy]=nudge[e.key],step=e.shiftKey?10:1,point=list[activePoint],before=structuredClone(o.mesh),min=editMode==='mesh'?-1:0,max=editMode==='mesh'?2:1;point.x=Math.max(min,Math.min(max,point.x+dx*step/1920));point.y=Math.max(min,Math.min(max,point.y+dy*step/1080));if(editMode==='mesh'&&!usablePerspective(o)){o.mesh=before;notify('Corner pin cannot cross or collapse.',true);}handles();saveLocal();e.preventDefault();}
    });
  }
  wireEditor(document.getElementById('warp-editor') as unknown as SVGSVGElement,()=>selected,true);
  for (let i = 0; i < 3; i++) {
    wireEditor(document.getElementById(`handles-${i}`) as unknown as SVGSVGElement,()=>i,false);
    $(`preview-${i}`).onclick = () => openPreview(i);
    $(`send-${i}`).onclick = () => void sendOutput(i);
    $(`display-${i}`).onchange = () => {
      const id = value(`display-${i}`);
      if (id && rig.outputs.some((o, j) => j !== i && o.displayId === id)) { $<HTMLSelectElement>(`display-${i}`).value=rig.outputs[i].displayId;notify('That display is already assigned to another projector.', true); void updateDisplays(); return; }
      remember(); rig.outputs[i].displayId = id; saveLocal();
      children.get(rig.outputs[i].id)?.close();routeErrors.delete(rig.outputs[i].id);
    };
  }
  async function sendOutput(i:number) {
      const o = rig.outputs[i];
      if (!o.displayId) { openPreview(i); routeErrors.delete(o.id);notify(`${o.name} is preview only.`); return true; }
      if (!window.mapper) { routeErrors.set(o.id,'Desktop app required');notify('Physical display routing requires the desktop app.', true); return false; }
      openPreview(i);
      // Give Electron time to register a newly created child window.
      let lastError: unknown;
      for (let attempt = 0; attempt < 8; attempt++) {
        try { await window.mapper.openOutput(o.id, o.displayId); routeErrors.delete(o.id);notify(`${o.name} sent to its assigned display. Escape closes it.`); return true; }
        catch (e) { lastError = e; await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      routeErrors.set(o.id,String(lastError));notify(String(lastError), true);return false;
    };
  $('open-all').onclick=async()=>{
    // Open all children synchronously in the user gesture before awaiting IPC.
    rig.outputs.forEach((_,i)=>openPreview(i));
    const failed:string[]=[];for(let i=0;i<3;i++)if(!await sendOutput(i))failed.push(rig.outputs[i].name);
    await updateDisplays();notify(failed.length?`Could not route: ${failed.join(', ')}. Select each output to see its routing error.`:'All outputs opened. Unassigned destinations are preview windows.',!!failed.length);
  };
  document.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach(button=>button.onclick=()=>{
    if(locked)return;remember();const index=Number(button.dataset.output);resetCalibration(rig,index,button.dataset.reset as ResetPart);selected=index;activePoint=0;saveLocal();refreshControls();
  });
  $('warp-type').onchange=()=>{remember();const before=structuredClone(rig.outputs[selected]);changeWarp(rig.outputs[selected],value('warp-type') as WarpType);if(!usablePerspective(rig.outputs[selected])){rig.outputs[selected]=before;notify('These corner positions do not form a usable perspective pin. Reset the mesh or uncross its corners first.',true);}activePoint=0;saveLocal();refreshControls();};
  for(const id of ['mesh-cols','mesh-rows'])$(id).onchange=()=>{remember();changeWarp(rig.outputs[selected],'linear',Number(value('mesh-cols')),Number(value('mesh-rows')));activePoint=0;saveLocal();refreshControls();};
  for(const id of ['point-x','point-y'])$(id).onchange=()=>{
    const n=Number(value(id));if(!Number.isFinite(n))return;remember();const o=rig.outputs[selected],before=structuredClone(o.mesh),point=(editMode==='mesh'?o.mesh:o.mask)[activePoint],min=editMode==='mesh'?-1:0,max=editMode==='mesh'?2:1;
    if(id==='point-x')point.x=Math.max(min,Math.min(max,.5+n/1920));else point.y=Math.max(min,Math.min(max,.5-n/1080));if(editMode==='mesh'&&!usablePerspective(o)){o.mesh=before;notify('Corner pin cannot cross or collapse.',true);}saveLocal();handles();
  };
  $('warp-zoom').onchange=()=>{
    const span=1.2/Number(value('warp-zoom')),x=(1-span)*960,y=(1-span)*540;
    $('warp-editor').setAttribute('viewBox',`${x} ${y} ${span*1920} ${span*1080}`);
    const canvas=$('warp-preview');canvas.style.left=`${(span-1)/span*50}%`;canvas.style.top=`${(span-1)/span*50}%`;canvas.style.width=`${100/span}%`;canvas.style.height=`${100/span}%`;
  };
  $('show-blends').onchange=handles;
  $('auto-blend').onchange=()=>{remember();const o=rig.outputs[selected];o.autoBlend=$<HTMLInputElement>('auto-blend').checked;if(o.autoBlend)Object.assign(o,automaticEdges(rig,selected));saveLocal();refreshControls();};
  $('blend-gamma').onchange=()=>{const n=Number(value('blend-gamma'));if(!Number.isFinite(n))return;remember();rig.outputs[selected].blendGamma=Math.max(.2,Math.min(4,n));saveLocal();refreshControls();};
  let overlapGesture=false;
  $('overlap-slider').onpointerdown=()=>{if(!locked){remember();overlapGesture=true;}};
  $('overlap-slider').oninput=()=>{if(locked)return;if(!overlapGesture){remember();overlapGesture=true;}setOverlap(rig,Number(value('overlap-slider')));refreshControls();};
  $('overlap-slider').onchange=()=>{overlapGesture=false;saveLocal();};
  $('reset-overlap').onclick=()=>{remember();setOverlap(rig,0);setOverlap(rig,0,2);saveLocal();refreshControls();};
  $('link-overlaps').onchange=()=>{remember();rig.rightOverlap??=rig.overlap;rig.linkOverlaps=$<HTMLInputElement>('link-overlaps').checked;if(rig.linkOverlaps)setOverlap(rig,rig.overlap);saveLocal();refreshControls();};
  $('right-overlap').onchange=()=>{const n=Number(value('right-overlap'));if(!Number.isFinite(n))return;remember();setOverlap(rig,n,2);saveLocal();refreshControls();};
  $('right-overlap-slider').onpointerdown=()=>{if(!locked){remember();overlapGesture=true;}};
  $('right-overlap-slider').oninput=()=>{if(locked)return;if(!overlapGesture){remember();overlapGesture=true;}setOverlap(rig,Number(value('right-overlap-slider')),2);refreshControls();};
  $('right-overlap-slider').onchange=()=>{overlapGesture=false;saveLocal();};
  let seamDrag:null|{seam:1|2;offset:number}=null;
  $('overview').onpointerdown=e=>{const n=(e.target as Element).getAttribute('data-seam');if(locked||!n)return;remember();const rect=$('overview').getBoundingClientRect(),seam=Number(n) as 1|2,l=layout(rig.overlap,rig.rightOverlap??rig.overlap);seamDrag={seam,offset:(e.clientX-rect.left)/rect.width-l.starts[seam]/l.width};$('overview').setPointerCapture(e.pointerId);e.preventDefault();};
  $('overview').onpointermove=e=>{if(!seamDrag)return;const rect=$('overview').getBoundingClientRect();setOverlap(rig,overlapFromSeam((e.clientX-rect.left)/rect.width-seamDrag.offset,seamDrag.seam,rig),seamDrag.seam);refreshControls();};
  $('overview').onpointerup=()=>{seamDrag=null;saveLocal();};$('overview').onpointercancel=()=>{seamDrag=null;saveLocal();};
  const numberControls: Record<string, { key: 'left' | 'right' | 'gamma' | 'brightness' | 'black'; scale: number; min: number; max: number }> = {
    'blend-left': { key: 'left', scale: .01, min: 0, max: 50 }, 'blend-right': { key: 'right', scale: .01, min: 0, max: 50 },
    gamma: { key: 'gamma', scale: 1, min: 1, max: 4 }, brightness: { key: 'brightness', scale: 1, min: 0, max: 2 }, black: { key: 'black', scale: 1, min: 0, max: .2 }
  };
  for (const [id, config] of Object.entries(numberControls)) $(id).onchange = () => {
    const n = Number(value(id)); if (!Number.isFinite(n)) { refreshControls(); return; }
    remember(); rig.outputs[selected][config.key] = Math.max(config.min, Math.min(config.max, n)) * config.scale; if(config.key==='left'||config.key==='right')rig.outputs[selected].autoBlend=false; saveLocal(); refreshControls();
  };
  $('overlap').onchange = () => { const n = Number(value('overlap')); if (!Number.isFinite(n)) return; remember(); setOverlap(rig, n); saveLocal(); refreshControls(); };
  $('fit').onchange = () => { remember(); rig.fit = value('fit') as Rig['fit']; saveLocal(); };
  $('mesh-mode').onclick = () => { editMode = 'mesh'; refreshControls(); };
  $('mask-mode').onclick = () => { editMode = 'mask'; refreshControls(); };
  $('lock').onclick = () => { locked = !locked; refreshControls(); };
  $('reset').onclick=()=>{remember();resetCalibration(rig,selected,editMode);saveLocal();refreshControls();};
  $('blackout').onclick = () => { blackout = !blackout; $('blackout').textContent = blackout ? 'BLACKOUT ON · Resume outputs' : 'Blackout outputs'; $('blackout').classList.toggle('blackout-on', blackout); };
  function closeChangedAssignments(before:Rig){rig.outputs.forEach((o,i)=>{if(o.displayId!==before.outputs[i].displayId)children.get(o.id)?.close();});}
  $('undo').onclick = () => { if (locked || !undo.length) return; redo.push(JSON.stringify(rig)); const before=rig;rig = parseRig(undo.pop()!);closeChangedAssignments(before); saveLocal(); refreshControls(); void updateDisplays(); };
  $('redo').onclick = () => { if (locked || !redo.length) return; undo.push(JSON.stringify(rig)); const before=rig;rig = parseRig(redo.pop()!);closeChangedAssignments(before); saveLocal(); refreshControls(); void updateDisplays(); };
  async function exportJSON(kind:'rig'|'diagnostics',data:unknown){
    try{
      const text=JSON.stringify(data,null,2);
      if(window.mapper?.exportFile){const saved=await window.mapper.exportFile(kind,text);if(saved)notify(`Saved ${kind}: ${saved}`);return;}
      const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download=kind==='rig'?'three-projector-rig.json':'mapper-diagnostics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify(`${kind} download requested. Check your downloads.`);
    }catch(e){notify(`Could not export ${kind}: ${String(e)}`,true);}
  }
  $('save').onclick = () => void exportJSON('rig',rig);
  $('load').onclick = () => { if (!locked) $<HTMLInputElement>('file').click(); };
  $('file').onchange = async () => {
    const file = $<HTMLInputElement>('file').files?.[0]; if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw Error('Rig file is too large.');
      const next = parseRig(await file.text()); remember(); rig = next; saveLocal(); refreshControls(); await updateDisplays();
      for (const child of children.values()) child.close();
      notify('Rig loaded. Input and physical outputs remain under operator control.');
    } catch (e) { notify(String(e), true); }
    $<HTMLInputElement>('file').value = '';
  };
  $('refresh-displays').onclick = () => void updateDisplays();
  $('close-outputs').onclick = () => { for (const child of children.values()) child.close(); void window.mapper?.closeOutputs(); };
  $('refresh').onclick = () => void updateSources();
  $('disconnect').onclick = async () => { autoLivePending=false;setLiveMode(false); connectionGeneration++; connected = false; sequence = 0; lastFrameAt = 0; uploadedSequence=-1; latestFrame=null; await window.mapper?.disconnect(); notify('NDI receiver disconnected.'); };
  $('source-mode').onchange = async () => {
    autoLivePending=false;setLiveMode(false);sourceMode = value('source-mode') as typeof sourceMode; connectionGeneration++; connected = false; sequence = 0; lastFrameAt = 0; uploadedSequence=-1; latestFrame=null; await window.mapper?.disconnect();
    notify(sourceMode === 'pattern' ? 'Animated test source active. This is not an NDI reception test.' : 'Select a ProPresenter source and connect.');
  };
  $('connect').onclick = async () => {
    if (!nativeAvailable || !window.mapper) { notify('NDI receiver unavailable. See the runtime status above.', true); return; }
    const name = value('ndi-source'); if (!name) { notify('Select a discovered NDI source first.', true); return; }
    const generation = ++connectionGeneration;
    connected = false; sequence = 0; lastFrameAt = 0; uploadedSequence=-1; latestFrame=null; receiveError = '';
    sampleSequence = 0; sampleTime = performance.now(); measuredFps = 0;
    try {
      await window.mapper.connect(name);
      if (generation !== connectionGeneration) return;
      sourceMode = 'ndi'; $<HTMLSelectElement>('source-mode').value = sourceMode; connected = true;autoLivePending=true; rig.source = name; saveLocal(); notify('Receiver started. Waiting for the first real video frame…');
    } catch (e) { notify(String(e), true); }
  };
  try {
    const status: {available:boolean;error:string;smoke?:boolean} = window.mapper ? await window.mapper.status() : { available: false, error: 'Browser preview: NDI requires the Windows x64 desktop app and its native receiver.' };
    smokeMode=!!status.smoke; nativeAvailable = status.available; $('runtime').textContent = status.available ? 'Windows NDI receiver ready. Local ProPresenter sources are included in discovery.' : status.error;
  } catch (e) { $('runtime').textContent = String(e); }
  for (const id of ['ndi-source', 'connect', 'refresh', 'disconnect']) $<HTMLButtonElement>(id).disabled = !nativeAvailable;
  await updateDisplays(); await updateSources(); refreshControls(); notify('Preview-only rig ready. No projectors required. Drag a mesh point to calibrate.');

  $('diagnostics').onclick=async()=>{
    const info={version:'0.5.0',savedAt:new Date().toISOString(),displays,outputs:await window.mapper?.outputStatus?.()??[],source:rig.source,connected,ndiStatistics,receivedSequence:sequence,receivedFps:measuredFps,presentedFps,nominalFps,frameAgeMs:lastFrameAt?Math.round(performance.now()-lastFrameAt):null,renderMs:lastRenderMs,calibrationPattern,solo,identify,blackout,monitor,liveMode,monitorCopies,warpCopies,receiveError,rig};
    await exportJSON('diagnostics',info);
  };
  if(recovered)notify('Recovered the previous disk autosave because the latest file was unreadable. Export this rig now.',true);

  async function poll() {
    if (busy || sourceMode !== 'ndi' || !connected || !window.mapper) return;
    busy = true; const generation = connectionGeneration; const requestedAt=performance.now();
    try {
      const frame = await window.mapper.frame();
      if (generation !== connectionGeneration || !frame) return;
      if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 16384 || frame.height > 8192 || frame.data.length !== frame.width * frame.height * 4) throw Error('Invalid received video frame.');
      latestFrame=frame;
      if(autoLivePending){autoLivePending=false;setLiveMode(true);notify('NDI video received. Live mode paused operator previews to reduce resource use. Choose Calibrate for preview and warp adjustments.');}
      if(!sequence){sampleSequence=frame.sequence;sampleTime=performance.now();}
      sequence = frame.sequence; nominalFps = frame.fps; lastFrameAt = performance.now() - frame.ageMs - (performance.now()-requestedAt); receiveError = '';
      const now = performance.now();
      if (now - sampleTime > 1000) { measuredFps = Math.max(0, (sequence - sampleSequence) * 1000 / (now - sampleTime)); sampleSequence = sequence; sampleTime = now; }
    } catch (e) { receiveError = String(e); }
    finally { busy = false; }
  }
  function render() {
    if(renderFailed)return;
    const started=performance.now(), now=started,l=layout(rig.overlap,rig.rightOverlap??rig.overlap);
    const live=sourceMode==='ndi'&&connected&&sequence>0&&now-lastFrameAt<2000&&!receiveError;
    const nextContent=[sourceMode,sequence,live,rig.overlap,rig.rightOverlap,rig.fit].join(':');
    const sourceDirty=sourceMode==='pattern'||nextContent!==contentKey;
    if(sourceDirty){
      if(shared.width!==l.width)shared.width=l.width;
      if(sourceMode==='pattern'){
        renderers[0].useCanvas();
        drawTestPattern(sharedCtx,shared.width,shared.height,'grid');
        const colors=['rgba(70,140,210,.2)','rgba(210,160,70,.2)','rgba(70,190,145,.2)'];
        rig.outputs.forEach((o,i)=>{sharedCtx.fillStyle=colors[i];sharedCtx.fillRect(l.starts[i],0,1920,1080);sharedCtx.fillStyle='#d4e7ed';sharedCtx.font='bold 100px monospace';sharedCtx.fillText(o.name.toUpperCase(),l.starts[i]+160,300);});
        sharedCtx.fillStyle='#6fe0c4';sharedCtx.fillRect((now/40)%shared.width,0,12,1080);sharedCtx.font='40px monospace';sharedCtx.fillText(`TEST SOURCE · ${++patternCount}`,40,80);
      }else if(live&&latestFrame&&uploadedSequence!==sequence){renderers[0].setInputFrame(latestFrame.data,latestFrame.width,latestFrame.height);uploadedSequence=sequence;}
      contentKey=nextContent;sourceRevision++;
    }
    // Operator input monitor is intentionally 30fps at reduced resolution; it does not throttle the outputs.
    if(monitor&&now-lastPreviewAt>1000/30&&(sourceMode==='pattern'||monitorSequence!==sequence||!live)){
      const w=sourceMode==='pattern'?l.width:latestFrame?.width??1920,h=sourceMode==='pattern'?1080:latestFrame?.height??1080;
      const pw=Math.min(1440,w),ph=Math.round(h*pw/w);
      if(raw.width!==pw||raw.height!==ph){raw.width=pw;raw.height=ph;}
      rawCtx.fillStyle='#000';rawCtx.fillRect(0,0,pw,ph);
      if(sourceMode==='pattern')rawCtx.drawImage(shared,0,0,pw,ph);else if(live&&latestFrame){if(rawFrame.width!==w||rawFrame.height!==h){rawFrame.width=w;rawFrame.height=h;}rawFrameCtx.putImageData(new ImageData(new Uint8ClampedArray(latestFrame.data.buffer as ArrayBuffer,latestFrame.data.byteOffset,latestFrame.data.byteLength),w,h),0,0);rawCtx.drawImage(rawFrame,0,0,pw,ph);}
      monitorCopies++;raw.style.aspectRatio=`${w}/${h}`;lastPreviewAt=now;monitorSequence=sequence;
    }
    const nextOutput=JSON.stringify([rig.outputs,blackout,selected,calibrationPattern,solo,identify]);
    if(sourceDirty||outputKey!==nextOutput){
      renderers.forEach((renderer,i)=>{
        const muted=blackout||(solo&&i!==selected)||(calibrationPattern==='none'&&sourceMode==='ndi'&&!live);
        renderer.render(rig.outputs[i],i,rig,muted,sourceRevision,calibrationPattern);
        if(identify&&!blackout&&(!solo||i===selected)){
          const ctx=$<HTMLCanvasElement>(`projector-${i}`).getContext('2d')!;
          ctx.fillStyle=['#14324a','#4a3614','#143d32'][i];ctx.fillRect(0,0,1920,1080);ctx.strokeStyle='#fff';ctx.lineWidth=12;ctx.strokeRect(6,6,1908,1068);ctx.fillStyle='#fff';ctx.textAlign='center';ctx.font='bold 160px Segoe UI,sans-serif';ctx.fillText(`${i+1} · ${rig.outputs[i].name}`,960,510);ctx.font='40px Segoe UI,sans-serif';ctx.fillText('RASTER IDENTIFICATION · disable before calibration',960,620);ctx.textAlign='left';
        }
      });
      if(!liveMode&&warpDialog.open){
      const warpCanvas=$<HTMLCanvasElement>('warp-preview');
      if(warpCanvas.width!==1920){warpCanvas.width=1920;warpCanvas.height=1080;}
      warpCopies++;warpCanvas.getContext('2d',{alpha:false})!.drawImage($<HTMLCanvasElement>(`projector-${selected}`),0,0);
      }
      if(live&&sequence!==lastPresentedSequence){presented++;lastPresentedSequence=sequence;}
      outputKey=nextOutput;lastRenderMs=performance.now()-started;
    }
    if(tickCount>=10&&smokeMode&&!smokeStarted){
      smokeStarted=true;
      const testRig=defaultRig();testRig.fit='stretch';const pixels=new Uint8Array(4*2*4);
      for(let i=0;i<8;i++){pixels[i*4+(i<4?0:2)]=255;pixels[i*4+3]=255;}
      renderers[0].setInputFrame(pixels,4,2);let passed=true;
      for(const mode of ['linear','perspective','bezier'] as const){
        testRig.outputs.forEach(o=>changeWarp(o,mode));
        renderers.forEach((r,i)=>{
          r.render(testRig.outputs[i],i,testRig,false,-100);
          const context=$<HTMLCanvasElement>(`projector-${i}`).getContext('2d')!;
          const top=context.getImageData(960,270,1,1).data,bottom=context.getImageData(960,810,1,1).data;
          passed=passed&&top[0]>200&&top[2]<50&&bottom[2]>200&&bottom[0]<50;
        });
      }
      renderers[0].useCanvas();sourceRevision++;renderers.forEach((r,i)=>r.render(rig.outputs[i],i,rig,blackout,sourceRevision));
      // Also exercise shader masks, complementary edge fades, temporary patterns,
      // then the actual canvas-stream/video path in all three separate windows.
      const test=defaultRig();test.fit='stretch';setOverlap(test,192);
      renderers[0].useCanvas();
      const pixel=(i:number,x:number,y:number)=>$<HTMLCanvasElement>(`projector-${i}`).getContext('2d')!.getImageData(x,y,1,1).data[0];
      renderers[0].render(test.outputs[0],0,test,false,sourceRevision,'white');const right=pixel(0,1824,500)/255;
      renderers[1].render(test.outputs[1],1,test,false,sourceRevision,'white');const left=pixel(1,96,500)/255;
      let calibrationTests=Math.abs(right**2.2+left**2.2-1)<.03;
      test.outputs[0].mask[0].x=.5;test.outputs[0].mask[3].x=.5;
      renderers[0].render(test.outputs[0],0,test,false,sourceRevision,'white');calibrationTests=calibrationTests&&pixel(0,100,500)<5&&pixel(0,1200,500)>240;
      renderers[0].render(test.outputs[0],0,test,true,sourceRevision,'white');calibrationTests=calibrationTests&&pixel(0,1200,500)<5;
      renderers[0].render(test.outputs[0],0,test,false,sourceRevision,'gray');calibrationTests=calibrationTests&&Math.abs(pixel(0,1200,500)-128)<3;
      calibrationPattern='white';outputKey='';rig.outputs.forEach((_,i)=>openPreview(i));
      setLiveMode(true);
      const pausedMonitorCopies=monitorCopies,pausedWarpCopies=warpCopies;
      const began=performance.now(),deadline=began+40000;
      let restoreStarted=false,liveModeTest=false,restoreMonitorCopies=0;
      const verify=setInterval(()=>{
        const outputStreams=rig.outputs.every(o=>{const r=outputReports.get(o.id);return r&&r.ready&&r.width===1920&&r.height===1080&&r.frames>=3&&(r.whiteFrames??0)>0&&(r.grayFrames??0)>0;});
        calibrationPattern=Math.floor((performance.now()-began)/800)%2===0?'white':'gray';
        if(outputStreams&&!restoreStarted){
          liveModeTest=liveMode&&!monitor&&monitorCopies===pausedMonitorCopies&&warpCopies===pausedWarpCopies&&$('input-monitor-panel').hidden&&Array.from(document.querySelectorAll<HTMLElement>('.projector-preview')).every(el=>el.hidden);
          restoreStarted=true;restoreMonitorCopies=monitorCopies;setLiveMode(false);
        }
        const restored=restoreStarted&&!liveMode&&monitor&&monitorCopies>restoreMonitorCopies&&!$('input-monitor-panel').hidden;
        if(restored||performance.now()>deadline){clearInterval(verify);void window.mapper?.ready?.({outputs:renderers.length,width:shared.width,frameTextureTest:passed,calibrationTests,outputStreams,liveModeTest:liveModeTest&&restored,outputDetails:[...outputReports]});}
      },200);

    }
    if(now-presentedAt>1000){presentedFps=(presented-presentedSample)*1000/(now-presentedAt);presentedSample=presented;presentedAt=now;}
    if(++tickCount%12===0){
      const age=lastFrameAt?now-lastFrameAt:Infinity;
      $('output-summary').textContent=blackout?'BLACKOUT · all projector imagery is black':`${calibrationPattern==='none'?'Source input':calibrationPattern.toUpperCase()+' calibration pattern'}${solo?' · SOLO: '+rig.outputs[selected].name:''}${identify?' · IDENTIFY LABELS ON':''}`;
      const mismatch=sourceMode==='ndi'&&latestFrame&&Math.abs(latestFrame.width/latestFrame.height-l.width/1080)>.05;
      $('aspect-warning').hidden=!mismatch;
      $('aspect-warning').textContent=mismatch?`Input is ${latestFrame!.width} × ${latestFrame!.height}; stage is ${l.width} × 1080. ${rig.fit==='contain'?'Fit adds empty areas, which can leave outer projectors black.':rig.fit==='cover'?'Fill crops the input.':'Stretch distorts the input.'} Match ProPresenter’s output aspect to the stage for continuous coverage.`:'';
      $('input-state').textContent=sourceMode==='pattern'?'TEST SOURCE':receiveError?'INPUT ERROR':!connected?'DISCONNECTED':!sequence?'WAITING FOR VIDEO':age>2000?'SIGNAL STALLED · OUTPUT BLACK':'RECEIVING';
      $('input-state').classList.toggle('live',live);
      $('source-label').textContent=!monitor?'INPUT MONITOR PAUSED · output rendering continues':sourceMode==='pattern'?'TEST SOURCE · NOT NDI':`${rig.source||'NDI input'}${receiveError?' · '+receiveError:''}`;
      $('count').textContent=sourceMode==='pattern'?'Test source':sequence.toLocaleString();
      $('resolution').textContent=sourceMode==='pattern'?`${l.width} × 1080`:`${latestFrame?.width??0} × ${latestFrame?.height??0}`;
      $('fps').textContent=sourceMode==='pattern'?'Output: display refresh':`${age<2000?measuredFps.toFixed(1):'0.0'} / ${presentedFps.toFixed(1)} / ${nominalFps.toFixed(2)}`;
      $('age').textContent=sourceMode==='pattern'||!Number.isFinite(age)?'—':`${Math.round(age)} ms · render ${lastRenderMs.toFixed(1)} ms`;
    }
  }
  let animation=0,stopped=false,pollTimer:ReturnType<typeof setTimeout>;
  const animate=()=>{try{render();}catch(e){renderFailed=true;for(let i=0;i<3;i++){const c=$<HTMLCanvasElement>(`projector-${i}`),ctx=c.getContext('2d')!;ctx.fillStyle='#000';ctx.fillRect(0,0,c.width,c.height);}notify(`Rendering stopped; output canvases cleared to black. ${String(e)}. Use Restart preview engine; your calibration is saved.`,true);}if(!stopped)animation=requestAnimationFrame(animate);};
  const receive=async()=>{await poll();if(!stopped)pollTimer=setTimeout(()=>void receive(),connected?4:100);};
  animation=requestAnimationFrame(animate);void receive();
  const statisticsTimer=setInterval(()=>{
    if(connected&&window.mapper?.statistics)void window.mapper.statistics().then(stats=>{ndiStatistics=stats;$('ndi-statistics').textContent=stats?`NDI receiver: ${stats.connections??0} connection(s) · ${stats.queued??0} queued video frames · ${stats.dropped??0} SDK drops${stats.running?'':' · receiver stopped; reconnect'}`:'';}).catch(()=>{});
    else $('ndi-statistics').textContent='';
  },1000);
  const sourceTimer = setInterval(() => { if (nativeAvailable) void updateSources(); }, 3000);
  const displayTimer = setInterval(() => void updateDisplays(), 5000);
  addEventListener('beforeunload', () => { stopped=true;cancelAnimationFrame(animation);clearTimeout(pollTimer); clearInterval(sourceTimer);clearInterval(statisticsTimer); clearInterval(displayTimer); for (const child of children.values()) child.close(); for (const stream of Object.values(window.mapperStreams || {})) stream.getTracks().forEach(t => t.stop()); renderers.forEach(r => r.dispose()); void window.mapper?.disconnect(); });
}
