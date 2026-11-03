import './style.css';
import { defaultRig, GRID, identityMesh, layout, parseRig, setOverlap, sourceRect, type Rig } from './rig';
import { ProjectorRenderer } from './renderer';
import { drawTestPattern } from './testPatterns';

type Display = { id: string; name: string; width: number; height: number; operator: boolean };
type Frame = { width: number; height: number; sequence: number; fps: number; ageMs: number; data: Uint8Array };
type Bridge = {
  status(): Promise<{ available: boolean; error: string }>;
  sources(): Promise<string[]>; connect(name: string): Promise<void>; disconnect(): Promise<void>;
  frame(): Promise<Frame | null>; displays(): Promise<Display[]>;
  openOutput(id: string, displayId: string): Promise<void>; closeOutputs(): Promise<void>;
  ready?(info: { outputs: number; width: number }): Promise<unknown>;
};
declare global { interface Window { mapper?: Bridge; mapperStreams?: Record<string, MediaStream> } }
const root = document.querySelector<HTMLDivElement>('#app')!;
const outputId = new URLSearchParams(location.search).get('output');
const escape = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

if (outputId && /^projector-[0-2]$/.test(outputId)) {
  document.body.className = 'output-window';
  root.innerHTML = '<video autoplay muted playsinline></video><span class="waiting">Waiting for operator preview stream… · Escape closes output</span>';
  const video = root.querySelector('video')!;
  const wait = setInterval(() => {
    try {
      const stream = window.opener?.mapperStreams?.[outputId];
      if (stream) { video.srcObject = stream; void video.play(); root.querySelector('.waiting')?.remove(); clearInterval(wait); }
      else if (!window.opener || window.opener.closed) { clearInterval(wait); window.close(); }
    } catch { root.querySelector('.waiting')!.textContent = 'Output link unavailable. Reopen this preview from the operator window.'; clearInterval(wait); }
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
  const undo: string[] = [], redo: string[] = [], children = new Map<string, Window>();
  try { const saved = localStorage.getItem('mapper-rig-v1'); if (saved) rig = parseRig(saved); } catch { /* default rig if old/corrupt */ }
  root.innerHTML = `
    <header><div class="brand"><span class="mark">◩</span><div><h1>Three Projector Mapper <small>PROTOTYPE · WINDOWS x64</small></h1><p>One source. Three calibrated outputs.</p></div></div><div class="actions"><button id="undo">Undo</button><button id="redo">Redo</button><button id="load">Load rig</button><button id="save">Save rig</button><button id="blackout" class="danger">Blackout outputs</button></div></header>
    <div id="notice" role="status" aria-live="polite">Starting previews…</div>
    <main>
      <section class="panel input"><div class="section-head"><h2><span class="step">01</span> Input</h2><span id="input-state" class="badge">TEST SOURCE</span></div>
        <div class="source-controls"><label>Source<select id="source-mode"><option value="pattern">Animated test pattern</option><option value="ndi">NDI® from ProPresenter</option></select></label><label class="grow">NDI source<select id="ndi-source"><option value="">Select a discovered source</option></select></label><button id="refresh">Refresh sources</button><button id="connect">Connect</button><button id="disconnect">Disconnect</button></div>
        <p id="runtime" class="muted"></p>
        <div class="input-preview"><canvas id="input-preview"></canvas><span id="source-label">TEST SOURCE · NOT NDI</span></div>
        <div class="metrics"><div><span>RECEIVED</span><strong id="count">—</strong></div><div><span>INPUT SIZE</span><strong id="resolution">—</strong></div><div><span>RECEIVED / NOMINAL FPS</span><strong id="fps">—</strong></div><div><span>LAST FRAME AGE</span><strong id="age">—</strong></div></div>
        <p class="muted attribution"><a href="https://ndi.video/" target="_blank" rel="noreferrer">NDI®</a> is a registered trademark of Vizrt NDI AB.</p>
      </section>
      <section class="panel"><div class="section-head"><h2><span class="step">02</span> Canvas & overlap</h2><strong id="canvas-size"></strong></div>
        <div class="canvas-controls"><label>Overlap at each seam (pixels)<input id="overlap" type="number" min="0" max="768" step="1"></label><label>Input scaling<select id="fit"><option value="contain">Fit — preserve entire input</option><option value="cover">Fill — crop to canvas</option><option value="stretch">Stretch to canvas</option></select></label><button id="refresh-displays">Refresh displays</button><button id="close-outputs">Close output windows</button></div>
        <div id="overview" aria-label="Three-projector source crop overview"></div><p class="muted">The overview fits your window. Output resolution stays 1920 × 1080. Drag calibration handles below; use preview windows when no projectors are connected.</p>
      </section>
      <section><div class="section-head"><h2><span class="step">03</span> Projector calibration</h2><div class="actions"><button id="mesh-mode" class="active">Mesh warp</button><button id="mask-mode">Screen mask</button><button id="lock">Lock calibration</button></div></div>
        <div class="projectors">${rig.outputs.map((o, i) => `<article class="panel projector" data-index="${i}"><div class="section-head"><h3>${escape(o.name)}</h3><span class="badge">1920 × 1080</span></div><div class="projector-preview"><canvas id="projector-${i}"></canvas><svg id="handles-${i}" viewBox="0 0 1920 1080" aria-label="${escape(o.name)} calibration handles"></svg></div><label>Output destination<select id="display-${i}"></select></label><div class="actions"><button id="preview-${i}">Open preview</button><button id="send-${i}">Send to display</button></div></article>`).join('')}</div>
        <div class="panel inspector"><div class="section-head"><h3 id="selected-title"></h3><button id="reset">Reset selected geometry</button></div><p id="edit-help" class="muted"></p><div class="calibration-controls">
          <label>Left blend (%)<input id="blend-left" type="number" min="0" max="50" step="0.1"></label><label>Right blend (%)<input id="blend-right" type="number" min="0" max="50" step="0.1"></label><label>Display gamma<input id="gamma" type="number" min="1" max="4" step="0.1"></label><label>Brightness<input id="brightness" type="number" min="0" max="2" step="0.05"></label><label>Black-level lift<input id="black" type="number" min="0" max="0.2" step="0.005"></label>
        </div></div>
      </section>
    </main><footer>GPU mesh / mask / blend previews · Receiver runs independently of physical outputs · Escape exits fullscreen output</footer><input id="file" type="file" accept=".json,application/json" hidden>`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const value = (id: string) => $<HTMLInputElement>(id).value;
  const notify = (message: string, bad = false) => { $('notice').textContent = message; $('notice').classList.toggle('error', bad); };
  const remember = () => { undo.push(JSON.stringify(rig)); if (undo.length > 100) undo.shift(); redo.length = 0; };
  const saveLocal = () => { try { localStorage.setItem('mapper-rig-v1', JSON.stringify(rig)); } catch { notify('Rig autosave unavailable. Use Save rig to export a file.', true); } };
  const raw = $<HTMLCanvasElement>('input-preview'), rawCtx = raw.getContext('2d')!;
  const shared = document.createElement('canvas'), sharedCtx = shared.getContext('2d')!;
  const rawFrame = document.createElement('canvas'), rawFrameCtx = rawFrame.getContext('2d')!;
  const size = layout(rig.overlap); shared.width = size.width; shared.height = size.height;
  raw.width = size.width; raw.height = 1080;
  let renderers: ProjectorRenderer[];
  try { renderers = rig.outputs.map((_, i) => new ProjectorRenderer($<HTMLCanvasElement>(`projector-${i}`), shared)); }
  catch (e) { notify(`GPU preview could not initialize: ${String(e)}`, true); return; }
  window.mapperStreams = {};
  for (let i = 0; i < 3; i++) window.mapperStreams[rig.outputs[i].id] = $<HTMLCanvasElement>(`projector-${i}`).captureStream(30);

  function handles() {
    rig.outputs.forEach((o, i) => {
      const svg = $(`handles-${i}`);
      const points = editMode === 'mesh' ? o.mesh : o.mask;
      const lines: string[] = [];
      if (editMode === 'mesh') {
        for (let y = 0; y < GRID; y++) lines.push(`<polyline points="${o.mesh.slice(y * GRID, (y + 1) * GRID).map(p => `${p.x * 1920},${p.y * 1080}`).join(' ')}"/>`);
        for (let x = 0; x < GRID; x++) lines.push(`<polyline points="${Array.from({ length: GRID }, (_, y) => o.mesh[y * GRID + x]).map(p => `${p.x * 1920},${p.y * 1080}`).join(' ')}"/>`);
      } else lines.push(`<polygon points="${o.mask.map(p => `${p.x * 1920},${p.y * 1080}`).join(' ')}"/>`);
      svg.innerHTML = lines.join('') + points.map((p, n) => `<circle data-point="${n}" cx="${p.x * 1920}" cy="${p.y * 1080}" r="${editMode === 'mesh' ? 15 : 23}"/>`).join('');
      svg.classList.toggle('locked', locked);
      $(`projector-${i}`).closest('article')!.classList.toggle('selected', i === selected);
    });
  }
  function refreshControls() {
    const o = rig.outputs[selected];
    $('selected-title').textContent = `${o.name} · ${editMode === 'mesh' ? '5 × 5 independent mesh' : 'four-point projector mask'}`;
    $('edit-help').textContent = locked ? 'Calibration is locked.' : editMode === 'mesh' ? 'Drag any grid point to fit this projector to the screen. Each projector keeps its own mesh.' : 'Drag the four mask points to clip light to the screen boundary. Mask coordinates are independent of the mesh.';
    for (const [id, v] of Object.entries({ 'blend-left': o.left * 100, 'blend-right': o.right * 100, gamma: o.gamma, brightness: o.brightness, black: o.black, overlap: rig.overlap })) $<HTMLInputElement>(id).value = String(Math.round(v * 10000) / 10000);
    $<HTMLSelectElement>('fit').value = rig.fit;
    $('mesh-mode').classList.toggle('active', editMode === 'mesh'); $('mask-mode').classList.toggle('active', editMode === 'mask');
    $('lock').textContent = locked ? 'Unlock calibration' : 'Lock calibration';
    for (const id of ['blend-left', 'blend-right', 'gamma', 'brightness', 'black', 'overlap', 'fit', 'reset']) ($<HTMLInputElement>(id)).disabled = locked;
    for (let i = 0; i < 3; i++) $<HTMLSelectElement>(`display-${i}`).disabled = locked;
    handles(); overview();
  }
  function overview() {
    const l = layout(rig.overlap);
    $('canvas-size').textContent = `${l.width} × ${l.height}`;
    $('overview').style.aspectRatio = `${l.width} / 1080`;
    $('overview').innerHTML = rig.outputs.map((o, i) => `<div style="left:${l.starts[i] / l.width * 100}%;width:${1920 / l.width * 100}%"><span>${escape(o.name)} · ${Math.round(l.starts[i])}–${Math.round(l.starts[i] + 1920)} px</span></div>`).join('');
  }
  async function updateDisplays() {
    try { displays = window.mapper ? await window.mapper.displays() : []; }
    catch (e) { notify(String(e), true); }
    rig.outputs.forEach((o, i) => {
      const select = $<HTMLSelectElement>(`display-${i}`);
      select.innerHTML = '<option value="">Preview only — no projector needed</option>' + displays.filter(d => !d.operator).map(d => `<option value="${escape(d.id)}">${escape(d.name)} · ${d.width} × ${d.height}</option>`).join('');
      if (o.displayId && !displays.some(d => d.id === o.displayId && !d.operator)) select.insertAdjacentHTML('beforeend', `<option value="${escape(o.displayId)}">Saved display disconnected · preview only</option>`);
      select.value = o.displayId;
    });
  }
  async function updateSources() {
    try {
      sources = window.mapper ? await window.mapper.sources() : [];
      const select = $<HTMLSelectElement>('ndi-source'), before = select.value || rig.source;
      select.innerHTML = '<option value="">Select a discovered source</option>' + sources.map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join('');
      if (sources.includes(before)) select.value = before;
    } catch (e) { notify(`Discovery failed: ${String(e)}`, true); }
  }
  function openPreview(i: number) {
    const id = rig.outputs[i].id, previous = children.get(id);
    if (previous && !previous.closed) { previous.focus(); return previous; }
    const url = new URL(location.href); url.search = `?output=${id}`;
    const child = window.open(url, id, 'popup,width=960,height=580');
    if (!child) notify('Preview window blocked. Allow popups for this app.', true);
    else children.set(id, child);
    return child;
  }
  let dragging: { index: number; point: number; pointer: number; svg: SVGSVGElement } | null = null;
  for (let i = 0; i < 3; i++) {
    const svg = document.getElementById(`handles-${i}`) as unknown as SVGSVGElement;
    svg.addEventListener('pointerdown', e => {
      selected = i; refreshControls();
      if (locked) return;
      // The handles are rebuilt on selection, so use the original target index.
      const n = (e.target as Element).getAttribute('data-point'); if (n === null) return;
      remember(); dragging = { index: i, point: Number(n), pointer: e.pointerId, svg }; svg.setPointerCapture(e.pointerId); e.preventDefault();
    });
    svg.addEventListener('pointermove', e => {
      if (!dragging || dragging.svg !== svg) return;
      const r = svg.getBoundingClientRect(), list = editMode === 'mesh' ? rig.outputs[i].mesh : rig.outputs[i].mask;
      list[dragging.point] = { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; handles();
    });
    const finish = () => { if (dragging?.svg === svg) { dragging = null; saveLocal(); } };
    svg.addEventListener('pointerup', finish); svg.addEventListener('pointercancel', finish); svg.addEventListener('lostpointercapture', finish);
    $(`preview-${i}`).onclick = () => openPreview(i);
    $(`send-${i}`).onclick = async () => {
      const o = rig.outputs[i];
      if (!o.displayId) { openPreview(i); notify(`${o.name} is preview only.`); return; }
      if (!window.mapper) { notify('Physical display routing requires the desktop app.', true); return; }
      openPreview(i);
      // Give Electron time to register a newly created child window.
      let lastError: unknown;
      for (let attempt = 0; attempt < 8; attempt++) {
        try { await window.mapper.openOutput(o.id, o.displayId); notify(`${o.name} sent to its assigned display. Escape closes it.`); return; }
        catch (e) { lastError = e; await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      notify(String(lastError), true);
    };
    $(`display-${i}`).onchange = () => {
      const id = value(`display-${i}`);
      if (id && rig.outputs.some((o, j) => j !== i && o.displayId === id)) { notify('That display is already assigned to another projector.', true); void updateDisplays(); return; }
      remember(); rig.outputs[i].displayId = id; saveLocal();
      children.get(rig.outputs[i].id)?.close();
    };
  }
  const numberControls: Record<string, { key: 'left' | 'right' | 'gamma' | 'brightness' | 'black'; scale: number; min: number; max: number }> = {
    'blend-left': { key: 'left', scale: .01, min: 0, max: 50 }, 'blend-right': { key: 'right', scale: .01, min: 0, max: 50 },
    gamma: { key: 'gamma', scale: 1, min: 1, max: 4 }, brightness: { key: 'brightness', scale: 1, min: 0, max: 2 }, black: { key: 'black', scale: 1, min: 0, max: .2 }
  };
  for (const [id, config] of Object.entries(numberControls)) $(id).onchange = () => {
    const n = Number(value(id)); if (!Number.isFinite(n)) { refreshControls(); return; }
    remember(); rig.outputs[selected][config.key] = Math.max(config.min, Math.min(config.max, n)) * config.scale; saveLocal(); refreshControls();
  };
  $('overlap').onchange = () => { const n = Number(value('overlap')); if (!Number.isFinite(n)) return; remember(); setOverlap(rig, n); saveLocal(); refreshControls(); };
  $('fit').onchange = () => { remember(); rig.fit = value('fit') as Rig['fit']; saveLocal(); };
  $('mesh-mode').onclick = () => { editMode = 'mesh'; refreshControls(); };
  $('mask-mode').onclick = () => { editMode = 'mask'; refreshControls(); };
  $('lock').onclick = () => { locked = !locked; refreshControls(); };
  $('reset').onclick = () => { remember(); const o = rig.outputs[selected]; if (editMode === 'mesh') o.mesh = identityMesh(); else o.mask = defaultRig().outputs[selected].mask; saveLocal(); refreshControls(); };
  $('blackout').onclick = () => { blackout = !blackout; $('blackout').textContent = blackout ? 'BLACKOUT ON · Resume outputs' : 'Blackout outputs'; $('blackout').classList.toggle('blackout-on', blackout); };
  $('undo').onclick = () => { if (locked || !undo.length) return; redo.push(JSON.stringify(rig)); rig = parseRig(undo.pop()!); saveLocal(); refreshControls(); void updateDisplays(); };
  $('redo').onclick = () => { if (locked || !redo.length) return; undo.push(JSON.stringify(rig)); rig = parseRig(redo.pop()!); saveLocal(); refreshControls(); void updateDisplays(); };
  $('save').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(rig, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'three-projector-rig.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Rig exported. Meshes, masks, overlap and display assignments included.');
  };
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
  $('disconnect').onclick = async () => { connectionGeneration++; connected = false; sequence = 0; lastFrameAt = 0; await window.mapper?.disconnect(); notify('NDI receiver disconnected.'); };
  $('source-mode').onchange = async () => {
    sourceMode = value('source-mode') as typeof sourceMode; connectionGeneration++; connected = false; sequence = 0; lastFrameAt = 0; await window.mapper?.disconnect();
    notify(sourceMode === 'pattern' ? 'Animated test source active. This is not an NDI reception test.' : 'Select a ProPresenter source and connect.');
  };
  $('connect').onclick = async () => {
    if (!nativeAvailable || !window.mapper) { notify('NDI receiver unavailable. See the runtime status above.', true); return; }
    const name = value('ndi-source'); if (!name) { notify('Select a discovered NDI source first.', true); return; }
    const generation = ++connectionGeneration;
    connected = false; sequence = 0; lastFrameAt = 0; receiveError = '';
    sampleSequence = 0; sampleTime = performance.now(); measuredFps = 0;
    try {
      await window.mapper.connect(name);
      if (generation !== connectionGeneration) return;
      sourceMode = 'ndi'; $<HTMLSelectElement>('source-mode').value = sourceMode; connected = true; rig.source = name; saveLocal(); notify('Receiver started. Waiting for the first real video frame…');
    } catch (e) { notify(String(e), true); }
  };
  try {
    const status = window.mapper ? await window.mapper.status() : { available: false, error: 'Browser preview: NDI requires the Windows x64 desktop app and its native receiver.' };
    nativeAvailable = status.available; $('runtime').textContent = status.available ? 'Windows NDI receiver ready. Local ProPresenter sources are included in discovery.' : status.error;
  } catch (e) { $('runtime').textContent = String(e); }
  for (const id of ['ndi-source', 'connect', 'refresh', 'disconnect']) $<HTMLButtonElement>(id).disabled = !nativeAvailable;
  await updateDisplays(); await updateSources(); refreshControls(); notify('Preview-only rig ready. No projectors required. Drag a mesh point to calibrate.');

  async function poll() {
    if (busy || sourceMode !== 'ndi' || !connected || !window.mapper) return;
    busy = true; const generation = connectionGeneration;
    try {
      const frame = await window.mapper.frame();
      if (generation !== connectionGeneration || !frame) return;
      if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 16384 || frame.height > 8192 || frame.data.length !== frame.width * frame.height * 4) throw Error('Invalid received video frame.');
      if (rawFrame.width !== frame.width || rawFrame.height !== frame.height) { rawFrame.width = frame.width; rawFrame.height = frame.height; }
      rawFrameCtx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
      sequence = frame.sequence; nominalFps = frame.fps; lastFrameAt = performance.now() - frame.ageMs; receiveError = '';
      const now = performance.now();
      if (now - sampleTime > 1000) { measuredFps = Math.max(0, (sequence - sampleSequence) * 1000 / (now - sampleTime)); sampleSequence = sequence; sampleTime = now; }
    } catch (e) { receiveError = String(e); }
    finally { busy = false; }
  }
  function render() {
    if (renderFailed) return;
    const now = performance.now(), l = layout(rig.overlap);
    if (shared.width !== l.width) shared.width = l.width;
    sharedCtx.fillStyle = '#000'; sharedCtx.fillRect(0, 0, shared.width, shared.height);
    if (sourceMode === 'pattern') {
      if (raw.width !== l.width || raw.height !== 1080) { raw.width = l.width; raw.height = 1080; }
      drawTestPattern(rawCtx, raw.width, raw.height, 'grid');
      const colors = ['rgba(70,140,210,.2)', 'rgba(210,160,70,.2)', 'rgba(70,190,145,.2)'];
      rig.outputs.forEach((o, i) => {
        rawCtx.fillStyle = colors[i]; rawCtx.fillRect(l.starts[i], 0, 1920, 1080);
        rawCtx.fillStyle = '#d4e7ed'; rawCtx.font = 'bold 100px monospace';
        rawCtx.fillText(o.name.toUpperCase(), l.starts[i] + 160, 300);
      });
      rawCtx.fillStyle = '#6fe0c4'; const x = (now / 40) % raw.width; rawCtx.fillRect(x, 0, 12, raw.height);
      rawCtx.font = '40px monospace'; rawCtx.fillText(`TEST SOURCE · ${++patternCount}`, 40, 80);
      sharedCtx.drawImage(raw, 0, 0);
    } else {
      const w = sequence ? rawFrame.width : 1920, h = sequence ? rawFrame.height : 1080;
      if (raw.width !== w || raw.height !== h) { raw.width = w; raw.height = h; }
      rawCtx.fillStyle = '#000'; rawCtx.fillRect(0, 0, w, h);
      const live = connected && sequence > 0 && now - lastFrameAt < 2000 && !receiveError;
      if (live) { rawCtx.drawImage(rawFrame, 0, 0); const r = sourceRect(w, h, shared.width, shared.height, rig.fit); sharedCtx.drawImage(rawFrame, r.x, r.y, r.w, r.h); }
    }
    raw.style.aspectRatio = `${raw.width}/${raw.height}`;
    renderers.forEach((renderer, i) => renderer.render(rig.outputs[i], i, rig, blackout));
    if (tickCount === 10) void window.mapper?.ready?.({ outputs: renderers.length, width: shared.width });
    if (++tickCount % 6 === 0) {
      const age = lastFrameAt ? now - lastFrameAt : Infinity;
      $('input-state').textContent = sourceMode === 'pattern' ? 'TEST SOURCE' : receiveError ? 'INPUT ERROR' : !connected ? 'DISCONNECTED' : !sequence ? 'WAITING FOR VIDEO' : age > 2000 ? 'SIGNAL STALLED · OUTPUT BLACK' : 'RECEIVING';
      $('input-state').classList.toggle('live', sourceMode === 'ndi' && connected && sequence > 0 && age <= 2000);
      $('source-label').textContent = sourceMode === 'pattern' ? 'TEST SOURCE · NOT NDI' : `${rig.source || 'NDI input'}${receiveError ? ' · ' + receiveError : ''}`;
      $('count').textContent = sourceMode === 'pattern' ? 'Test source' : sequence.toLocaleString();
      $('resolution').textContent = `${raw.width} × ${raw.height}`;
      $('fps').textContent = sourceMode === 'pattern' ? 'Preview: 30 target' : `${age < 2000 ? measuredFps.toFixed(1) : '0.0'} / ${nominalFps.toFixed(2)}`;
      $('age').textContent = sourceMode === 'pattern' || !Number.isFinite(age) ? '—' : `${Math.round(age)} ms`;
    }
  }
  const timer = setInterval(() => { void poll(); try { render(); } catch (e) { renderFailed = true; notify(`Rendering stopped: ${String(e)}`, true); } }, 1000 / 30);
  const sourceTimer = setInterval(() => { if (nativeAvailable) void updateSources(); }, 3000);
  const displayTimer = setInterval(() => void updateDisplays(), 5000);
  addEventListener('beforeunload', () => { clearInterval(timer); clearInterval(sourceTimer); clearInterval(displayTimer); for (const child of children.values()) child.close(); for (const stream of Object.values(window.mapperStreams || {})) stream.getTracks().forEach(t => t.stop()); renderers.forEach(r => r.dispose()); void window.mapper?.disconnect(); });
}
