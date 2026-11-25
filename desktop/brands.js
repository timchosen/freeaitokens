// Logos for agents, providers and model makers. The marks in logos/ are from @lobehub/icons-static-svg 1.106.0
// (MIT, see logos/LICENSE); each is its owner's trademark, shown only to name it. Anything without a mark gets its initial.
(function () {
  const AGENTS = { claude: 'claudecode-color', codex: 'codex-color', gemini: 'geminicli-color', goose: 'goose', qwen: 'qwen-color', kilo: 'kilocode' };
  const PROVIDERS = { kilo: 'kilocode', groq: 'groq', cerebras: 'cerebras', openrouter: 'openrouter', gemini: 'gemini-color', nvidia: 'nvidia-color', zai: 'zai', cloudflare: 'cloudflare-color' };
  // who made a model, read from its id; first match wins, so the narrower names come first
  const MAKERS = [
    [/nemotron|nvidia/, 'NVIDIA', 'nvidia-color'], [/gemma/, 'Google', 'gemma-color'], [/gemini|google/, 'Google', 'gemini-color'],
    [/qwen/, 'Qwen', 'qwen-color'], [/deepseek/, 'DeepSeek', 'deepseek-color'], [/glm|z-ai|zai/, 'Z.ai', 'zai'],
    [/kimi|moonshot/, 'Kimi', 'kimi'], [/mistral|codestral|devstral|magistral|pixtral/, 'Mistral', 'mistral-color'],
    [/llama|meta/, 'Meta', 'meta-color'], [/cohere|command-/, 'Cohere', 'cohere-color'], [/minimax/, 'MiniMax', 'minimax-color'],
    [/flux|black-forest/, 'Black Forest Labs', 'flux'], [/stable-diffusion|stability|sdxl/, 'Stability AI', 'stability-color'],
    [/\bphi-|microsoft/, 'Microsoft', 'microsoft-color'], [/grok|x-ai|xai/, 'xAI', 'xai'], [/claude|anthropic/, 'Anthropic', 'claude-color'],
    [/gpt|openai|whisper|dall-e|tts-1/, 'OpenAI', 'openai'],
  ];
  function maker(id) {
    const s = String(id).toLowerCase();
    const m = MAKERS.find(([re]) => re.test(s));
    return m ? { name: m[1], file: m[2] } : null;
  }
  // an <img> of the mark, or the name's initial in a tile; one-colour marks are flipped to light in dark mode by app.css
  function logo(file, name, size = 20) {
    if (!file) {
      const s = document.createElement('span');
      s.className = 'logo initial';
      s.style.setProperty('--s', `${size}px`);
      s.textContent = (String(name).match(/[A-Za-z0-9]/) ?? ['?'])[0].toUpperCase();
      s.setAttribute('aria-hidden', 'true');
      return s;
    }
    const i = document.createElement('img');
    i.className = file.endsWith('-color') ? 'logo' : 'logo mono';
    i.src = `logos/${file}.svg`; i.alt = ''; i.width = size; i.height = size;
    return i;
  }
  globalThis.brands = {
    maker,
    agent: (id, name, size) => logo(AGENTS[id], name, size),
    provider: (id, name, size) => logo(PROVIDERS[id], name, size),
    model: (id, size) => { const m = maker(id); return logo(m?.file, m?.name ?? id, size); },
  };
})();
