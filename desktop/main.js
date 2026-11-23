// freeaitokens tray app: runs the same local endpoint as the CLI, from the menu bar / system tray.
import { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, nativeImage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue, makeDeps, parseArgs } from 'freeaitokens/dist/node/cli.js';
import { startServer, DEFAULT_PORT } from 'freeaitokens/dist/node/server.js';
import { currentCatalogue, updateCatalogue } from 'freeaitokens/dist/node/remote.js';
import { openKeyStore } from 'freeaitokens/dist/node/keys.js';
import { localToken, saveState, loadState, stateDir } from 'freeaitokens/dist/node/state.js';
import { validateKey, keySteps, connectOpenRouter } from 'freeaitokens/dist/node/add.js';
import { launchSpec, LAUNCH_TOOLS } from 'freeaitokens/dist/node/harness.js';
import { route, NoCapacityError } from 'freeaitokens/dist/core/orchestrator.js';
import { allowedUrl, choices, menuTemplate, providerRows, cleanMessages, launchFile, modelOptions, narrowTo, newerVersion, usageSummary, pickLang } from './logic.js';
import './t.js';
import { needsAccount, joinAccount } from 'freeaitokens/dist/core/catalogue.js';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();

let tray, srv, deps, keys, addWindow, mainWindow;
const endpoint = () => `http://127.0.0.1:${srv.port}/v1`;

// Language: the one picked in Settings (saved next to the app's state), else the computer's.
const LOCALES = JSON.parse(readFileSync(here('./i18n/locales.json'), 'utf8'));
const settingsFile = () => join(stateDir(), 'desktop.json');
const readSettings = () => { try { return JSON.parse(readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
let locale, strings, t;
function loadLang() {
  const code = pickLang(readSettings().lang, app.getPreferredSystemLanguages(), LOCALES.map((l) => l.code));
  const read = (c) => JSON.parse(readFileSync(here(`./i18n/${c}.json`), 'utf8'));
  locale = LOCALES.find((l) => l.code === code);
  strings = { ...read('en'), ...(code === 'en' ? {} : read(code)) };
  t = globalThis.makeTranslator(strings, locale.lang);
}

function refresh() {
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(
    { port: srv.port, reused: srv.reused, startAtLogin: app.getLoginItemSettings().openAtLogin },
    {
      open: openMain,
      copyEndpoint: () => clipboard.writeText(endpoint()),
      copyToken: () => clipboard.writeText(localToken()),
      add: () => openAdd(),
      toggleLogin: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      quit: () => app.quit(),
    },
    t,
  )));
}

function lockDown(win) {
  // Windows show only our own pages: no navigation, no new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function openMain() {
  if (!srv) return;
  if (mainWindow) return mainWindow.show(), mainWindow.focus();
  mainWindow = new BrowserWindow({
    width: 980, height: 700, minWidth: 720, minHeight: 520, title: 'FreeAITokens', autoHideMenuBar: true,
    icon: here('./icons/icon.png'),
    webPreferences: { preload: here('./preload-app.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  lockDown(mainWindow);
  mainWindow.loadFile(here('./app.html'));
  void app.dock?.show();
  mainWindow.on('closed', () => { mainWindow = null; if (!addWindow) app.dock?.hide(); });
}

function openAdd(id) {
  if (addWindow) return addWindow.focus();
  addWindow = new BrowserWindow({
    width: 520, height: 600, title: t('add_title'), autoHideMenuBar: true,
    webPreferences: { preload: here('./preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  lockDown(addWindow);
  addWindow.loadFile(here('./add.html'), typeof id === 'string' && /^[a-z0-9-]+$/.test(id) ? { query: { p: id } } : {});
  addWindow.on('closed', () => { addWindow = null; refresh(); });
}

ipcMain.handle('providers', () => choices(deps.catalogue, keys, keySteps));
ipcMain.handle('open', (_e, url) => { if (allowedUrl(deps.catalogue, url)) void shell.openExternal(url); });
ipcMain.handle('save', async (_e, id, key, account) => {
  const prov = deps.catalogue.find((p) => p.id === id && !p.keyless);
  if (!prov || typeof key !== 'string' || !key.trim()) return { ok: false, reason: t('err_nothing') };
  const stored = needsAccount(prov) ? joinAccount(typeof account === 'string' ? account : '', key) : key.trim();
  if (!stored) return { ok: false, reason: t('err_account') };
  const v = await validateKey(prov, stored, fetch);
  if (v.ok) keys.set(prov.id, stored);
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

// The main window's calls. Everything it sends is checked here: it is a web page.
ipcMain.handle('app:status', () => ({
  port: srv.port, reused: srv.reused, endpoint: endpoint(),
  providers: providerRows(deps.catalogue, keys, deps.tracker),
  tools: Object.entries(LAUNCH_TOOLS).map(([id, name]) => ({ id, name, note: strings[`note_${id}`] ?? '' })),
  models: modelOptions(deps.catalogue, keys),
  version: app.getVersion(),
  startAtLogin: app.getLoginItemSettings().openAtLogin,
}));
// Routed here rather than over HTTP, so the answer always says which provider and model gave it,
// even when another copy of FreeAITokens holds the port.
ipcMain.handle('app:chat', async (_e, list, choice = 'free') => {
  const messages = cleanMessages(list);
  if (!messages) return { ok: false, reason: t('err_send') };
  const catalogue = narrowTo(deps.catalogue, choice);
  if (!catalogue || (choice !== 'free' && !modelOptions(catalogue, keys).length)) return { ok: false, reason: t('err_model') };
  const start = Date.now();
  try {
    const { response, candidate } = await route({ messages, max_tokens: 4096 }, { ...deps, catalogue });
    const text = await response.text();
    if (response.status !== 200) return { ok: false, reason: t('err_said_no', { name: candidate.provider.name, text: text.slice(0, 300) }) };
    const body = JSON.parse(text);
    return {
      ok: true, ms: Date.now() - start,
      text: String(body?.choices?.[0]?.message?.content ?? ''),
      provider: candidate.provider.name, model: candidate.model.id,
      tokens: body?.usage?.total_tokens ?? 0,
    };
  } catch (e) {
    return { ok: false, reason: e instanceof NoCapacityError ? e.message : t('err_generic', { reason: e.message }) };
  } finally {
    saveState(deps.tracker.state);
  }
});
// When another copy holds the port, its requests are in the saved state, not in this process.
ipcMain.handle('app:usage', (_e, days) => usageSummary((srv.reused ? loadState() : deps.tracker.state).usage, [1, 7, 30, 90].includes(days) ? days : 7, deps.catalogue));
ipcMain.handle('app:login', (_e, on) => { app.setLoginItemSettings({ openAtLogin: on === true }); refresh(); return app.getLoginItemSettings().openAtLogin; });
ipcMain.handle('app:updates', async () => {
  try {
    const r = await fetch('https://api.github.com/repos/timchosen/freeaitokens/releases/latest', { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    return { ok: true, latest: String(j.tag_name ?? ''), newer: newerVersion(app.getVersion(), String(j.tag_name ?? '')) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});
// Links in answers and the download page open in the browser; only web addresses.
ipcMain.handle('app:open', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url); });
ipcMain.handle('app:launch', async (_e, tool) => {
  if (!Object.hasOwn(LAUNCH_TOOLS, tool)) return { ok: false, reason: 'unknown tool' };
  try {
    const dir = stateDir();
    const spec = launchSpec(tool, srv.port, localToken(), [], dir);
    for (const [f, text] of Object.entries(spec.files ?? {})) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
    const { ext, text } = launchFile(tool, LAUNCH_TOOLS[tool], spec, process.platform);
    const file = join(dir, `open-${tool}${ext}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, { mode: 0o700 });
    await openTerminal(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});
// Both windows ask for their strings; Settings changes the language and reloads them.
ipcMain.handle('strings', () => ({
  lang: locale.lang, dir: locale.dir, strings,
  languages: LOCALES.map(({ code, name }) => ({ code, name })), chosen: readSettings().lang ?? 'system',
}));
ipcMain.handle('app:lang', (_e, code) => {
  if (code !== 'system' && !LOCALES.some((l) => l.code === code)) return;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), lang: code }));
  loadLang();
  refresh();
  addWindow?.setTitle(t('add_title'));
  for (const w of [mainWindow, addWindow]) w?.webContents.reload();
});
ipcMain.handle('app:copy', (_e, what) => { if (what === 'endpoint') clipboard.writeText(endpoint()); else if (what === 'token') clipboard.writeText(localToken()); });
ipcMain.handle('app:add', (_e, id) => openAdd(id));

function run(cmd, args, opts = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
    p.once('error', fail);
    p.once('spawn', () => { p.unref(); ok(); });
  });
}
async function openTerminal(file) {
  if (process.platform === 'darwin') return run('open', ['-a', 'Terminal', file]);
  if (process.platform === 'win32') return run('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', `"${file}"`], { windowsVerbatimArguments: true });
  for (const [cmd, ...pre] of [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '-e'], ['xterm', '-e']]) {
    try { return await run(cmd, [...pre, file]); } catch { /* try the next terminal */ }
  }
  throw new Error('no terminal app found');
}

app.on('window-all-closed', () => {}); // closing the add window must not quit the tray app
app.on('second-instance', () => openMain());
app.on('activate', () => openMain());
// A second copy quits before it has loaded anything, so there may be nothing to save.
app.on('before-quit', async () => { if (deps) saveState(deps.tracker.state); await srv?.close(); });

app.whenReady().then(async () => {
  app.dock?.hide();
  loadLang();
  keys = openKeyStore();
  deps = makeDeps(currentCatalogue(loadCatalogue()), keys, parseArgs([]));
  void updateCatalogue().then((c) => { if (c) { deps.catalogue = c; refresh(); } });
  const icon = nativeImage.createFromPath(here(process.platform === 'darwin' ? './icons/trayTemplate.png' : './icons/tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('freeaitokens');
  try {
    srv = await startServer(deps, DEFAULT_PORT);
  } catch (e) {
    tray.setContextMenu(Menu.buildFromTemplate([{ label: e.message, enabled: false }, { label: t('quit'), click: () => app.quit() }]));
    return;
  }
  refresh();
  if (process.platform !== 'darwin') tray.on('click', openMain);
  if (!app.getLoginItemSettings().wasOpenedAtLogin) openMain();
});
