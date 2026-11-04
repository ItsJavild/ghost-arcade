const { app, BrowserWindow, ipcMain, screen, shell, dialog, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { rigStore } = require('./rig-store.cjs');
let main, ndi, error = '', lastSequence = 0;
// Projector playback must continue when another application covers the operator
// or output windows. backgroundThrottling alone does not bypass Windows native
// occlusion in this Chromium build (covered videos decoded but presented no frames).
if(process.platform==='win32'){
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
}
const smoke = process.argv.includes('--mapper-smoke-test') && !!process.env.MAPPER_SMOKE_REPORT;
if (smoke) {
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
const outputs = new Map(), destinations = new Map();
let operatorDisplayId;
const primaryInstance=app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => { if(main){if(main.isMinimized())main.restore();main.focus();} });
function loadNdi() {
  if (process.platform !== 'win32' || process.arch !== 'x64') { error = 'NDI input requires the Windows x64 desktop build. Test pattern is available here.'; return; }
  try { ndi = require('../native/build/Release/ndi_receiver.node'); ndi.initialize(); }
  catch (e) { error = e.message; ndi = null; }
}
function entry(window, query = {}) { return window.loadFile(path.join(__dirname, '../dist/index.html'), { query }); }
app.whenReady().then(async () => {
  if(!primaryInstance)return;
  const terms = path.join(path.dirname(process.execPath), 'third-party', 'NDI-SDK-License-Agreement.pdf');
  const receipt = path.join(app.getPath('userData'), 'ndi-terms-v1.json');
  if (!smoke && app.isPackaged && fs.existsSync(terms) && !fs.existsSync(receipt)) {
    for (;;) {
      const choice = await dialog.showMessageBox({ type: 'info', title: 'NDI runtime license', message: 'This test package includes the NDI runtime.', detail: 'The mapper is AGPL-3.0 software. The separate NDI runtime is proprietary and subject to the included NDI SDK License Agreement. Review its terms before accepting and launching.', buttons: ['Read NDI agreement', 'Accept and launch', 'Quit'], defaultId: 0, cancelId: 2, noLink: true });
      if (choice.response === 0) { await shell.openPath(terms); continue; }
      if (choice.response === 2) { app.quit(); return; }
      fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(receipt, JSON.stringify({ accepted: new Date().toISOString() })); break;
    }
  }
  if(smoke) app.setPath('userData',path.join(app.getPath('temp'),'mapper-smoke-'+process.pid));
  const store = rigStore(app.getPath('userData'));
  powerSaveBlocker.start('prevent-display-sleep');
  loadNdi();
  main = new BrowserWindow({ width: 1450, height: 1000, minWidth: 900, minHeight: 650, backgroundColor: '#10151c', title: 'Three Projector Mapper', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  main.removeMenu();
  operatorDisplayId=screen.getDisplayMatching(main.getBounds()).id;
  main.on('move',()=>{if(!destinations.size)operatorDisplayId=screen.getDisplayMatching(main.getBounds()).id;});
  main.on('close', event => { if(!smoke && outputs.size){const choice=dialog.showMessageBoxSync(main,{type:'question',message:'Close the mapper and all projector outputs?',buttons:['Keep running','Close mapper'],defaultId:0,cancelId:0});if(choice===0)event.preventDefault();} });
  main.webContents.on('before-input-event',(event,input)=>{if(input.key==='F5'||((input.control||input.meta)&&['r','R','+','-','0'].includes(input.key)))event.preventDefault();});
  main.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://ndi.video/') { void shell.openExternal(url); return { action: 'deny' }; }
    const expected = new URL('file://' + path.join(__dirname, '../dist/index.html'));
    try { const u = new URL(url); if (u.protocol === expected.protocol && u.pathname === expected.pathname && /^projector-[0-2]$/.test(u.searchParams.get('output') || '')) return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 580, backgroundColor: '#000000', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } } }; } catch {}
    return { action: 'deny' };
  });
  main.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
  main.webContents.on('did-create-window', (child, details) => {
    child.removeMenu();
    const id = new URL(details.url).searchParams.get('output');
    outputs.get(id)?.close(); outputs.set(id, child);
    child.on('closed', () => { if (outputs.get(id) === child) { outputs.delete(id); destinations.delete(id); } });
    child.webContents.on('before-input-event', (_, input) => { if (input.key === 'Escape') child.close(); });
  });
  const fromMain = e => { if (e.sender !== main.webContents) throw Error('Operator window required.'); };
  if (smoke) {
    const timeout = setTimeout(() => { fs.writeFileSync(process.env.MAPPER_SMOKE_REPORT, JSON.stringify({ ndi: !!ndi, preview: false, error: error || 'Renderer readiness timed out' })); app.exit(1); }, 90000);
    ipcMain.handle('smoke:ready', async (event, info) => {
      fromMain(event); clearTimeout(timeout);
      let loopback;
      try { loopback = ndi?.selfTest(); } catch (e) { error = e.message; }
      const report = { outputDetails:info?.outputDetails, windowCount:outputs.size, liveModeTest:info?.liveModeTest===true, outputStreams:info?.outputStreams===true, calibrationTests:info?.calibrationTests===true, frameTextureTest: info?.frameTextureTest === true, ndi: !!ndi, preview: info?.outputs === 3 && info?.width === 5760, outputs: info?.outputs, width: info?.width, loopback, error, platform: process.platform, arch: process.arch };
      fs.writeFileSync(process.env.MAPPER_SMOKE_REPORT, JSON.stringify(report, null, 2));
      const screenshot = await main.webContents.capturePage();
      fs.writeFileSync(process.env.MAPPER_SMOKE_REPORT + '.png', screenshot.toPNG());
      setTimeout(() => app.exit(report.ndi && report.preview && report.frameTextureTest && report.outputStreams && report.liveModeTest && report.calibrationTests && loopback?.received ? 0 : 1), 100);
      return report;
    });
  }
  ipcMain.handle('ndi:status', e => { fromMain(e); return { available: !!ndi, error, smoke }; });
  ipcMain.handle('ndi:statistics',e=>{fromMain(e);return ndi?.statistics()??null;});
  ipcMain.handle('ndi:sources', e => { fromMain(e); return ndi ? ndi.sources() : []; });
  ipcMain.handle('ndi:connect', (e, name) => { fromMain(e); if (!ndi) throw Error(error); if (typeof name !== 'string' || name.length > 2048) throw Error('Invalid source'); ndi.connect(name); lastSequence = 0; });
  ipcMain.handle('ndi:disconnect', e => { fromMain(e); ndi?.disconnect(); lastSequence = 0; });
  ipcMain.handle('ndi:frame', e => { fromMain(e); if (!ndi) return null; const frame = ndi.frame(lastSequence); if (frame) lastSequence = frame.sequence; return frame; });
  ipcMain.handle('file:export', async (e,{kind,text})=>{
    fromMain(e);
    if(!['rig','diagnostics'].includes(kind)||typeof text!=='string'||Buffer.byteLength(text)>1024*1024)throw Error('Invalid export');
    JSON.parse(text);
    const result=await dialog.showSaveDialog(main,{title:kind==='rig'?'Export projector calibration':'Save mapper diagnostics',defaultPath:path.join(app.getPath('documents'),kind==='rig'?'three-projector-rig.json':'mapper-diagnostics.json'),filters:[{name:'JSON',extensions:['json']}]});
    if(result.canceled||!result.filePath)return null;
    fs.writeFileSync(result.filePath,text,'utf8');return result.filePath;
  });
  ipcMain.handle('rig:read', e => { fromMain(e); return store.read(); });
  ipcMain.handle('rig:save', (e,text) => { fromMain(e); store.save(text); return true; });
  ipcMain.handle('output:status',e=>{fromMain(e);return [...outputs].map(([id,w])=>({id,displayId:destinations.get(id)||'',fullscreen:w.isFullScreen()}));});
  ipcMain.handle('displays', e => { fromMain(e); return screen.getAllDisplays().map(d => ({ id: String(d.id), name: d.label || `Display ${d.id}`, width: Math.round(d.size.width*d.scaleFactor), height: Math.round(d.size.height*d.scaleFactor), refreshRate:d.displayFrequency, operator: d.id === operatorDisplayId })); });
  ipcMain.handle('output:open', (e, { id, displayId }) => {
    fromMain(e);
    if (!/^projector-[0-2]$/.test(id)) throw Error('Invalid output');
    const window = outputs.get(id); if (!window || window.isDestroyed()) throw Error('Open a preview window first.');
    const display = screen.getAllDisplays().find(d => String(d.id) === displayId);
    if (!display) throw Error('Display disconnected; preview remains available.');
    if (display.id === operatorDisplayId) throw Error('The operator display is reserved for controls.');
    if([...destinations].some(([other,d])=>other!==id&&d===displayId))throw Error('Display already in use by another output.');
    destinations.set(id,displayId);
    window.setFullScreen(false); window.setBounds(display.bounds); window.setFullScreen(true); return true;
  });
  ipcMain.handle('output:close', e => { fromMain(e); for (const w of outputs.values()) w.close(); });
  screen.on('display-removed', (_event,display) => { for (const [id,w] of outputs) if(destinations.get(id)===String(display.id)) w.close(); });
  screen.on('display-metrics-changed', (_event,display) => { for(const [id,w] of outputs)if(destinations.get(id)===String(display.id)){w.setFullScreen(false);w.setBounds(display.bounds);w.setFullScreen(true);} });
  main.webContents.on('render-process-gone', () => { for(const w of outputs.values())w.close();ndi?.disconnect(); });
  main.on('closed', () => { for (const w of outputs.values()) w.close(); ndi?.disconnect(); main = null; });
  entry(main);
});
app.on('window-all-closed', () => app.quit());
