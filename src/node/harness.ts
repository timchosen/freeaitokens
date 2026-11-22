import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export type LaunchTool = 'claude' | 'codex';
export type FileTool = 'opencode';

// Launchers point a tool at the local endpoint for one session; the user's own config is untouched.
export function launchSpec(tool: LaunchTool, port: number, token: string, args: string[]): { cmd: string; args: string[]; env: Record<string, string> } {
  const base = `http://127.0.0.1:${port}`;
  if (tool === 'claude') {
    // Empty ANTHROPIC_API_KEY so a real key in the user's shell is never sent to the local endpoint.
    return { cmd: 'claude', args, env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '' } };
  }
  const c = (kv: string) => ['-c', kv];
  return {
    cmd: 'codex',
    args: [
      ...c('model_providers.freetokens.name="freetokens"'),
      ...c(`model_providers.freetokens.base_url="${base}/v1"`),
      ...c('model_providers.freetokens.wire_api="responses"'),
      ...c('model_providers.freetokens.env_key="FREETOKENS_TOKEN"'),
      ...c('model_provider="freetokens"'),
      ...c('model="free"'),
      ...args,
    ],
    env: { FREETOKENS_TOKEN: token },
  };
}

export function defaultConfigPath(_tool: FileTool): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode.json');
}

const backupOf = (f: string) => f + '.freetokens-backup';
const createdMarkerOf = (f: string) => f + '.freetokens-created';

// Adds the local endpoint as an extra selectable provider; the user's default model stays theirs.
export function setupFile(tool: FileTool, port: number, token: string, configPath = defaultConfigPath(tool)): { backup: string } {
  const backup = backupOf(configPath);
  const exists = existsSync(configPath);
  let config: any = {};
  if (exists) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {
      throw new Error(`${configPath} is not valid JSON (comments are not supported), so it was left unchanged. Add the provider by hand: base URL http://127.0.0.1:${port}/v1, model "free".`);
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error(`${configPath} is not a JSON object, so it was left unchanged.`);
  }
  // Keep the first backup: it is the user's real original.
  if (!existsSync(backup) && !existsSync(createdMarkerOf(configPath))) {
    if (exists) copyFileSync(configPath, backup);
    else { mkdirSync(dirname(configPath), { recursive: true }); writeFileSync(createdMarkerOf(configPath), ''); }
  }
  config.$schema ??= 'https://opencode.ai/config.json';
  config.provider = { ...(config.provider ?? {}), freetokens: {
    npm: '@ai-sdk/openai-compatible',
    name: 'freetokens (free models)',
    options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: token },
    models: { free: { name: 'Best free model', limit: { context: 262144, output: 32768 } } },
  } };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return { backup };
}

export function undoSetup(tool: FileTool, configPath = defaultConfigPath(tool)): void {
  const backup = backupOf(configPath);
  const marker = createdMarkerOf(configPath);
  if (existsSync(backup)) { copyFileSync(backup, configPath); rmSync(backup); return; }
  if (existsSync(marker)) { rmSync(configPath, { force: true }); rmSync(marker); return; }
  throw new Error(`Nothing to undo: no freetokens backup next to ${configPath}.`);
}

// Tools with no safe automatic setup: print what to paste.
export function manualSetup(tool: string, port: number, token: string): string {
  return [
    `Set up ${tool} with an OpenAI-compatible provider:`,
    `  Base URL: http://127.0.0.1:${port}/v1`,
    `  API key:  ${token}`,
    `  Model:    free`,
    `Keep \`freetokens\` running in a terminal while you use it.`,
  ].join('\n');
}
