// Pure helpers for the tray app, kept out of main.js so they can be tested without Electron.

// The add window may only open pages the provider list names, never a URL a page hands it.
export function allowedUrl(catalogue, url) {
  return typeof url === "string" && catalogue.some((p) => p.signupUrl === url || p.keyUrl === url);
}

// Providers the add window offers: the ones that take a key and have none yet.
export function choices(catalogue, keys, stepsOf) {
  return catalogue.filter((p) => !p.keyless && !keys.get(p.id)).map((p) => {
    const s = p.connect === 'openrouter' ? null : stepsOf(p);
    return { id: p.id, name: p.name, note: p.termsNote ?? '', connect: p.connect ?? null, steps: s?.text ?? '', open: s?.open ?? null };
  });
}

// runList pads columns for a terminal; a menu wants one readable line.
export const menuLine = (line) => line.trim().replace(/\s{2,}/g, ' · ');

export function menuTemplate({ port, reused, lines, startAtLogin }, on) {
  return [
    { label: reused ? `Using the endpoint already running on port ${port}` : `Running on http://127.0.0.1:${port}/v1`, enabled: false },
    { label: 'Copy endpoint', click: on.copyEndpoint },
    { label: 'Copy local token', click: on.copyToken },
    { type: 'separator' },
    { label: 'Providers', submenu: lines.map((l) => ({ label: menuLine(l), enabled: false })) },
    { label: 'Add a provider…', click: on.add },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: startAtLogin, click: on.toggleLogin },
    { label: 'Quit freeaitokens', click: on.quit },
  ];
}
