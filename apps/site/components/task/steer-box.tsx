'use client';

import { useState } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';
import { guardReport } from '@/lib/report-gone';
import { AssignControl } from '@/components/task/assign-control';
import type { MessageKind, ReportStatus } from '@/lib/types';

interface Props {
  reportId: number;
  status: ReportStatus;
  /** Current qa_reports.assignee (display name) or null. */
  assignee: string | null;
  userEmail: string;
  /** The report row is gone — the page swaps to its deleted state. */
  onReportGone: () => void;
}

export function SteerBox({ reportId, status, assignee, userEmail, onReportGone }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Stop is offered only while a run is actually moving (contracts § Task
  // action row).
  // `blocked` is stoppable too: such a run still holds a dispatch slot and polls
  // for an answer, so the human needs a way to end it from here.
  const canStop = status === 'running' || status === 'rework' || status === 'blocked';
  const canVerdict = status === 'pr_ready' || status === 'preview';
  const hasText = text.trim().length > 0;

  async function send(kind: MessageKind, body: string, confirmation: string) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const supabase = getBrowserClient();
    // qa_messages FKs into qa_reports: a report deleted while this tab was
    // open fails the insert rather than queueing an orphan message.
    const sent = await guardReport(() =>
      supabase.from('qa_messages').insert({ report_id: reportId, author_email: userEmail, body, kind }),
    );
    if (sent.status === 'gone') {
      onReportGone();
      return;
    }
    setBusy(false);
    if (sent.status === 'error') {
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
      {/* One organized action row (contracts § Task action row): primary Send ·
          secondary Assign to me · quiet destructive Stop, right-aligned behind
          a hairline. All 36px tall, 8px radius, 8px gaps; wraps at narrow widths
          (the Stop group keeps its own line rather than crowding Assign). */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void send('steer', text.trim(), 'Sent — Claude will pick it up shortly.')}
          disabled={busy || !hasText}
          className="h-9 min-w-32 flex-1 rounded-lg bg-qa px-3.5 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-qa-bright disabled:opacity-50"
        >
          Send to Claude
        </button>
        <AssignControl
          reportId={reportId}
          assignee={assignee}
          userEmail={userEmail}
          onReportGone={onReportGone}
        />
        {canStop ? (
          <div className="ml-auto flex items-center gap-2 border-l border-line-soft pl-2">
            <button
              onClick={() => void send('stop', '', 'Stop signal sent.')}
              disabled={busy}
              title="Stop the run in progress"
              className="h-9 rounded-lg px-3 text-[12.5px] font-semibold text-red transition-colors hover:bg-red-soft disabled:opacity-50"
            >
              ■ Stop run
            </button>
          </div>
        ) : null}
      </div>
      {note ? <div className="mt-2 text-[11.5px] text-ink-3">{note}</div> : null}
    </div>
  );
}
