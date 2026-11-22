#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseCatalogue, type Provider } from '../core/catalogue.js';
import { LimitTracker } from '../core/limits.js';
import type { RouteDeps } from '../core/orchestrator.js';
import { startServer, keepServing, DEFAULT_PORT, type ServerHandle } from './server.js';
import { loadState, saveState, localToken } from './state.js';
import { openKeyStore, type KeyStore } from './keys.js';
import { runAdd, runList, runRemove } from './add.js';
import { launchSpec, setupFile, undoSetup, manualSetup } from './harness.js';

export const HELP = `freeaitokens: free AI models for your coding tools, on one local endpoint.

Usage:
  freeaitokens                 Start the local endpoint and keep it running
  freeaitokens add             Add a free provider key (guided)
  freeaitokens list            Show providers, key status and what is left today
  freeaitokens remove <id>     Delete a stored key
  freeaitokens claude [args]   Run Claude Code on free models (this session only)
  freeaitokens codex [args]    Run Codex on free models (this session only)
  freeaitokens setup <tool>    Add freeaitokens to opencode, or print settings for cline, aider, continue
  freeaitokens setup <tool> --undo   Restore the tool's config from the backup

Options:
  --port <n>       Port for the local endpoint (default ${DEFAULT_PORT})
  --free-only      Never use paid keys
  --paid-cap <n>   Most paid requests per day (default 200)
  -h, --help       Show this help

Rules: use your own keys, one account per provider, and never share the endpoint.`;

const COMMANDS = new Set(['serve', 'add', 'list', 'remove', 'claude', 'codex', 'setup']);
const LAUNCHERS = new Set(['claude', 'codex']);

export interface Args { command: string; rest: string[]; port: number; freeOnly: boolean; paidCap: number; help?: boolean; undo?: boolean }

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
    // After `claude`/`codex`, our flags are read until the first argument that is not ours; the rest belongs to the tool.
    if (passThrough) { a.rest.push(x); continue; }
    const ours = ['--port', '--paid-cap', '--free-only', '--undo', '-h', '--help'].includes(x);
    if (command && LAUNCHERS.has(command) && !ours) { passThrough = true; a.rest.push(x); continue; }
    if (x === '--port') a.port = num('--port', argv[++i]);
    else if (x === '--paid-cap') a.paidCap = num('--paid-cap', argv[++i]);
    else if (x === '--free-only') a.freeOnly = true;
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
  lines.push('Use it: freeaitokens claude | freeaitokens codex | freeaitokens setup opencode', 'Stop with Ctrl+C.');
  return lines.join('\n');
}

function loadCatalogue(): Provider[] {
  return parseCatalogue(JSON.parse(readFileSync(new URL('../catalogue.json', import.meta.url), 'utf8')));
}

function makeDeps(catalogue: Provider[], keys: KeyStore, a: Args): RouteDeps {
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

const fail = (msg: string): never => { process.stderr.write(msg + '\n'); process.exit(1); };

async function launch(tool: 'claude' | 'codex', a: Args, deps: RouteDeps): Promise<never> {
  const srv: ServerHandle = await startServer(deps, a.port);
  const spec = launchSpec(tool, srv.port, localToken(), a.rest);
  const child = spawn(spec.cmd, spec.args, { stdio: 'inherit', env: { ...process.env, ...spec.env } });
  // A reused endpoint belongs to another session: take it over if that session ends first, and leave its state alone.
  const follow = srv.reused ? keepServing(deps, srv.port) : null;
  const done = async (code: number) => {
    if (!follow || follow.owns()) saveState(deps.tracker.state);
    await srv.close(); await follow?.stop();
    process.exit(code);
  };
  child.on('error', (e: any) => {
    const name = tool === 'claude' ? 'Claude Code' : 'Codex';
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
  const catalogue = loadCatalogue();
  const keys = openKeyStore();

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
      if (tool === 'cline' || tool === 'aider' || tool === 'continue') { process.stdout.write(manualSetup(tool, a.port, localToken()) + '\n'); return; }
      return fail(`Unknown tool "${tool ?? ''}". Supported: opencode, cline, aider, continue. For Claude Code and Codex use \`freeaitokens claude\` or \`freeaitokens codex\`.`);
    }
    case 'claude':
    case 'codex':
      return launch(a.command, a, makeDeps(catalogue, keys, a));
    default: {
      const deps = makeDeps(catalogue, keys, a);
      const srv = await startServer(deps, a.port);
      if (srv.reused) { process.stdout.write(`freeaitokens is already running on port ${srv.port}.\n`); return; }
      const keyed = catalogue.filter((p) => !p.keyless && keys.get(p.id)).length;
      process.stdout.write(banner(srv.port, localToken(), { keyless: catalogue.filter((p) => p.keyless).length, keyed, backend: keys.backend }) + '\n');
      process.on('SIGINT', async () => { saveState(deps.tracker.state); await srv.close(); process.exit(0); });
    }
  }
}

const invoked = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (invoked) main(process.argv.slice(2)).catch((e) => fail((e as Error).message));
