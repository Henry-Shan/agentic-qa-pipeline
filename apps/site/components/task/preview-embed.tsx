'use client';

// Embedded replay preview (contracts § Replay): a browser-window-styled card
// framing the run's live preview. The parent-side handshake is the SAME
// hello/activate/token flow as /capture (shared useFrameHost hook — `filed` is
// ignored here); after activation we send the replay message once with the
// report's route/trail/target, show "replaying…", and render the replay-done
// note. ⟳ Replay re-sends. Allowed frame origin = the preview_url origin.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrameHost } from '@/lib/use-frame-host';
import type { QaReport } from '@/lib/types';

// The activate reply triggers the loader to inject the widget script; give the
// widget a beat to attach its listener before the one automatic replay send.
const REPLAY_DELAY_MS = 750;

export function PreviewEmbed({ previewUrl, report }: { previewUrl: string; report: QaReport }) {
  const allowedOrigin = useMemo(() => {
    try {
      return new URL(previewUrl).origin;
    } catch {
      return null;
    }
  }, [previewUrl]);

  const frameRef = useRef<{ source: WindowProxy; origin: string } | null>(null);
  const autoSentRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const reportRef = useRef(report);
  reportRef.current = report;

  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'replaying' | 'done'>('idle');
  const [doneNote, setDoneNote] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const sendReplay = () => {
    const frame = frameRef.current;
    if (!frame) return;
    const r = reportRef.current;
    frame.source.postMessage(
      {
        type: 'qa-pipeline:replay',
        route: r.route ?? '/',
        trail: r.click_trail ?? [],
        ...(r.selector ? { selector: r.selector } : {}),
        ...(r.element_text ? { elementText: r.element_text } : {}),
      },
      frame.origin,
    );
    setPhase('replaying');
    setDoneNote(null);
  };

  useFrameHost(allowedOrigin, {
    onActivate: (source, origin) => {
      frameRef.current = { source, origin };
      setReady(true);
      if (autoSentRef.current) return; // duplicate hellos → activate again, replay ONCE
      autoSentRef.current = true;
      timerRef.current = window.setTimeout(sendReplay, REPLAY_DELAY_MS);
    },
    onMessage: (data) => {
      if (data.type === 'qa-pipeline:replay-done') {
        const shown = typeof data.shown === 'number' ? data.shown : 0;
        const skipped = typeof data.skipped === 'number' ? data.skipped : 0;
        setPhase('done');
        setDoneNote(`replayed ${shown} step${shown === 1 ? '' : 's'} · ${skipped} skipped`);
      }
    },
  });

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-stage">
      {/* Browser-window chrome bar */}
      <div className="flex items-center gap-2 border-b border-line bg-canvas px-2.5 py-1.5">
        <span className="flex flex-none items-center gap-1" aria-hidden>
          <span className="size-2 rounded-full bg-red/40" />
          <span className="size-2 rounded-full bg-amber/40" />
          <span className="size-2 rounded-full bg-green/40" />
        </span>
        <span
          title={previewUrl}
          className="min-w-0 flex-1 truncate rounded-md border border-line-soft bg-stage px-2 py-0.5 font-mono text-[10.5px] text-ink-3"
        >
          {previewUrl}
        </span>
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the fixed app in a new tab"
          aria-label="Open the fixed app in a new tab"
          className="flex-none rounded-md p-1 text-ink-3 transition-colors hover:bg-line-soft hover:text-ink"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M6.5 3.5H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5M9.5 2.5h4v4M13.5 2.5 7.5 8.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
        <button
          type="button"
          onClick={sendReplay}
          disabled={!ready}
          title={ready ? 'Replay the reported steps' : 'Waiting for the preview to connect…'}
          className="flex-none rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-qa transition-colors hover:bg-qa-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          ⟳ Replay
        </button>
      </div>

      <iframe
        src={previewUrl}
        title="Fixed app preview"
        className="block aspect-[16/10] w-full border-0 bg-paper"
      />

      {phase !== 'idle' ? (
        <div
          role="status"
          className="flex items-center gap-1.5 border-t border-line px-2.5 py-1 text-[11px] text-ink-3"
        >
          {phase === 'replaying' ? (
            <>
              <span className="working-dot flex-none text-amber" aria-hidden />
              replaying…
            </>
          ) : (
            doneNote
          )}
        </div>
      ) : null}
    </div>
  );
}
