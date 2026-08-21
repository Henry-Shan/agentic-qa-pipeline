'use client';

// Attached terminal (contracts §Terminal) — a REAL pty on the dev Mac running
// `claude --resume <session>` in the run's worktree, so this panel behaves
// exactly like the operator's own terminal: colours, alt-screen, ctrl-C,
// arrow keys, resize.
//
// It connects to 127.0.0.1 on purpose. The terminal host is bound to loopback
// and never tunnelled, so this works only on the machine the worker runs on —
// which is the point: a terminal reachable from the internet would be remote
// code execution as that user. Anywhere else, the panel says so and does
// nothing. Nothing is attached until the button is pressed.

import { useCallback, useEffect, useRef, useState } from 'react';

type Phase = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export function TerminalPanel({ reportId }: { reportId: number }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState<string | null>(null);

  const detach = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    disposeRef.current?.();
    disposeRef.current = null;
    setPhase('idle');
    setNote(null);
  }, []);

  useEffect(() => () => detach(), [detach]);

  const attach = useCallback(async () => {
    if (phase === 'connecting' || phase === 'open') return;
    setPhase('connecting');
    setNote(null);
    try {
      // 1. A single-use ticket for THIS report (tester-gated, 60s).
      const res = await fetch('/api/term-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reportId }),
      });
      if (!res.ok) throw new Error(`could not get a terminal ticket (${res.status})`);
      const { token, port } = (await res.json()) as { token: string; port: number };

      // 2. xterm is imported lazily — it never lands in the page's first load.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');

      const mount = mountRef.current;
      if (!mount) return;
      mount.replaceChildren();

      const term = new Terminal({
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        fontSize: 12.5,
        lineHeight: 1.35,
        cursorBlink: true,
        convertEol: false,
        theme: {
          background: '#1c1b19',
          foreground: '#e8e6e1',
          cursor: '#12a394',
          selectionBackground: 'rgba(18,163,148,0.32)',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(mount);
      fit.fit();

      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/?t=${encodeURIComponent(token)}&cols=${term.cols}&rows=${term.rows}`,
      );
      socketRef.current = ws;

      ws.onopen = () => {
        setPhase('open');
        term.focus();
      };
      ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '');
      ws.onerror = () => {
        setPhase('error');
        setNote(
          'Could not reach the terminal on this machine. It is bound to localhost, so it only works on the Mac running the worker.',
        );
      };
      ws.onclose = (e) => {
        setPhase((p) => (p === 'error' ? p : 'closed'));
        if (e.reason) setNote(e.reason);
      };

      const keys = term.onData((d) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(d);
      });
      const onResize = () => {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      };
      window.addEventListener('resize', onResize);

      disposeRef.current = () => {
        window.removeEventListener('resize', onResize);
        keys.dispose();
        term.dispose();
      };
    } catch (e) {
      setPhase('error');
      setNote((e as Error).message);
    }
  }, [phase, reportId]);

  return (
    <div className="sheet overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line bg-stage px-3 py-2">
        <span className="text-[12.5px] font-medium">Terminal</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3">
          {phase === 'open'
            ? 'live — claude, resumed in this run’s worktree'
            : 'runs on the machine hosting the worker'}
        </span>
        {phase === 'open' || phase === 'connecting' ? (
          <button type="button" onClick={detach} className="btn btn-quiet flex-none">
            Detach
          </button>
        ) : (
          <button type="button" onClick={() => void attach()} className="btn flex-none">
            {phase === 'idle' ? 'Attach terminal' : 'Reconnect'}
          </button>
        )}
      </div>

      {phase === 'idle' ? (
        <p className="px-3 py-6 text-center text-[12.5px] text-ink-3">
          Opens a real terminal running <code className="font-mono">claude --resume</code> in this run’s
          worktree — the same session, the same keys.
        </p>
      ) : (
        <div ref={mountRef} className="h-[420px] w-full bg-[#1c1b19] px-2 py-2" />
      )}

      {note ? (
        <p role="status" className="border-t border-line-soft px-3 py-2 text-[11.5px] text-ink-3">
          {note}
        </p>
      ) : null}
    </div>
  );
}
