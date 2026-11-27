#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseCatalogue, type Provider } from '../core/catalogue.js';
import { LimitTracker } from '../core/limits.js';
import type { RouteDeps } from '../core/orchestrator.js';
import { startServer, keepServing, DEFAULT_PORT, type ServerHandle } from './server.js';
import { loadState, saveState, localToken, stateDir } from './state.js';
import { openKeyStore, type KeyStore } from './keys.js';
import { runAdd, runList, runRemove } from './add.js';
import { launchSpec, setupFile, undoSetup, manualSetup, LAUNCH_TOOLS, MANUAL_TOOLS, type LaunchTool } from './harness.js';
import { currentCatalogue, updateCatalogue } from './remote.js';

export const HELP = `freeaitokens: free AI from many providers' free tiers, on one local endpoint.

Usage:
  freeaitokens                 Start the local endpoint and keep it running
  freeaitokens add             Add a free provider key (guided)
  freeaitokens list            Show providers, key status and what is left today
  freeaitokens remove <id>     Delete a stored key
  freeaitokens <tool> [args]   Run a tool on free models, this session only:
                               claude, codex, gemini, kilo, qwen, goose, aider
  freeaitokens setup opencode  Add freeaitokens to OpenCode's config (--undo restores it)
  freeaitokens setup <tool>    Print settings for zed, jetbrains, vscode, continue, cline, crush, roo

Options:
  --port <n>       Port for the local endpoint (default ${DEFAULT_PORT})
  --free-only      Never use paid keys
  --use <provider> With a tool: keep to one provider, or provider/model (see \`freeaitokens list\`).
                   There is no switching when it runs out.
  --paid-cap <n>   Most paid requests per day (default 200)
  -h, --help       Show this help

Rules: use your own keys, one account per provider, and never share the endpoint.`;

const LAUNCHERS = new Set(Object.keys(LAUNCH_TOOLS));
const COMMANDS = new Set(['serve', 'add', 'list', 'remove', 'setup', ...LAUNCHERS]);

export interface Args { command: string; rest: string[]; port: number; freeOnly: boolean; paidCap: number; help?: boolean; undo?: boolean; use?: string }

export function parseArgs(argv: string[]): Args {
  const a: Args = { command: 'serve', rest: [], port: DEFAULT_PORT, freeOnly: false, paidCap: 200 };
  let command: string | undefined;
  const num = (flag: string, v: string | undefined) => {
    const n = Number(v);
    if (!v || !Number.isInteger(n) || n < 0) throw new Error(`${flag} needs a whole number.`);
    return n;
  };
  let passThrough = false;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    // After a launcher such as `claude`, our flags are read until the first argument that is not ours; the rest belongs to the tool.
    if (passThrough) { a.rest.push(x); continue; }
    const ours = ['--port', '--paid-cap', '--free-only', '--use', '--undo', '-h', '--help'].includes(x);
    if (command && LAUNCHERS.has(command) && !ours) { passThrough = true; a.rest.push(x); continue; }
    if (x === '--port') a.port = num('--port', argv[++i]);
    else if (x === '--paid-cap') a.paidCap = num('--paid-cap', argv[++i]);
    else if (x === '--free-only') a.freeOnly = true;
    else if (x === '--use') { const v = argv[++i]; if (!v || v.startsWith('-')) throw new Error('--use needs a provider, such as --use groq.'); a.use = v; }
    else if (x === '--undo') a.undo = true;
    else if (x === '-h' || x === '--help') a.help = true;
    else if (!command) command = x;
    else a.rest.push(x);
  }
  a.command = command ?? 'serve';
  if (!a.help) delete a.help;
  if (!a.undo) delete a.undo;
  return a;
}

export function banner(port: number, token: string, s: { keyless: number; keyed: number; backend: string }): string {
  const lines: string[] = [];
  if (s.keyless + s.keyed === 0) lines.push('No providers are usable yet.', 'Run `freeaitokens add` in another terminal to add a free key.');
  else lines.push('freeaitokens is running.');
  lines.push(
    `  Endpoint:  http://127.0.0.1:${port}/v1`,
    `  Token:     ${token}`,
    `  Providers: ${s.keyless} need no key, ${s.keyed} use your keys (${s.backend === 'file' ? 'stored in a file' : 'system keychain'})`,
  );
  if (s.keyless + s.keyed > 0 && s.keyed === 0) lines.push('Next: run `freeaitokens add` to add a free key. Coding sessions need more than the no-key providers allow.');
  lines.push('Use it: freeaitokens claude | codex | gemini | qwen | setup opencode  (more: freeaitokens --help)', 'Stop with Ctrl+C.');
  return lines.join('\n');
}

export function loadCatalogue(): Provider[] {
  return parseCatalogue(JSON.parse(readFileSync(new URL('../catalogue.json', import.meta.url), 'utf8')));
}

export function makeDeps(catalogue: Provider[], keys: KeyStore, a: Args): RouteDeps {
  return {
    catalogue,
    keys: (id) => keys.get(id),
    tracker: new LimitTracker(loadState()),
    fetch,
    opts: { freeOnly: a.freeOnly, paidCap: a.paidCap },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onPaid: (c) => process.stderr.write(`paid: ${c.key}\n`),
  };
}

// Why `--use <name>` can't work, or null when it can.
export function checkUse(catalogue: Provider[], key: (id: string) => string | null | undefined, use: string): string | null {
  const i = use.indexOf('/');
  const p = catalogue.find((x) => x.id === (i < 0 ? use : use.slice(0, i)));
  if (!p) return `No provider "${i < 0 ? use : use.slice(0, i)}". Providers: ${catalogue.map((x) => x.id).join(', ')}.`;
  if (i >= 0 && !p.models.some((m) => m.id === use.slice(i + 1))) return `${p.name} has no free model "${use.slice(i + 1)}". Its models: ${p.models.map((m) => m.id).join(', ')}.`;
  if (!p.keyless && !key(p.id)) return `${p.name} needs a key first. Run \`freeaitokens add\`.`;
  return null;
}

const fail = (msg: string): never => { process.stderr.write(msg + '\n'); process.exit(1); };

async function launch(tool: LaunchTool, a: Args, deps: RouteDeps): Promise<never> {
  const srv: ServerHandle = await startServer(deps, a.port);
  const spec = launchSpec(tool, srv.port, localToken(), a.rest, stateDir(), a.use ?? 'free');
  for (const [f, text] of Object.entries(spec.files ?? {})) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
  const child = spawn(spec.cmd, spec.args, { stdio: 'inherit', env: { ...process.env, ...spec.env } });
  // A reused endpoint belongs to another session: take it over if that session ends first, and leave its state alone.
  const follow = srv.reused ? keepServing(deps, srv.port) : null;
  const done = async (code: number) => {
    if (!follow || follow.owns()) saveState(deps.tracker.state);
    await srv.close(); await follow?.stop();
    process.exit(code);
  };
  child.on('error', (e: any) => {
    const name = LAUNCH_TOOLS[tool];
    process.stderr.write(e?.code === 'ENOENT' ? `${name} is not installed or not on your PATH (looked for "${spec.cmd}").\n` : `Could not start ${name}: ${e.message}\n`);
    void done(1);
  });
  child.on('exit', (code, signal) => void done(code ?? (signal ? 1 : 0)));
  process.on('SIGINT', () => {}); // the tool handles Ctrl+C itself
  return new Promise<never>(() => {});
}

export async function main(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  if (a.help) { process.stdout.write(HELP + '\n'); return; }
  if (!COMMANDS.has(a.command)) fail(`Unknown command "${a.command}". Run \`freeaitokens --help\` to see the commands.`);
  let catalogue = currentCatalogue(loadCatalogue());
  const update = updateCatalogue();
  const keys = openKeyStore();
  // Commands that show providers wait briefly for a newer list; the endpoint swaps it in when it arrives.
  if (['add', 'list', 'remove'].includes(a.command)) catalogue = (await update) ?? catalogue;

  switch (a.command) {
    case 'add': return runAdd(catalogue, keys, fetch);
    case 'list': process.stdout.write(runList(catalogue, keys, new LimitTracker(loadState())) + '\n'); return;
    case 'remove': {
      const id = a.rest[0];
      if (!id) fail('Say which provider, for example: freeaitokens remove groq');
      if (!catalogue.some((p) => p.id === id)) fail(`No provider called "${id}". Run \`freeaitokens list\` to see them.`);
      runRemove(id, keys);
      process.stdout.write(`Removed the ${id} key.\n`);
      return;
    }
    case 'setup': {
      const tool = a.rest[0];
      if (tool === 'opencode') {
        if (a.undo) { undoSetup('opencode'); process.stdout.write('Restored your OpenCode config.\n'); return; }
        const { backup } = setupFile('opencode', a.port, localToken());
        process.stdout.write(`Added "freeaitokens" as a provider in OpenCode (pick the model "freeaitokens/free").\nBackup: ${backup}\nUndo: freeaitokens setup opencode --undo\nKeep \`freeaitokens\` running while you use it.\n`);
        return;
      }
      if (MANUAL_TOOLS.includes(tool) || tool === 'aider') { process.stdout.write(manualSetup(tool, a.port, localToken()) + '\n'); return; }
      return fail(`Unknown tool "${tool ?? ''}". Supported: opencode, ${MANUAL_TOOLS.join(', ')}. To run a tool on free models directly: freeaitokens ${[...LAUNCHERS].join(' | ')}.`);
    }
    default: {
      if (LAUNCHERS.has(a.command)) {
        const wrong = a.use ? checkUse(catalogue, (id) => keys.get(id), a.use) : null;
        if (wrong) return fail(wrong);
        const deps = makeDeps(catalogue, keys, a);
        void update.then((c) => { if (c) deps.catalogue = c; });
        return launch(a.command as LaunchTool, a, deps);
      }
      const deps = makeDeps(catalogue, keys, a);
      void update.then((c) => { if (c) deps.catalogue = c; });
      const srv = await startServer(deps, a.port);
      if (srv.reused) { process.stdout.write(`freeaitokens is already running on port ${srv.port}.\n`); return; }
      const keyed = catalogue.filter((p) => !p.keyless && keys.get(p.id)).length;
      process.stdout.write(banner(srv.port, localToken(), { keyless: catalogue.filter((p) => p.keyless).length, keyed, backend: keys.backend }) + '\n');
      process.on('SIGINT', async () => { saveState(deps.tracker.state); await srv.close(); process.exit(0); });
    }
  }
}

// Imported (by the desktop app) rather than run: argv[1] may be missing or not a file.
const invoked = (() => { try { return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; } })();
if (invoked) main(process.argv.slice(2)).catch((e) => fail((e as Error).message));
