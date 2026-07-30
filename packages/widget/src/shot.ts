// Viewport screenshot with the picked element ring-marked. Resolves null on ANY
// failure — a report must still send without its screenshot.

import { domToCanvas } from 'modern-screenshot';

const MAX_DIM = 1600;
const MAX_BYTES = 4 * 1024 * 1024; // data-URL length budget per CONTRACTS.md
const CAPTURE_TIMEOUT_MS = 12_000;
const MARK = '#14B8A6';
const MARK_RING = 'rgba(20,184,166,0.35)';

export async function captureShot(target: Element | null, hide?: HTMLElement): Promise<string | null> {
  try {
    const rect = target ? target.getBoundingClientRect() : null;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    let full: HTMLCanvasElement;
    if (hide) hide.style.visibility = 'hidden';
    try {
      full = await withTimeout(
        domToCanvas(document.body, {
          scale,
          backgroundColor: pageBackground(),
          filter: (node) => node !== hide,
        }),
        CAPTURE_TIMEOUT_MS,
      );
    } finally {
      if (hide) hide.style.visibility = '';
    }

    // bodyRect is viewport-relative, so its negation is the viewport origin
    // inside the body-sized capture canvas.
    const bodyRect = document.body.getBoundingClientRect();
    const sx = Math.max(0, -bodyRect.left * scale);
    const sy = Math.max(0, -bodyRect.top * scale);
    let canvas = crop(full, sx, sy, Math.round(window.innerWidth * scale), Math.round(window.innerHeight * scale));
    if (rect) markElement(canvas, rect, scale);

    const maxDim = Math.max(canvas.width, canvas.height);
    if (maxDim > MAX_DIM) canvas = resize(canvas, MAX_DIM / maxDim);
    let dataUrl = canvas.toDataURL('image/png');
    while (dataUrl.length > MAX_BYTES && Math.max(canvas.width, canvas.height) > 320) {
      canvas = resize(canvas, 0.8);
      dataUrl = canvas.toDataURL('image/png');
    }
    return dataUrl.length > MAX_BYTES ? null : dataUrl;
  } catch {
    return null;
  }
}

function pageBackground(): string {
  const transparent = (c: string): boolean => c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
  const body = getComputedStyle(document.body).backgroundColor;
  if (!transparent(body)) return body;
  const html = getComputedStyle(document.documentElement).backgroundColor;
  return transparent(html) ? '#ffffff' : html;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

function crop(source: HTMLCanvasElement, sx: number, sy: number, w: number, h: number): HTMLCanvasElement {
  const width = Math.max(1, Math.min(w, source.width - sx));
  const height = Math.max(1, Math.min(h, source.height - sy));
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  context(out).drawImage(source, sx, sy, width, height, 0, 0, width, height);
  return out;
}

function resize(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(source.width * factor));
  out.height = Math.max(1, Math.round(source.height * factor));
  context(out).drawImage(source, 0, 0, out.width, out.height);
  return out;
}

function markElement(canvas: HTMLCanvasElement, rect: DOMRect, scale: number): void {
  const ctx = context(canvas);
  const pad = 3 * scale;
  const x = rect.left * scale - pad;
  const y = rect.top * scale - pad;
  const w = rect.width * scale + pad * 2;
  const h = rect.height * scale + pad * 2;
  ctx.save();
  traceRoundedRect(ctx, x - 2 * scale, y - 2 * scale, w + 4 * scale, h + 4 * scale, 10 * scale);
  ctx.lineWidth = 5 * scale;
  ctx.strokeStyle = MARK_RING;
  ctx.stroke();
  traceRoundedRect(ctx, x, y, w, h, 8 * scale);
  ctx.lineWidth = 2 * scale;
  ctx.strokeStyle = MARK;
  ctx.stroke();
  ctx.restore();
}

function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('screenshot timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
