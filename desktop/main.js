// freeaitokens tray app: runs the same local endpoint as the CLI, from the menu bar / system tray.
import { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, nativeImage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { loadCatalogue, makeDeps, parseArgs } from 'freeaitokens/dist/node/cli.js';
import { startServer, DEFAULT_PORT } from 'freeaitokens/dist/node/server.js';
import { currentCatalogue, updateCatalogue } from 'freeaitokens/dist/node/remote.js';
import { openKeyStore } from 'freeaitokens/dist/node/keys.js';
import { localToken, saveState } from 'freeaitokens/dist/node/state.js';
import { runList, validateKey, keySteps, connectOpenRouter } from 'freeaitokens/dist/node/add.js';
import { allowedUrl, choices, menuTemplate } from './logic.js';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();

let tray, srv, deps, keys, addWindow;

function refresh() {
  const lines = runList(deps.catalogue, keys, deps.tracker).split('\n');
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(
    { port: srv.port, reused: srv.reused, lines, startAtLogin: app.getLoginItemSettings().openAtLogin },
    {
      copyEndpoint: () => clipboard.writeText(`http://127.0.0.1:${srv.port}/v1`),
      copyToken: () => clipboard.writeText(localToken()),
      add: openAdd,
      toggleLogin: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      quit: () => app.quit(),
    },
  )));
}

function openAdd() {
  if (addWindow) return addWindow.focus();
  addWindow = new BrowserWindow({
    width: 520, height: 600, title: 'Add a free provider', autoHideMenuBar: true,
    webPreferences: { preload: here('./preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // The window shows only our own page: no navigation, no new windows.
  addWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  addWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  addWindow.loadFile(here('./add.html'));
  addWindow.on('closed', () => { addWindow = null; refresh(); });
}

ipcMain.handle('providers', () => choices(deps.catalogue, keys, keySteps));
ipcMain.handle('open', (_e, url) => { if (allowedUrl(deps.catalogue, url)) void shell.openExternal(url); });
ipcMain.handle('save', async (_e, id, key) => {
  const prov = deps.catalogue.find((p) => p.id === id && !p.keyless);
  if (!prov || typeof key !== 'string' || !key.trim()) return { ok: false, reason: 'nothing to save' };
  const v = await validateKey(prov, key.trim(), fetch);
  if (v.ok) keys.set(prov.id, key.trim());
  return v;
});
ipcMain.handle('connect', async (_e, id) => {
  const prov = deps.catalogue.find((p) => p.id === id && p.connect === 'openrouter');
  if (!prov) return { ok: false, reason: 'not a connect provider' };
  try {
    keys.set(prov.id, await connectOpenRouter(fetch, (u) => void shell.openExternal(u)));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

app.on('window-all-closed', () => {}); // closing the add window must not quit the tray app
app.on('second-instance', () => openAdd());
// A second copy quits before it has loaded anything, so there may be nothing to save.
app.on('before-quit', async () => { if (deps) saveState(deps.tracker.state); await srv?.close(); });

app.whenReady().then(async () => {
  app.dock?.hide();
  keys = openKeyStore();
  deps = makeDeps(currentCatalogue(loadCatalogue()), keys, parseArgs([]));
  void updateCatalogue().then((c) => { if (c) { deps.catalogue = c; refresh(); } });
  const icon = nativeImage.createFromPath(here(process.platform === 'darwin' ? './icons/trayTemplate.png' : './icons/tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('freeaitokens');
  try {
    srv = await startServer(deps, DEFAULT_PORT);
  } catch (e) {
    tray.setContextMenu(Menu.buildFromTemplate([{ label: e.message, enabled: false }, { label: 'Quit', click: () => app.quit() }]));
    return;
  }
  refresh();
  setInterval(refresh, 60_000); // keeps "left today" current
  if (!deps.catalogue.some((p) => !p.keyless && keys.get(p.id))) openAdd();
});
