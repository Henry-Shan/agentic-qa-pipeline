'use client';

// Verified → Shipped, by hand (contracts §Ship detect).
//
// The worker already ships a task on its own: it polls the open PR every 10
// minutes and flips the report to `shipped` once GitHub reports it merged. This
// button is for the gap — a PR merged in a way the poll cannot see, or one that
// never existed. It records the same outcome without inventing a new state.
//
// OWNER ONLY. Everyone on the QA board can file, verify and send work back;
// declaring something merged into the product is a different kind of claim, and
// the person who owns the repo is the only one in a position to make it.
//
// This hiding is NOT the enforcement. RLS on qa_reports is `qa_is_tester()` for
// all operations, so any tester could set `shipped` straight through the API.
// db/0018 adds the trigger that actually refuses it; until that migration is
// applied, this button is a convention and not a control.

import { useState } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';
import { guardReport } from '@/lib/report-gone';

/** Set NEXT_PUBLIC_QA_OWNER_EMAIL to move ownership without a code change. */
const OWNER = (process.env.NEXT_PUBLIC_QA_OWNER_EMAIL ?? 'admin@example.com').toLowerCase();

export function isOwner(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase() === OWNER;
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

  if (!isOwner(userEmail)) return null;

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
    // Without this the board just changes colour and nothing says who decided.
    await supabase.from('qa_events').insert({
      report_id: reportId,
      type: 'system',
      message: `marked shipped by ${userEmail}`,
    });
    setState('idle');
    setArmed(false);
  }

  return (
    <div className="mt-3 border-t border-line-soft pt-3">
      <div className="text-[13px] font-semibold">Pushed to GitHub?</div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">
        Ships automatically when the PR merges. Use this if it merged some other way.
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {armed ? (
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
            className="h-9 rounded-lg border border-line px-3.5 text-[12.5px] font-semibold text-ink-2 hover:border-qa-bright"
          >
            Mark as shipped
          </button>
        )}
        {state === 'failed' ? <span className="text-[11.5px] text-red">Could not update — try again.</span> : null}
      </div>
    </div>
  );
}
