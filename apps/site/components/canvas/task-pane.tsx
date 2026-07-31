'use client';

// Right-side task panel for the selected sticky — floats inside the canvas
// viewport. Mini version of the task page: status, log tail, links, steer.

import { useState } from 'react';
import Link from 'next/link';
import { getBrowserClient } from '@/lib/supabase/client';
import { nameOf, relativeAge } from '@/lib/format';
import { StatusPill } from '@/components/status-pill';
import type { QaReport, QaRun } from '@/lib/types';

export function TaskPane({
  report,
  run,
  userEmail,
  onClose,
}: {
  report: QaReport;
  run: QaRun | null;
  userEmail: string;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const previewUrl = run?.preview_status === 'live' ? run.preview_url : null;

  async function sendSteer() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setNote(null);
    const { error } = await getBrowserClient()
      .from('qa_messages')
      .insert({ report_id: report.id, author_email: userEmail, body, kind: 'steer' });
    setBusy(false);
    if (error) {
      setNote('Could not send — try again.');
      return;
    }
    setText('');
    setNote('Sent — Claude will pick it up shortly.');
  }

  return (
    <aside
      data-pane
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute right-3 top-3 z-20 max-h-[calc(100%-24px)] w-[280px] overflow-y-auto rounded-xl border border-line bg-stage p-4 shadow-pop"
      aria-label={`Task ${report.id} details`}
    >
      <button
        onClick={onClose}
        aria-label="Close panel"
        className="absolute right-2.5 top-2 text-sm text-ink-3 transition-colors hover:text-ink"
      >
        ✕
      </button>

      <div className="flex pr-6">
        <StatusPill status={report.status} />
      </div>
      <h4 className="mb-1 mt-2 text-[13px] font-semibold leading-[1.35]">{report.title}</h4>
      <div className="text-[11px] text-ink-3">
        {nameOf(report.reporter_email)}
        {report.route ? ` · ${report.route}` : ''} ·{' '}
        <span suppressHydrationWarning>{relativeAge(report.created_at)}</span>
      </div>

      <div className="cap-label mt-3">Claude&apos;s log</div>
      <div className="rounded-lg border border-line-soft bg-paper px-2.5 py-2 font-mono text-[10px] leading-[1.8] text-ink-2">
        {run?.log_tail ? `▸ ${run.log_tail}` : run ? `phase: ${run.phase}` : 'queued — a run hasn’t started yet'}
      </div>

      <Link
        href={`/task/${report.id}`}
        className="mt-2.5 block w-full rounded-lg bg-qa px-3 py-2 text-center text-[11.5px] font-bold text-on-accent transition-colors hover:bg-qa-bright"
      >
        Open task ↗
      </Link>
      {previewUrl ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 block w-full rounded-lg border border-line bg-stage px-3 py-2 text-center text-[11.5px] font-bold text-ink-2 transition-colors hover:bg-canvas hover:text-ink"
        >
          Open preview ↗
        </a>
      ) : (
        <button
          disabled
          title={run?.preview_status === 'starting' ? 'Preview is starting…' : 'No live preview yet'}
          className="mt-1.5 block w-full cursor-not-allowed rounded-lg border border-line bg-stage px-3 py-2 text-center text-[11.5px] font-bold text-ink-3 opacity-60"
        >
          Open preview ↗
        </button>
      )}

      <div className="cap-label mt-3">Talk to Claude — anytime</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Interrupts mid-run; reopens the session after."
        className="h-[52px] w-full resize-none rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[11px] text-ink placeholder:text-ink-3 focus:border-qa-bright focus:outline-none"
      />
      <button
        onClick={() => void sendSteer()}
        disabled={busy || !text.trim()}
        className="mt-1.5 block w-full rounded-lg bg-qa px-3 py-2 text-center text-[11.5px] font-bold text-on-accent transition-colors hover:bg-qa-bright disabled:opacity-50"
      >
        Send
      </button>
      {note ? <div className="mt-1.5 text-[10.5px] text-ink-3">{note}</div> : null}
    </aside>
  );
}
