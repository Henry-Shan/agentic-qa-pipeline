'use client';

// "Assign to <name>" split control (contracts § Assignment), rendered in the
// steer card beside "Send to Claude". Primary button assigns to the selected
// tester — defaulting to the signed-in user's OWN display name — and the small
// ▾ opens a picker over qa_tester_names (fetched once) with an "Unassign"
// entry when the report is currently assigned. Assigning writes
// qa_reports.assignee and logs a system event "assigned to <name> by
// <assigner display name>"; unassigning clears it and logs the same way.

import { useEffect, useRef, useState } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';
import { useDisplayName } from '@/lib/display-names';

interface Props {
  reportId: number;
  /** Current qa_reports.assignee (display name) or null. */
  assignee: string | null;
  userEmail: string;
}

export function AssignControl({ reportId, assignee, userEmail }: Props) {
  const myName = useDisplayName(userEmail);
  const [selected, setSelected] = useState(myName);
  const [names, setNames] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Picker options — fetched once per mount, not on every open.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await getBrowserClient()
        .from('qa_tester_names')
        .select('name')
        .order('name');
      if (!cancelled && data) setNames((data as Array<{ name: string }>).map((r) => r.name));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Supabase returns errors as values, not throws — the update MUST be
  // checked or a failed assignment would still log a bogus event.
  async function assign(name: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOpen(false);
    const supabase = getBrowserClient();
    const { error: updateError } = await supabase
      .from('qa_reports')
      .update({ assignee: name })
      .eq('id', reportId);
    if (updateError) {
      setBusy(false);
      setError(`Could not ${name ? 'assign' : 'unassign'} — ${updateError.message}`);
      return;
    }
    const { error: eventError } = await supabase.from('qa_events').insert({
      report_id: reportId,
      type: 'system',
      message: name ? `assigned to ${name} by ${myName}` : `unassigned by ${myName}`,
    });
    setBusy(false);
    if (eventError) setError(`Saved, but logging the event failed — ${eventError.message}`);
  }

  return (
    <div ref={rootRef} className="relative flex-none">
      <div className="flex">
        <button
          onClick={() => void assign(selected)}
          disabled={busy || assignee === selected}
          title={assignee === selected ? `Already assigned to ${selected}` : undefined}
          className="rounded-l-lg border border-r-0 border-qa/40 bg-stage px-3 py-2 text-[12.5px] font-semibold text-qa transition-colors hover:bg-qa-soft disabled:opacity-50"
        >
          Assign to {selected}
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={busy}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Choose who to assign"
          className="rounded-r-lg border border-qa/40 bg-stage px-2 py-2 text-[12.5px] font-semibold text-qa transition-colors hover:bg-qa-soft disabled:opacity-50"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M4 6l4 4 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {open ? (
        <div
          role="listbox"
          aria-label="Assignee"
          className="absolute bottom-full right-0 z-20 mb-1.5 max-h-56 w-44 overflow-y-auto rounded-[10px] border border-line bg-stage py-1 shadow-pop"
        >
          {names === null ? (
            <div className="px-3 py-2 text-[12px] text-ink-3">Loading testers…</div>
          ) : (
            <>
              {names.map((name) => (
                <button
                  key={name}
                  role="option"
                  aria-selected={name === selected}
                  onClick={() => {
                    setSelected(name);
                    void assign(name);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12.5px] font-medium text-ink transition-colors hover:bg-qa-soft"
                >
                  <span className="min-w-0 truncate">{name}</span>
                  {assignee === name ? (
                    <span className="flex-none text-[10.5px] font-semibold text-qa">current</span>
                  ) : null}
                </button>
              ))}
              {assignee ? (
                <button
                  onClick={() => void assign(null)}
                  className="mt-1 w-full border-t border-line-soft px-3 py-1.5 text-left text-[12.5px] font-medium text-red transition-colors hover:bg-red-soft"
                >
                  Unassign
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1.5 text-[11.5px] font-medium text-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
