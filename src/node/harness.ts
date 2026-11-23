import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const LAUNCH_TOOLS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', goose: 'Goose', qwen: 'Qwen Code', kilo: 'Kilo Code', aider: 'Aider' } as const;
export type LaunchTool = keyof typeof LAUNCH_TOOLS;
export interface LaunchSpec { cmd: string; args: string[]; env: Record<string, string>; files?: Record<string, string> }

// Kilo (an OpenCode fork) reads an inline config layer from an env var, so nothing is written to disk.
// OpenCode 2.x no longer reads that layer, so OpenCode uses `setup opencode` instead.
const inlineConfig = (base: string) => JSON.stringify({
  model: 'freeaitokens/free',
  provider: { freeaitokens: {
    npm: '@ai-sdk/openai-compatible', name: 'freeaitokens (free models)',
    options: { baseURL: `${base}/v1`, apiKey: '{env:FREEAITOKENS_TOKEN}' },
    models: { free: { name: 'Best free model', tool_call: true, limit: { context: 262144, output: 32768 } } },
  } },
});
export type FileTool = 'opencode';

// Launchers point a tool at the local endpoint for one session; the user's own config is untouched.
export function launchSpec(tool: LaunchTool, port: number, token: string, args: string[], stateDir = ''): LaunchSpec {
  const base = `http://127.0.0.1:${port}`;
  switch (tool) {
    case 'gemini': {
      // System settings override the user's saved login choice without editing their files.
      const settings = join(stateDir, 'gemini-system-settings.json');
      return {
        cmd: 'gemini', args,
        env: { GOOGLE_GEMINI_BASE_URL: base, GEMINI_API_KEY: token, GEMINI_MODEL: 'free', GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings },
        files: { [settings]: JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, model: { name: 'free' } }, null, 2) + '\n' },
      };
    }
    case 'goose':
      return { cmd: 'goose', args: ['session', ...args], env: { GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'free', OPENAI_HOST: base, OPENAI_BASE_PATH: 'v1/chat/completions', OPENAI_API_KEY: token } };
    case 'qwen':
      return { cmd: 'qwen', args: ['--auth-type', 'openai', '--openai-base-url', `${base}/v1`, '-m', 'free', ...args], env: { OPENAI_API_KEY: token } };
    case 'aider':
      return { cmd: 'aider', args: ['--model', 'openai/free', '--no-show-model-warnings', ...args], env: { OPENAI_API_BASE: `${base}/v1`, OPENAI_API_KEY: token } };
    case 'kilo':
      return { cmd: 'kilo', args, env: { KILO_CONFIG_CONTENT: inlineConfig(base), FREEAITOKENS_TOKEN: token } };
  }
  if (tool === 'claude') {
    // Empty ANTHROPIC_API_KEY so a real key in the user's shell is never sent to the local endpoint.
    return { cmd: 'claude', args, env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '' } };
  }
  const c = (kv: string) => ['-c', kv];
  return {
    cmd: 'codex',
    args: [
      ...c('model_providers.freeaitokens.name="freeaitokens"'),
      ...c(`model_providers.freeaitokens.base_url="${base}/v1"`),
      ...c('model_providers.freeaitokens.wire_api="responses"'),
      ...c('model_providers.freeaitokens.env_key="FREEAITOKENS_TOKEN"'),
      ...c('model_provider="freeaitokens"'),
      ...c('model="free"'),
      ...args,
    ],
    env: { FREEAITOKENS_TOKEN: token },
  };
}

export function defaultConfigPath(_tool: FileTool): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode.json');
}

const backupOf = (f: string) => f + '.freeaitokens-backup';
const createdMarkerOf = (f: string) => f + '.freeaitokens-created';

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
  config.provider = { ...(config.provider ?? {}), freeaitokens: {
    npm: '@ai-sdk/openai-compatible',
    name: 'freeaitokens (free models)',
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
  throw new Error(`Nothing to undo: no freeaitokens backup next to ${configPath}.`);
}

export const MANUAL_TOOLS = ['zed', 'jetbrains', 'vscode', 'continue', 'cline', 'crush', 'roo', 'cursor'];

// Tools with no safe automatic setup: print what to paste.
export function manualSetup(tool: string, port: number, token: string): string {
  const v1 = `http://127.0.0.1:${port}/v1`;
  const keep = 'Keep `freeaitokens` (or the tray app) running while you use it.';
  if (tool === 'cursor') return 'Cursor sends custom-endpoint requests through Cursor\'s servers, which cannot reach a local address, so it cannot use freeaitokens.';
  if (tool === 'zed') return [
    'Add this to Zed\'s settings (Zed: Open Settings), inside the top-level object:',
    `  "language_models": { "openai_compatible": { "freeaitokens": { "api_url": "${v1}",`,
    '    "available_models": [{ "name": "free", "display_name": "Best free model", "max_tokens": 262144 }] } } }',
    `Then in Agent Settings, under LLM Providers, give freeaitokens this API key: ${token}`, keep,
  ].join('\n');
  if (tool === 'jetbrains') return [
    'In Settings | Tools | AI Assistant | Providers & API keys, add an OpenAI-compatible provider:',
    `  URL:     ${v1}`, `  API key: ${token}`, '  Turn on tool calling, then Test Connection and pick the model "free".', keep,
  ].join('\n');
  if (tool === 'vscode') return [
    'In VS Code, open the Language Models editor, choose Add Models, then Custom Endpoint:',
    `  URL:     ${v1}`, `  API key: ${token}`, '  Model:   free (API type: Chat Completions, tool calling on)', keep,
  ].join('\n');
  return [
    `Set up ${tool} with an OpenAI-compatible provider:`,
    `  Base URL: http://127.0.0.1:${port}/v1`,
    `  API key:  ${token}`,
    `  Model:    free`,
    `Keep \`freeaitokens\` running in a terminal while you use it.`,
  ].join('\n');
}
