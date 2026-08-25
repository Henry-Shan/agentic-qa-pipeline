'use client';

// Verified → Shipped, by hand (contracts §Ship detect).
//
// The worker already ships a task on its own: it polls the open PR every 10
// minutes and flips the report to `shipped` once GitHub reports it merged. This
// is for the gap — a PR merged in a way the poll cannot see, or one that never
// existed. It records the same outcome without inventing a new state.
//
// OWNER ONLY, and NEVER silently invisible. Hiding it from non-owners hides the
// answer to "how do I ship this?" too, and if the owner list is wrong the owner
// sees nothing and concludes the button was never built. So everyone sees the
// card; non-owners see it disabled and are told who can press it, which makes a
// misconfigured owner list diagnose itself.
//
// Hiding is NOT the enforcement either way. RLS on qa_reports is `qa_is_tester()`
// for all operations, so any tester could PATCH status=shipped straight through
// the API; db/0018's trigger is what refuses that.

import { useState } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';
import { guardReport } from '@/lib/report-gone';

/** Comma-separated; keep in step with db/0018's list. */
const OWNERS = (process.env.NEXT_PUBLIC_QA_OWNER_EMAILS ?? 'admin@example.com,the host app@example.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isOwner(email: string | null | undefined): boolean {
  return OWNERS.includes((email ?? '').trim().toLowerCase());
}

export function MarkShipped({
  reportId,
  userEmail,
  onReportGone,
}: {
  reportId: number;
  userEmail: string;
  onReportGone: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'failed'>('idle');
  const owner = isOwner(userEmail);

  async function ship() {
    setState('sending');
    const supabase = getBrowserClient();
    const done = await guardReport(() =>
      supabase.from('qa_reports').update({ status: 'shipped' }).eq('id', reportId),
    );
    if (done.status === 'gone') {
      onReportGone();
      return;
    }
    if (done.status === 'error') {
      setState('failed');
      setArmed(false);
      return;
    }
    await supabase.from('qa_events').insert({
      report_id: reportId,
      type: 'system',
      message: `marked shipped by ${userEmail}`,
    });
    setState('idle');
    setArmed(false);
  }

  return (
    <div className="mb-4 rounded-[14px] border border-green/30 bg-green-soft/40 p-4 shadow-card">
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-green">Verified</h2>
      <div className="text-[13.5px] font-semibold">Pushed to GitHub?</div>
      <p className="mt-0.5 text-[12.5px] leading-[1.55] text-ink-2">
        This ships by itself once the PR merges — the worker checks every 10 minutes. Use this only if it
        merged some other way, or there was no PR.
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {!owner ? (
          <>
            <button
              disabled
              title={`Only ${OWNERS.join(' or ')} can mark a task shipped`}
              className="h-9 rounded-lg border border-line px-3.5 text-[12.5px] font-semibold text-ink-3 opacity-60"
            >
              Mark as shipped
            </button>
            <span className="text-[11.5px] text-ink-3">Only {OWNERS[0]} can do this.</span>
          </>
        ) : armed ? (
          <>
            <button
              onClick={() => void ship()}
              disabled={state === 'sending'}
              className="h-9 rounded-lg bg-green px-3.5 text-[12.5px] font-semibold text-on-accent disabled:opacity-50"
            >
              {state === 'sending' ? 'Marking…' : 'Yes — mark it shipped'}
            </button>
            <button
              onClick={() => setArmed(false)}
              className="h-9 rounded-lg border border-line px-3 text-[12.5px] font-semibold text-ink-2"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setArmed(true)}
            className="h-9 rounded-lg bg-green px-3.5 text-[12.5px] font-semibold text-on-accent"
          >
            Mark as shipped
          </button>
        )}
        {state === 'failed' ? <span className="text-[11.5px] text-red">Could not update — try again.</span> : null}
      </div>
    </div>
  );
}
