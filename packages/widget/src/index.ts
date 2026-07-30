// Entry point: read host-page config, arm buffers, mount UI, expose debug handle.

import { startBuffers } from './buffers';
import { createUI } from './ui';
import type { WidgetConfig } from './types';

const VERSION = '0.1.0';

function readConfig(): WidgetConfig | null {
  const script = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;
  const ds: Partial<Record<string, string>> = script?.dataset ?? {};
  const fallback = window.QAPipeline ?? {};
  const token = ds['qaToken'] ?? fallback.token;
  const hasTokenBridge = typeof fallback.getToken === 'function';
  const scriptOrigin = script?.src ? new URL(script.src, location.href).origin : '';
  const endpoint = (ds['qaEndpoint'] ?? fallback.endpoint ?? scriptOrigin).replace(/\/+$/, '');
  // Auth can come from the host's getToken bridge (checked again at submit
  // time) or from a static token; with neither, the widget stays dormant.
  if ((!token && !hasTokenBridge) || !endpoint) return null;
  const cfg: WidgetConfig = { endpoint };
  if (token) cfg.token = token;
  const email = ds['qaEmail'] ?? fallback.email;
  if (email) cfg.email = email;
  if (fallback.appContext) cfg.appContext = fallback.appContext;
  return cfg;
}

(() => {
  if (window.__qaPipeline) return; // double-injection guard

  const cfg = readConfig();
  if (!cfg) {
    // No auth (static token or getToken bridge) → dormant: no buffers, no UI, no requests.
    window.__qaPipeline = { open: () => undefined, version: VERSION };
    return;
  }

  const buffers = startBuffers();
  const mount = (): void => {
    const ui = createUI(cfg, buffers);
    window.__qaPipeline = { open: ui.open, version: VERSION };
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
