// freeaitokens tray app: runs the same local endpoint as the CLI, from the menu bar / system tray.
import { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, nativeImage, shell, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
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
import { routeMedia, NoProviderError } from 'freeaitokens/dist/core/media.js';
import { allowedUrl, choices, menuTemplate, providerRows, cleanMessages, launchFile, modelOptions, narrowTo, newerVersion, usageSummary, pickLang, imageOptions, imageFrom, imageType, privateAddress } from './logic.js';
import './t.js';
import { openChatStore, cleanChat, migrateChats } from './chats.js';
import { createSyncService } from './syncsvc.js';
import * as syncEngine from 'freeaitokens/dist/node/sync/engine.js';
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
  if (v.ok) { keys.set(prov.id, stored); sync?.nudge(); }
  return v;
});
ipcMain.handle('connect', async (_e, id) => {
  const prov = deps.catalogue.find((p) => p.id === id && p.connect === 'openrouter');
  if (!prov) return { ok: false, reason: 'not a connect provider' };
  try {
    keys.set(prov.id, await connectOpenRouter(fetch, (u) => void shell.openExternal(u)));
    sync?.nudge();
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
  images: imageOptions(deps.catalogue, keys),
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
// Playground images: made through the same router as the image API, kept as files in the state folder.
// The window only ever names a file by its random id; bytes are checked to be PNG, JPEG or WebP.
const MAX_IMAGE = 15 * 1024 * 1024;
const IMAGE_FILE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const imagesDir = () => join(stateDir(), 'images');
const dataUrl = (type, bytes) => `data:${MIME[type]};base64,${bytes.toString('base64')}`;
// A provider's image link: https only, every redirect checked by hand, and the connection made only to
// an address that was checked (the check runs inside the connection's own name lookup).
function safeLookup(host, opts, cb) {
  dnsLookup(host, opts, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!list.length || list.some((a) => privateAddress(a.address))) return cb(new Error('image address is not public'));
    return Array.isArray(address) ? cb(null, address) : cb(null, address, family);
  });
}
function getOnce(url) {
  return new Promise((ok, fail) => {
    const req = httpsGet(url, { lookup: safeLookup, timeout: 60_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return ok({ next: new URL(res.headers.location, url).href }); }
      if (res.statusCode !== 200 || Number(res.headers['content-length'] ?? 0) > MAX_IMAGE) { res.resume(); return ok({ bytes: null }); }
      const parts = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_IMAGE) req.destroy(new Error('too big')); else parts.push(c); });
      res.on('end', () => ok({ bytes: Buffer.concat(parts) }));
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', fail);
  });
}
async function download(url) {
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    // A bare IP address skips the name lookup, so it is checked here.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && privateAddress(host)) return null;
    const r = await getOnce(url);
    if (r.next) { url = r.next; continue; }
    return r.bytes;
  }
  return null;
}
ipcMain.handle('app:image', async (_e, prompt, choice = 'free') => {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) return { ok: false, reason: t('err_send') };
  const options = imageOptions(deps.catalogue, keys);
  if (!options.length) return { ok: false, reason: t('no_image_providers') };
  if (choice !== 'free' && !options.some((o) => o.value === choice)) return { ok: false, reason: t('err_model') };
  const start = Date.now();
  try {
    const body = { json: { prompt: prompt.trim(), n: 1, response_format: 'b64_json', ...(choice === 'free' ? {} : { model: choice }) } };
    const { response, candidate } = await routeMedia('image', body, deps);
    const text = await response.text();
    if (response.status !== 200) return { ok: false, reason: t('err_said_no', { name: candidate.provider.name, text: text.slice(0, 300) }) };
    const found = imageFrom(JSON.parse(text));
    const bytes = found?.b64 ? Buffer.from(found.b64, 'base64') : found?.url ? await download(found.url) : null;
    const type = bytes && bytes.length <= MAX_IMAGE ? imageType(bytes) : null;
    if (!type) return { ok: false, reason: t('err_image') };
    const image = `${randomUUID()}.${type}`;
    mkdirSync(imagesDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(imagesDir(), image), bytes, { mode: 0o600 });
    return { ok: true, image, src: dataUrl(type, bytes), ms: Date.now() - start, provider: candidate.provider.name, model: candidate.model.id };
  } catch (e) {
    return { ok: false, reason: e instanceof NoProviderError ? t('no_image_providers') : t('err_generic', { reason: e.message }) };
  } finally {
    saveState(deps.tracker.state);
  }
});
ipcMain.handle('app:imageData', (_e, image) => {
  if (typeof image !== 'string' || !IMAGE_FILE.test(image)) return null;
  try { return dataUrl(image.split('.')[1], readFileSync(join(imagesDir(), image))); } catch { return null; }
});
// The window sends a PNG it drew from the picture: the clipboard cannot take WebP files.
const pngData = (s) => typeof s === 'string' && s.length < MAX_IMAGE * 1.4 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s);
ipcMain.handle('app:copyImage', (_e, png) => { if (pngData(png)) clipboard.writeImage(nativeImage.createFromDataURL(png)); });
// Save a playground image, or a PNG the window drew from an SVG preview, where the person picks.
ipcMain.handle('app:saveImage', async (_e, what) => {
  let bytes, ext;
  if (typeof what?.image === 'string' && IMAGE_FILE.test(what.image)) {
    ext = what.image.split('.')[1];
    try { bytes = readFileSync(join(imagesDir(), what.image)); } catch { return false; }
  } else if (pngData(what?.png)) {
    ext = 'png';
    bytes = Buffer.from(what.png.slice(22), 'base64');
    if (imageType(bytes) !== 'png') return false;
  } else return false;
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: join(app.getPath('downloads'), `freeaitokens-image.${ext}`) });
  if (r.canceled || !r.filePath) return false;
  writeFileSync(r.filePath, bytes);
  return true;
});
ipcMain.handle('app:dropImages', (_e, list) => {
  if (list === 'all') return rmSync(imagesDir(), { recursive: true, force: true });
  for (const image of Array.isArray(list) ? list : []) if (typeof image === 'string' && IMAGE_FILE.test(image)) rmSync(join(imagesDir(), image), { force: true });
});

// Saved chats live in the state folder (not window storage) so sync can reach them.
let chatStore;
const chatsNow = () => (chatStore ??= openChatStore(join(stateDir(), 'chats.json'), syncEngine.mergeChat));
ipcMain.handle('chats:list', () => chatsNow().list());
ipcMain.handle('chats:put', (_e, c) => { const clean = cleanChat(c); if (clean && !clean.deleted) chatsNow().save(clean); return !!clean; });
ipcMain.handle('chats:remove', (_e, id) => { if (typeof id === 'string') chatsNow().remove(id); });
// The chats from window storage, once: ignored when the store already has chats.
ipcMain.handle('chats:migrate', (_e, list) => {
  if (!chatsNow().all().length) for (const c of migrateChats(list)) chatsNow().put(c);
  return chatsNow().list();
});

// Sync: chats and provider keys, end-to-end encrypted, across this person's computers.
const SYNC_BASE = 'https://sync.freeaitokens.co';
let sync;
const send = (ch, v) => mainWindow?.webContents.send(ch, v);
function startSync() {
  sync = createSyncService({
    base: SYNC_BASE, keys, chats: chatsNow(), stateFile: join(stateDir(), 'sync.json'), fetch, engine: syncEngine,
    providers: () => deps.catalogue.filter((p) => !p.keyless).map((p) => p.id),
    onStatus: (s) => send('sync:status', s),
    onPulled: () => { send('chats:changed'); refresh(); },
  });
  sync.start();
}
// Errors the person can act on get their own words; anything else is shown as it is.
const syncError = (e) => ({ ok: false, error:
  e instanceof syncEngine.WrongPassphraseError ? t('sync_wrong_pass')
  : e?.code === 'bad_key' ? t('sync_bad_key')
  : e?.code === 'bad_passphrase' ? t('sync_pass_hint')
  : /recovery code/.test(e?.message ?? '') ? t('sync_bad_code')
  : t('err_generic', { reason: e?.message ?? String(e) }) });
const syncCall = (fn) => async (_e, ...a) => { try { return { ok: true, ...(await fn(...a)) }; } catch (e) { return syncError(e); } };
ipcMain.handle('sync:status', () => sync.status());
ipcMain.handle('sync:buy', syncCall(async (plan) => { await shell.openExternal(await sync.buy(plan === 'life' ? 'life' : 'year')); }));
ipcMain.handle('sync:cancel', () => sync.cancelClaim());
ipcMain.handle('sync:setup', syncCall((key, pass, confirmed) => sync.setup(key, pass, confirmed !== false)));
ipcMain.handle('sync:now', syncCall(async () => { const r = await sync.syncNow(); return r.ok ? {} : { result: r }; }));
ipcMain.handle('sync:recovery', () => sync.recovery());
ipcMain.handle('sync:pass', syncCall((pass) => sync.changePassphrase(pass)));
ipcMain.handle('sync:recover', syncCall((code, pass, key) => sync.recover(code, pass, typeof key === 'string' && key ? key.trim().toUpperCase() : undefined)));
ipcMain.handle('sync:billing', syncCall(async () => { await shell.openExternal(await sync.billingUrl()); }));
ipcMain.handle('sync:off', () => sync.turnOff());

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
app.on('before-quit', async () => { sync?.stop(); if (deps) saveState(deps.tracker.state); await srv?.close(); });

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
  startSync();
  if (process.platform !== 'darwin') tray.on('click', openMain);
  if (!app.getLoginItemSettings().wasOpenedAtLogin) openMain();
});
