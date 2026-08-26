'use client';

// What the preview is doing, and how long it has been doing it.
//
// There is no honest percentage to show. The worker knows which PHASE it is in
// (queued → installing → compiling → starting) and when that phase began; it
// does not know how far through a bundler is. So this shows the phase, the
// elapsed time, and how long that phase usually takes — which answers "is this
// stuck?", the only question anyone is actually asking — instead of a bar that
// pretends to know and stalls at 90%.

import { useEffect, useState } from 'react';

/** Ordered so the current phase can be located; label + typical duration. */
const PHASES = [
  { key: 'queued', label: 'Queued', match: /queued to build/i, typical: 'starts when a lane frees up' },
  { key: 'deps', label: 'Installing dependencies', match: /dependenc/i, typical: 'about 30 seconds' },
  { key: 'build', label: 'Compiling', match: /compiling/i, typical: '2–5 minutes' },
  { key: 'start', label: 'Starting the server', match: /getting this preview ready|starting/i, typical: 'under a minute' },
] as const;

function phaseOf(detail: string): { index: number; label: string; typical: string } {
  for (let i = 0; i < PHASES.length; i++) {
    const p = PHASES[i]!;
    if (p.match.test(detail)) return { index: i, label: p.label, typical: p.typical };
  }
  return { index: 0, label: 'Preparing', typical: '' };
}

function elapsed(sinceIso: string | null | undefined, now: number): string | null {
  if (!sinceIso) return null;
  const started = Date.parse(sinceIso);
  if (Number.isNaN(started)) return null;
  const secs = Math.max(0, Math.round((now - started) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${String(secs % 60).padStart(2, '0')}s`;
}

export function BuildProgress({ detail, since }: { detail: string; since?: string | null }) {
  // Ticks so the elapsed time is live rather than frozen at page load — the
  // difference between "it is working" and "is this stuck?".
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const phase = phaseOf(detail);
  const took = elapsed(since, now);

  return (
    <div className="mt-3 rounded-[12px] border border-line bg-stage p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <span className="working-dot text-amber" aria-hidden />
          {phase.label}
          {took ? <span className="font-normal tabular-nums text-ink-3">· {took}</span> : null}
        </span>
        {phase.typical ? <span className="text-[11.5px] text-ink-3">usually {phase.typical}</span> : null}
      </div>

      {/* Steps, so it is visible how much is left rather than only where it is. */}
      <ol className="mt-2.5 flex flex-wrap gap-1.5">
        {PHASES.map((p, i) => (
          <li
            key={p.key}
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              i < phase.index
                ? 'bg-green-soft text-green'
                : i === phase.index
                  ? 'bg-amber-soft text-amber'
                  : 'bg-line-soft text-ink-3'
            }`}
          >
            {i < phase.index ? '✓ ' : ''}
            {p.label}
          </li>
        ))}
      </ol>

      <p className="mt-2 text-[12px] leading-[1.5] text-ink-2">{detail}</p>
    </div>
  );
}
