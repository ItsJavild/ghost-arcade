const { app, BrowserWindow, ipcMain, screen, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
let main, ndi, error = '', lastSequence = 0;
const smoke = process.argv.includes('--mapper-smoke-test') && !!process.env.MAPPER_SMOKE_REPORT;
if (smoke) {
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
const outputs = new Map();
function loadNdi() {
  if (process.platform !== 'win32' || process.arch !== 'x64') { error = 'NDI input requires the Windows x64 desktop build. Test pattern is available here.'; return; }
  try { ndi = require('../native/build/Release/ndi_receiver.node'); ndi.initialize(); }
  catch (e) { error = e.message; ndi = null; }
}
function entry(window, query = {}) { return window.loadFile(path.join(__dirname, '../dist/index.html'), { query }); }
app.whenReady().then(async () => {
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
  loadNdi();
  main = new BrowserWindow({ width: 1450, height: 1000, minWidth: 900, minHeight: 650, backgroundColor: '#10151c', title: 'Three Projector Mapper', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  main.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://ndi.video/') { void shell.openExternal(url); return { action: 'deny' }; }
    const expected = new URL('file://' + path.join(__dirname, '../dist/index.html'));
    try { const u = new URL(url); if (u.protocol === expected.protocol && u.pathname === expected.pathname && /^projector-[0-2]$/.test(u.searchParams.get('output') || '')) return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 580, backgroundColor: '#000000', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } } }; } catch {}
    return { action: 'deny' };
  });
  main.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
  main.webContents.on('did-create-window', (child, details) => {
    const id = new URL(details.url).searchParams.get('output');
    outputs.get(id)?.close(); outputs.set(id, child);
    child.on('closed', () => { if (outputs.get(id) === child) outputs.delete(id); });
    child.webContents.on('before-input-event', (_, input) => { if (input.key === 'Escape') child.close(); });
  });
  const fromMain = e => { if (e.sender !== main.webContents) throw Error('Operator window required.'); };
  if (smoke) {
    const timeout = setTimeout(() => { fs.writeFileSync(process.env.MAPPER_SMOKE_REPORT, JSON.stringify({ ndi: !!ndi, preview: false, error: error || 'Renderer readiness timed out' })); app.exit(1); }, 60000);
    ipcMain.handle('smoke:ready', async (event, info) => {
      fromMain(event); clearTimeout(timeout);
      let loopback;
      try { loopback = ndi?.selfTest(); } catch (e) { error = e.message; }
      const report = { ndi: !!ndi, preview: info?.outputs === 3 && info?.width === 5760, outputs: info?.outputs, width: info?.width, loopback, error, platform: process.platform, arch: process.arch };
      fs.writeFileSync(process.env.MAPPER_SMOKE_REPORT, JSON.stringify(report, null, 2));
      const screenshot = await main.webContents.capturePage();
      fs.writeFileSync(process.env.MAPPER_SMOKE_REPORT + '.png', screenshot.toPNG());
      setTimeout(() => app.exit(report.ndi && report.preview && loopback?.received ? 0 : 1), 100);
      return report;
    });
  }
  ipcMain.handle('ndi:status', e => { fromMain(e); return { available: !!ndi, error }; });
  ipcMain.handle('ndi:sources', e => { fromMain(e); return ndi ? ndi.sources() : []; });
  ipcMain.handle('ndi:connect', (e, name) => { fromMain(e); if (!ndi) throw Error(error); if (typeof name !== 'string' || name.length > 2048) throw Error('Invalid source'); ndi.connect(name); lastSequence = 0; });
  ipcMain.handle('ndi:disconnect', e => { fromMain(e); ndi?.disconnect(); lastSequence = 0; });
  ipcMain.handle('ndi:frame', e => { fromMain(e); if (!ndi) return null; const frame = ndi.frame(lastSequence); if (frame) lastSequence = frame.sequence; return frame; });
  ipcMain.handle('displays', e => { fromMain(e); const operator = screen.getDisplayMatching(main.getBounds()).id; return screen.getAllDisplays().map(d => ({ id: String(d.id), name: d.label || `Display ${d.id}`, width: d.size.width, height: d.size.height, operator: d.id === operator })); });
  ipcMain.handle('output:open', (e, { id, displayId }) => {
    fromMain(e);
    if (!/^projector-[0-2]$/.test(id)) throw Error('Invalid output');
    const window = outputs.get(id); if (!window || window.isDestroyed()) throw Error('Open a preview window first.');
    const display = screen.getAllDisplays().find(d => String(d.id) === displayId);
    if (!display) throw Error('Display disconnected; preview remains available.');
    if (display.id === screen.getDisplayMatching(main.getBounds()).id) throw Error('The operator display is reserved for controls.');
    window.setFullScreen(false); window.setBounds(display.bounds); window.setFullScreen(true); return true;
  });
  ipcMain.handle('output:close', e => { fromMain(e); for (const w of outputs.values()) w.close(); });
  screen.on('display-removed', () => { for (const w of outputs.values()) w.close(); });
  main.on('closed', () => { for (const w of outputs.values()) w.close(); ndi?.disconnect(); main = null; });
  entry(main);
});
app.on('window-all-closed', () => app.quit());
