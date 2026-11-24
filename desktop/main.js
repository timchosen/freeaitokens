// freeaitokens tray app: runs the same local endpoint as the CLI, from the menu bar / system tray.
import { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, ClipboardItem, nativeImage, nativeTheme, shell, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
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
import { allowedUrl, choices, menuTemplate, providerRows, cleanMessages, launchFile, modelOptions, narrowTo, newerVersion, usageSummary, pickLang, imageOptions, imageFrom, imageType, privateAddress, mediaOptions, guessKind, sortedKind, audioType, pcmToWav, pickRelease, docMessage, joinUsers } from './logic.js';
import { docText } from './docs.js';
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
// Light, dark, or follow the computer: the windows' colours follow nativeTheme.
const THEMES = ['system', 'light', 'dark'];
const applyTheme = () => { const th = readSettings().theme; nativeTheme.themeSource = THEMES.includes(th) ? th : 'system'; };
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
  speech: mediaOptions(deps.catalogue, keys, 'speech').length > 0,
  transcription: mediaOptions(deps.catalogue, keys, 'transcription').length > 0,
  version: app.getVersion(),
  startAtLogin: app.getLoginItemSettings().openAtLogin,
  theme: nativeTheme.themeSource,
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
    const { response, candidate } = await route({ messages: joinUsers(messages), max_tokens: 4096 }, { ...deps, catalogue });
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
    // Pre-releases are offered first to people with an active sync plan (early access), then to everyone once marked latest.
    const early = sync?.status().state === 'on';
    const r = await fetch('https://api.github.com/repos/timchosen/freeaitokens/releases?per_page=20', { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    const rel = pickRelease(await r.json(), app.getVersion(), early);
    const url = rel?.url.startsWith('https://github.com/timchosen/freeaitokens/releases/') ? rel.url : undefined;
    return { ok: true, latest: rel?.tag ?? '', newer: !!rel, early: !!rel?.early, url };
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
ipcMain.handle('app:copyImage', async (_e, png) => {
  if (!pngData(png)) return false;
  const blob = new Blob([Buffer.from(png.slice(png.indexOf(',') + 1), 'base64')], { type: 'image/png' });
  await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return true;
});
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
  if (list === 'all') { rmSync(imagesDir(), { recursive: true, force: true }); rmSync(audioDir(), { recursive: true, force: true }); return; }
  for (const f of Array.isArray(list) ? list : []) {
    if (typeof f !== 'string') continue;
    if (IMAGE_FILE.test(f)) rmSync(join(imagesDir(), f), { force: true });
    else if (AUDIO_FILE.test(f)) rmSync(join(audioDir(), f), { force: true });
  }
});

// Auto mode: a free chat model sorts the message; when it cannot (no model, out of requests, too slow,
// an answer that is not one word), the word rules in logic.js decide.
const SORT_PROMPT = 'Sort the user\'s message. Reply with exactly one word: image if they want a picture made, speech if they want audio (words said, read or spoken out loud), chat for anything else.';
ipcMain.handle('app:sort', async (_e, text) => {
  if (typeof text !== 'string' || !text.trim()) return { kind: 'chat', by: 'rules' };
  const rules = { kind: guessKind(text), by: 'rules' };
  let timer;
  try {
    const ask = (async () => {
      const { response } = await route({ messages: [{ role: 'system', content: SORT_PROMPT }, { role: 'user', content: text.slice(0, 2000) }], max_tokens: 512, temperature: 0 /* thinking models spend tokens before answering */ }, deps);
      if (response.status !== 200) return null;
      return sortedKind((await response.json())?.choices?.[0]?.message?.content);
    })();
    const kind = await Promise.race([ask, new Promise((r) => { timer = setTimeout(() => r(null), 5000); })]);
    return kind ? { kind, by: 'model' } : rules;
  } catch {
    return rules;
  } finally {
    clearTimeout(timer);
    saveState(deps.tracker.state);
  }
});

// Speech made in the playground is kept like images: a file with a random id in the state folder.
const MAX_AUDIO = 25 * 1024 * 1024;
const AUDIO_FILE = /^[0-9a-f-]{36}\.(mp3|wav|ogg|flac|m4a|webm)$/;
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', webm: 'audio/webm' };
const audioDir = () => join(stateDir(), 'audio');
const audioUrl = (type, bytes) => `data:${AUDIO_MIME[type]};base64,${bytes.toString('base64')}`;
// A request like "read a short poem about rain" first has a chat model write the words to speak;
// if that fails, the request itself is spoken.
const SAY_PROMPT = 'Write only the exact words that should be spoken aloud for this request: no notes, no markdown, no quotes around them.';
async function wordsToSay(request) {
  try {
    const { response } = await route({ messages: [{ role: 'system', content: SAY_PROMPT }, { role: 'user', content: request }], max_tokens: 2048 }, deps);
    if (response.status !== 200) return request;
    const words = String((await response.json())?.choices?.[0]?.message?.content ?? '').trim();
    return words && words.length <= 4000 ? words : request;
  } catch { return request; }
}
ipcMain.handle('app:speech', async (_e, text, write = false) => {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return { ok: false, reason: t('err_send') };
  if (!mediaOptions(deps.catalogue, keys, 'speech').length) return { ok: false, reason: t('no_speech_providers') };
  const start = Date.now();
  try {
    const words = write === true ? await wordsToSay(text.trim()) : text.trim();
    const { response, candidate } = await routeMedia('speech', { json: { input: words } }, deps);
    if (response.status !== 200) return { ok: false, reason: t('err_said_no', { name: candidate.provider.name, text: (await response.text()).slice(0, 300) }) };
    const bytes = Buffer.from(pcmToWav(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type')));
    const type = bytes.length <= MAX_AUDIO ? audioType(bytes) : null;
    if (!type) return { ok: false, reason: t('err_speech') };
    const audio = `${randomUUID()}.${type}`;
    mkdirSync(audioDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(audioDir(), audio), bytes, { mode: 0o600 });
    return { ok: true, audio, src: audioUrl(type, bytes), text: write === true ? words : '', ms: Date.now() - start, provider: candidate.provider.name, model: candidate.model.id };
  } catch (e) {
    return { ok: false, reason: e instanceof NoProviderError ? t('no_speech_providers') : t('err_generic', { reason: e.message }) };
  } finally {
    saveState(deps.tracker.state);
  }
});
ipcMain.handle('app:audioData', (_e, audio) => {
  if (typeof audio !== 'string' || !AUDIO_FILE.test(audio)) return null;
  try { return audioUrl(audio.split('.')[1], readFileSync(join(audioDir(), audio))); } catch { return null; }
});
ipcMain.handle('app:saveAudio', async (_e, audio) => {
  if (typeof audio !== 'string' || !AUDIO_FILE.test(audio)) return false;
  let bytes;
  try { bytes = readFileSync(join(audioDir(), audio)); } catch { return false; }
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: join(app.getPath('downloads'), `freeaitokens-speech.${audio.split('.')[1]}`) });
  if (r.canceled || !r.filePath) return false;
  writeFileSync(r.filePath, bytes);
  return true;
});
// Transcription: the person picks an audio file here, in the main process; the window never sends a path.
// The file goes to the router on this computer and is not kept.
// Attach: the person picks a file here, in the main process; the window never sends a path.
// Audio is transcribed; a text, data, code or Word file becomes a message the model reads with the next question.
const DOC_TYPES = ['pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'yaml', 'yml', 'toml', 'ini', 'log', 'rtf', 'tex', 'docx',
  'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'sql', 'css'];
const MAX_DOC = 20 * 1024 * 1024;
ipcMain.handle('app:attach', async () => {
  const pick = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [
    { name: t('attach_file'), extensions: [...DOC_TYPES, ...Object.keys(AUDIO_MIME)] }, { name: t('all_files'), extensions: ['*'] }] });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
  const path = pick.filePaths[0], name = path.split(/[\\/]/).pop();
  let bytes;
  try {
    if (statSync(path).size > Math.max(MAX_AUDIO, MAX_DOC)) return { ok: false, reason: t('file_too_big'), name };
    bytes = readFileSync(path);
  } catch (e) { return { ok: false, reason: t('err_generic', { reason: e.message }), name }; }
  const type = audioType(bytes);
  if (!type) {
    let doc = null;
    try { doc = await docText(bytes, name); } catch { /* a damaged file reads as unreadable */ }
    if (doc?.empty) return { ok: false, reason: t('doc_empty'), name };
    return doc ? { ok: true, kind: 'doc', name, content: docMessage(name, doc.text), cut: doc.cut } : { ok: false, reason: t('err_file'), name };
  }
  if (bytes.length > MAX_AUDIO) return { ok: false, reason: t('audio_too_big'), name };
  if (!mediaOptions(deps.catalogue, keys, 'transcription').length) return { ok: false, reason: t('no_transcription_providers'), name };
  const start = Date.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: AUDIO_MIME[type] }), `audio.${type}`);
    const { response, candidate } = await routeMedia('transcription', { form }, deps);
    const raw = await response.text();
    if (response.status !== 200) return { ok: false, reason: t('err_said_no', { name: candidate.provider.name, text: raw.slice(0, 300) }), name };
    let text = raw;
    try { text = String(JSON.parse(raw)?.text ?? ''); } catch { /* plain text answer */ }
    return { ok: true, kind: 'audio', text: text.trim(), name, ms: Date.now() - start, provider: candidate.provider.name, model: candidate.model.id };
  } catch (e) {
    return { ok: false, reason: e instanceof NoProviderError ? t('no_transcription_providers') : t('err_generic', { reason: e.message }), name };
  } finally {
    saveState(deps.tracker.state);
  }
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
// The key goes straight to the clipboard; the window never holds it.
ipcMain.handle('sync:copyKey', () => { const k = sync.key(); if (k) clipboard.writeText(k); return !!k; });
ipcMain.handle('sync:pass', syncCall((pass) => sync.changePassphrase(pass)));
ipcMain.handle('sync:recover', syncCall((code, pass, key) => sync.recover(code, pass, typeof key === 'string' && key ? key.trim().toUpperCase() : undefined)));
ipcMain.handle('sync:billing', syncCall(async () => { await shell.openExternal(await sync.billingUrl()); }));
ipcMain.handle('sync:off', () => sync.turnOff());

// Both windows ask for their strings; Settings changes the language and reloads them.
ipcMain.handle('strings', () => ({
  lang: locale.lang, dir: locale.dir, strings,
  languages: LOCALES.map(({ code, name }) => ({ code, name })), chosen: readSettings().lang ?? 'system',
}));
ipcMain.handle('app:theme', (_e, theme) => {
  if (!THEMES.includes(theme)) return nativeTheme.themeSource;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), theme }));
  applyTheme();
  return theme;
});
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
  applyTheme();
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
