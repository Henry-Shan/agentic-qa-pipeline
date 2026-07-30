// Buffer behavior against mocked fetch/XHR — no test touches the network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBuffers, type Buffers } from '../src/buffers';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y';

class FakeResponse {
  constructor(
    private readonly body: string,
    public readonly status = 200,
  ) {}
  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
  clone(): FakeResponse {
    return new FakeResponse(this.body, this.status);
  }
  text(): Promise<string> {
    return Promise.resolve(this.body);
  }
}

class FakeXHR {
  status = 0;
  responseType = '';
  responseText = '';
  private listeners: Record<string, Array<() => void>> = {};
  open(_method: string, _url: string | URL): void {}
  send(_body?: unknown): void {}
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn();
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let fetchMock: ReturnType<typeof vi.fn>;
let buffers: Buffers;

beforeEach(() => {
  document.body.innerHTML = '';
  fetchMock = vi.fn(async () => new FakeResponse('{"ok":true}', 200));
  vi.stubGlobal('fetch', fetchMock);
  buffers = startBuffers();
});

afterEach(() => {
  buffers.dispose();
  vi.unstubAllGlobals();
});

describe('network capture — fetch', () => {
  it('records method, url, status and duration', async () => {
    await window.fetch('/api/labs');
    await flush();
    const log = buffers.networkLog();
    expect(log.length).toBe(1);
    const entry = log[0];
    expect(entry).toBeDefined();
    expect(entry?.method).toBe('GET');
    expect(entry?.url).toContain('/api/labs');
    expect(entry?.status).toBe(200);
    expect(entry?.ms).toBeGreaterThanOrEqual(0);
    expect(entry?.bodySnippet).toBeUndefined(); // healthy 200 with a body → no snippet
  });

  it('redacts query-string tokens in the stored url', async () => {
    await window.fetch('/api/labs?token=sekret1234&page=1');
    const entry = buffers.networkLog()[0];
    expect(entry?.url).not.toContain('sekret1234');
    expect(entry?.url).toContain('[redacted]');
    expect(entry?.url).toContain('page=1');
  });

  it('captures a scrubbed body snippet for non-2xx same-origin /api calls', async () => {
    fetchMock.mockResolvedValueOnce(new FakeResponse(`{"error":"not found","jwt":"${JWT}"}`, 404));
    await window.fetch('/api/departments/42/lab-access');
    await flush();
    const entry = buffers.networkLog()[0];
    expect(entry?.status).toBe(404);
    expect(entry?.bodySnippet).toContain('not found');
    expect(entry?.bodySnippet).not.toContain('eyJhbGci');
  });

  it('marks empty-body 200s on same-origin /api calls with an empty snippet', async () => {
    fetchMock.mockResolvedValueOnce(new FakeResponse('', 200));
    await window.fetch('/api/empty');
    await flush();
    expect(buffers.networkLog()[0]?.bodySnippet).toBe('');
  });

  it('never snippets cross-origin calls', async () => {
    fetchMock.mockResolvedValueOnce(new FakeResponse('secret upstream error', 500));
    await window.fetch('https://api.example.com/api/x');
    await flush();
    const entry = buffers.networkLog()[0];
    expect(entry?.status).toBe(500);
    expect(entry?.bodySnippet).toBeUndefined();
  });

  it('never snippets same-origin non-/api paths', async () => {
    fetchMock.mockResolvedValueOnce(new FakeResponse('<html>404</html>', 404));
    await window.fetch('/assets/logo.png');
    await flush();
    expect(buffers.networkLog()[0]?.bodySnippet).toBeUndefined();
  });

  it('records a status-0 entry when fetch rejects, and rethrows', async () => {
    fetchMock.mockRejectedValueOnce(new Error('net down'));
    await expect(window.fetch('/api/x')).rejects.toThrow('net down');
    expect(buffers.networkLog()[0]?.status).toBe(0);
  });

  it('keeps only the last 40 entries', async () => {
    for (let i = 0; i < 45; i++) await window.fetch(`/api/n/${i}`);
    const log = buffers.networkLog();
    expect(log.length).toBe(40);
    expect(log[0]?.url).toContain('/api/n/5');
  });

  it('rawFetch bypasses capture', async () => {
    await buffers.rawFetch('/api/ingest');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(buffers.networkLog().length).toBe(0);
  });
});

describe('network capture — XMLHttpRequest', () => {
  it('records XHR calls and snippets failing same-origin /api responses', () => {
    buffers.dispose();
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    buffers = startBuffers();

    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('GET', '/api/labs?apikey=qqqq8888');
    xhr.send();
    xhr.status = 404;
    xhr.responseText = '{"error":"gone"}';
    xhr.emit('loadend');

    const entry = buffers.networkLog()[0];
    expect(entry?.method).toBe('GET');
    expect(entry?.status).toBe(404);
    expect(entry?.url).not.toContain('qqqq8888');
    expect(entry?.bodySnippet).toContain('gone');
  });
});

describe('console capture', () => {
  it('records error and warn with joined args', () => {
    console.error('boom', { a: 1 });
    console.warn('careful');
    const log = buffers.consoleLog();
    expect(log.length).toBe(2);
    expect(log[0]?.level).toBe('error');
    expect(log[0]?.text).toContain('boom');
    expect(log[0]?.text).toContain('{"a":1}');
    expect(log[1]?.level).toBe('warn');
  });

  it('clamps entries to 500 chars and scrubs secrets', () => {
    console.error('x'.repeat(600));
    console.warn(`leaked ${JWT}`);
    const log = buffers.consoleLog();
    expect(log[0]?.text.length).toBe(500);
    expect(log[1]?.text).not.toContain('eyJhbGci');
  });

  it('forwards to the original console method', () => {
    buffers.dispose();
    const original = console.error;
    const spy = vi.fn();
    console.error = spy;
    buffers = startBuffers();
    console.error('hello');
    expect(spy).toHaveBeenCalledWith('hello');
    buffers.dispose();
    console.error = original;
    buffers = startBuffers();
  });

  it('captures window error events', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'Boom happened' }));
    expect(buffers.consoleLog().at(-1)?.text).toContain('Boom happened');
  });

  it('captures unhandled rejections', () => {
    const event = Object.assign(new Event('unhandledrejection'), { reason: new Error('nope') });
    window.dispatchEvent(event);
    const entry = buffers.consoleLog().at(-1);
    expect(entry?.level).toBe('error');
    expect(entry?.text).toContain('nope');
  });

  it('keeps only the last 50 entries', () => {
    for (let i = 0; i < 55; i++) console.warn(`w${i}`);
    const log = buffers.consoleLog();
    expect(log.length).toBe(50);
    expect(log[0]?.text).toBe('w5');
  });
});

describe('click trail + routes', () => {
  it('starts with the initial route', () => {
    const first = buffers.clickTrail()[0];
    expect(first?.route).toBe(location.pathname);
    expect(first?.text).toBeUndefined();
  });

  it('records clicks with text, testid and sentry component', () => {
    document.body.innerHTML = `
      <section data-sentry-component="InventoryView">
        <button data-testid="save">Save</button>
      </section>`;
    const btn = document.querySelector('button');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const entry = buffers.clickTrail().at(-1);
    expect(entry?.text).toBe('Save');
    expect(entry?.testid).toBe('save');
    expect(entry?.component).toBe('InventoryView');
    expect(entry?.route).toBe(location.pathname);
  });

  it('records clicks with a data-component annotation (plain attribute family)', () => {
    document.body.innerHTML = `
      <section data-component="OrderTable">
        <button data-testid="submit">Submit</button>
      </section>`;
    const btn = document.querySelector('button');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(buffers.clickTrail().at(-1)?.component).toBe('OrderTable');
  });

  it('clamps click text to 40 chars', () => {
    document.body.innerHTML = `<button>${'z'.repeat(80)}</button>`;
    document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(buffers.clickTrail().at(-1)?.text?.length).toBe(40);
  });

  it('ignores clicks inside the widget root', () => {
    document.body.innerHTML = `<div id="widget"><button>internal</button></div>`;
    const widget = document.getElementById('widget');
    buffers.setIgnoreRoot(widget);
    const before = buffers.clickTrail().length;
    document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(buffers.clickTrail().length).toBe(before);
  });

  it('records pushState/replaceState route changes once per change', () => {
    const before = buffers.clickTrail().length;
    history.pushState({}, '', '/inventory');
    history.pushState({}, '', '/inventory'); // same route — not recorded twice
    history.replaceState({}, '', '/inventory/42');
    const trail = buffers.clickTrail();
    expect(trail.length).toBe(before + 2);
    expect(trail.at(-2)?.route).toBe('/inventory');
    expect(trail.at(-1)?.route).toBe('/inventory/42');
  });

  it('keeps only the last 50 trail entries', () => {
    document.body.innerHTML = `<button>go</button>`;
    const btn = document.querySelector('button');
    for (let i = 0; i < 60; i++) btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(buffers.clickTrail().length).toBe(50);
  });
});

describe('dispose', () => {
  it('restores fetch and console patches', () => {
    const patchedFetch = window.fetch;
    expect(patchedFetch).not.toBe(fetchMock);
    buffers.dispose();
    expect(window.fetch).toBe(fetchMock);
    const restoredError = console.error;
    buffers = startBuffers();
    expect(console.error).not.toBe(restoredError);
    buffers.dispose();
    expect(console.error).toBe(restoredError);
    buffers = startBuffers(); // afterEach disposes this one
  });
});
