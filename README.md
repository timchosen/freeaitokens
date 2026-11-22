# freeaitokens

Free AI models for the coding tools you already use. One command starts a local endpoint backed by providers' free tiers, picks the best available model for every request, and moves to another one when a provider hits its limit.

```bash
npx freeaitokens
```

That works straight away, with no account, on providers that need no key. Then add a free key or two so longer coding sessions don't run out:

```bash
npx freeaitokens add
```

## Use it with your tools

| Tool | How |
|---|---|
| Claude Code | `npx freeaitokens claude` (any Claude Code arguments work after it) |
| Codex | `npx freeaitokens codex` |
| OpenCode | `npx freeaitokens setup opencode`, then pick the model `freeaitokens/free` |
| Cline, Aider, Continue | `npx freeaitokens setup cline` prints the three values to paste |
| Anything OpenAI-compatible | Base URL `http://127.0.0.1:4949/v1`, model `free`, key from the startup banner |

The launchers only affect that one session. Run `claude` or `codex` normally and they use your own account as before. `setup opencode` adds a provider next to your existing ones and keeps a backup; `--undo` restores it.

## What it does

- **Picks a model per request.** It only considers models that can handle the request: enough context for the conversation so far, tool calling when the tool needs it, images when there are images. Among those it prefers better models that have been fast and reliable for you, and it stays on the same model through a conversation unless another is clearly better.
- **Fails over.** On a rate limit, server error or timeout it tries the next model before your tool sees anything. If everything is busy and capacity returns within 30 seconds, it waits; otherwise it tells you when capacity returns.
- **Tracks free limits** per provider, model and key, by the minute and by the day, and corrects itself from the limits providers report.
- **Speaks three formats**: OpenAI chat completions, Anthropic Messages (Claude Code) and OpenAI Responses (Codex).

## Providers

| Provider | Key needed | Notes |
|---|---|---|
| Kilo Gateway | No | About 200 requests an hour per IP. Free prompts may be used for training. |
| Groq | Free key | |
| Cerebras | Free key | |
| Mistral | Free key | Free "Experiment" plan asks for a phone number. |
| OpenRouter | Free account | One-click connect in the browser. About 50 free requests a day. |
| Google Gemini | Free key | Google's terms limit the API to professional or business use. |

`freeaitokens add` opens each provider's key page, shows the steps, and can pick the key up from your clipboard when you copy it (only during that step, and only if you agree). Keys are tested before they are saved, and stored in your system keychain. Where there is no keychain (some Linux servers, Termux), they go in a file only you can read, and it says so.

`freeaitokens list` shows what you have and what is left today. `freeaitokens remove <provider>` deletes a key.

## Paid keys

Paid keys can sit below the free ones as a last resort. They are used only when no free model can serve the request, each paid request is printed, and there is a daily cap (200 by default, `--paid-cap <n>`). `--free-only` turns them off.

## Rules

Free tiers exist for developers to try things. Using them through this tool is still governed by each provider's terms:

- use your own keys, one account per provider;
- never share your endpoint with other people or resell access;
- don't run a production service on free tiers.

The endpoint listens on `127.0.0.1` only and needs the local token from the startup banner.

## Not supported yet

- **Cursor**: it sends custom-endpoint traffic through its own servers, which cannot reach a local address.
- **The ChatGPT app**: it cannot use a custom endpoint.
- Images, audio and embeddings endpoints; a dashboard; a desktop app.
- Codex's connected-app (MCP) tools and web search are not passed to free models: they add more context than free models accept.

## Development

```bash
npm install
npm test
npm run build
npx tsx scripts/smoke.ts   # one live request per usable provider
```

## Licence

MIT.
