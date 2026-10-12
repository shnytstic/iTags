const { app, BrowserWindow, Menu, protocol, shell, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const isMac = process.platform === 'darwin';
const SRC = path.join(__dirname, 'src');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.map': 'application/json'
};

// Serve the UI from a real, secure origin (app://itags) instead of file:// so
// Web Workers, WebAssembly (ffmpeg) and localStorage behave like on a normal site.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

let win = null;
const statePath = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}
function saveState() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {}
}

function send(action) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', action);
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add Files…', accelerator: 'CmdOrCtrl+O', click: () => send('add') },
        { label: 'Export All', accelerator: 'CmdOrCtrl+S', click: () => send('export') },
        { label: 'Export as ZIP', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('zip') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Track',
      submenu: [
        { label: 'Find Track…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { label: 'Preview Tags', accelerator: 'CmdOrCtrl+P', click: () => send('preview') },
        { label: 'Search Cover Art…', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('cover') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'reload' }])
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const st = loadState();
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: st.width || 1180,
    height: st.height || 760,
    x: st.x, y: st.y,
    minWidth: 900, minHeight: 600,
    backgroundColor: dark ? '#17171c' : '#faf9f7',
    show: false,
    autoHideMenuBar: !isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: { color: dark ? '#1c1c23' : '#f1efeb', symbolColor: dark ? '#f2efe8' : '#1c1917', height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveState);
  win.on('closed', () => { win = null; });

  // External links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });

  win.loadURL('app://itags/index.html');
}

ipcMain.on('theme', (_e, { color, symbol }) => {
  if (!win || win.isDestroyed() || isMac) return;
  try { win.setTitleBarOverlay({ color, symbolColor: symbol, height: 44 }); } catch {}
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    protocol.handle('app', async (request) => {
      try {
        const url = new URL(request.url);
        let rel = decodeURIComponent(url.pathname);
        if (rel === '/' || rel === '') rel = '/index.html';
        const full = path.normalize(path.join(SRC, rel));
        if (!full.startsWith(SRC + path.sep)) return new Response('Forbidden', { status: 403 });
        const data = await fs.promises.readFile(full);
        return new Response(data, { headers: { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    buildMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
}
