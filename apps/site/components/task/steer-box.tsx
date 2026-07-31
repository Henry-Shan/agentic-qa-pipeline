'use client';

import { useState } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';
import type { MessageKind, ReportStatus } from '@/lib/types';

interface Props {
  reportId: number;
  status: ReportStatus;
  userEmail: string;
}

export function SteerBox({ reportId, status, userEmail }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // blocked = run is alive polling /api/answer for a question; it holds a
  // dispatch slot until answered, so it must be stoppable too.
  const canStop = status === 'running' || status === 'rework' || status === 'blocked';
  const canVerdict = status === 'pr_ready' || status === 'preview';
  const hasText = text.trim().length > 0;

  async function send(kind: MessageKind, body: string, confirmation: string) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const supabase = getBrowserClient();
    const { error } = await supabase
      .from('qa_messages')
      .insert({ report_id: reportId, author_email: userEmail, body, kind });
    setBusy(false);
    if (error) {
      setNote('Could not send — try again.');
      return;
    }
    setText('');
    setNote(confirmation);
  }

  return (
    <div className="card">
      {canVerdict ? (
        <div className="mb-3 border-b border-line-soft pb-3">
          <div className="text-[13.5px] font-semibold">Did this fix it?</div>
          <div className="mt-0.5 text-[11.5px] text-ink-3">
            Check the preview, then give your verdict. &ldquo;Still broken&rdquo; needs a note below.
          </div>
          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => void send('verdict_fixed', text.trim(), 'Marked as fixed — thank you.')}
              disabled={busy}
              className="flex-1 rounded-lg bg-green px-4 py-2.5 text-[13px] font-bold text-on-accent disabled:opacity-50"
            >
              ✓ It&apos;s fixed
            </button>
            <button
              onClick={() => void send('verdict_broken', text.trim(), 'Sent back to Claude for rework.')}
              disabled={busy || !hasText}
              title={hasText ? undefined : 'Write a note first — what is still broken?'}
              className="flex-1 rounded-lg border-[1.5px] border-red bg-stage px-4 py-2.5 text-[13px] font-bold text-red disabled:opacity-45"
            >
              Still broken
            </button>
          </div>
        </div>
      ) : null}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          'e.g. "Okafor Lab should be on by default" — mid-run this pauses Claude; after, it reopens the same session on the same branch.'
        }
        className="h-20 w-full resize-none rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-qa-bright focus:outline-none"
      />
      <div className="mt-2 flex gap-2">
        {canStop ? (
          <button
            onClick={() => void send('stop', '', 'Stop signal sent.')}
            disabled={busy}
            className="rounded-lg border border-red/40 bg-stage px-3.5 py-2 text-[12.5px] font-semibold text-red disabled:opacity-50"
          >
            ■ Stop run
          </button>
        ) : null}
        <button
          onClick={() => void send('steer', text.trim(), 'Sent — Claude will pick it up shortly.')}
          disabled={busy || !hasText}
          className="flex-1 rounded-lg bg-qa px-3.5 py-2 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-qa-bright disabled:opacity-50"
        >
          Send to Claude
        </button>
      </div>
      {note ? <div className="mt-2 text-[11.5px] text-ink-3">{note}</div> : null}
    </div>
  );
}
