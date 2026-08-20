'use client';

import { useEffect, useRef, useState } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';

const FIELDS = [
  { key: 'max_runs', label: 'Parallel runs', hint: 'Claude fixes running at once · 0 pauses new claims', max: 10 },
  { key: 'max_previews', label: 'Live previews', hint: 'preview servers kept up at once', max: 10 },
] as const;

type Values = Record<string, number | null>;

/**
 * Gear popover editing qa_settings (worker limits). Writes go straight to the
 * table via the tester RLS policy; the worker picks them up within ~10s.
 */
export function WorkerSettings({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>({});
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const { data, error: err } = await getBrowserClient().from('qa_settings').select('key, value');
      if (cancelled) return;
      if (err) {
        setError('could not load settings');
        return;
      }
      const next: Values = {};
      for (const row of (data ?? []) as Array<{ key: string; value: number }>) next[row.key] = row.value;
      setValues(next);
      setError(null);
    })();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      cancelled = true;
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const nudge = (key: string, delta: number, max: number) => {
    const cur = values[key];
    if (cur === null || cur === undefined) return;
    const next = Math.min(max, Math.max(0, cur + delta));
    if (next === cur) return;
    setValues((v) => ({ ...v, [key]: next }));
    void (async () => {
      const { error: err } = await getBrowserClient()
        .from('qa_settings')
        .upsert({ key, value: next, updated_by: email });
      if (err) {
        setValues((v) => ({ ...v, [key]: cur }));
        setError('save failed — retry');
      } else {
        setError(null);
      }
    })();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Worker settings"
        aria-label="Worker settings"
        className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-line/50 hover:text-ink-1"
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8" cy="8" r="2.4" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 w-64 rounded-lg border border-line bg-stage p-3 shadow-lg">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Worker limits</div>
          {FIELDS.map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-3 py-1.5">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium">{f.label}</div>
                <div className="text-[11px] text-ink-3">{f.hint}</div>
              </div>
              <div className="flex flex-none items-center gap-1">
                <button
                  type="button"
                  onClick={() => nudge(f.key, -1, f.max)}
                  disabled={values[f.key] == null}
                  aria-label={`decrease ${f.label}`}
                  className="grid size-6 place-items-center rounded border border-line text-[13px] hover:bg-line/50 disabled:opacity-40"
                >
                  −
                </button>
                <span className="w-6 text-center text-[13px] font-semibold tabular-nums">
                  {values[f.key] ?? '·'}
                </span>
                <button
                  type="button"
                  onClick={() => nudge(f.key, 1, f.max)}
                  disabled={values[f.key] == null}
                  aria-label={`increase ${f.label}`}
                  className="grid size-6 place-items-center rounded border border-line text-[13px] hover:bg-line/50 disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>
          ))}
          <div className="mt-1.5 text-[11px] text-ink-3">
            {error ?? 'Applies to the running worker within ~10s.'}
          </div>
        </div>
      )}
    </div>
  );
}
