'use client';

// The examination (contracts §Examination): after a fix's preview came up, the
// worker replayed the tester's own recorded steps on it and an examiner model —
// which never saw the diff — judged whether the expected result was there.
// Shows the verdict, per-expectation findings, and the frames it read.

import { useState } from 'react';
import type { QaExamination } from '@/lib/types';

const TONE = {
  pass: { pill: 'bg-green-soft text-green', label: 'Examination passed' },
  fail: { pill: 'bg-red-soft text-red', label: 'Examination failed' },
  inconclusive: { pill: 'bg-line-soft text-ink-3', label: 'Examination inconclusive' },
} as const;

export function ExaminationCard({ exam }: { exam: QaExamination }) {
  const [open, setOpen] = useState(exam.verdict !== 'pass');
  const tone = TONE[exam.verdict];

  return (
    <div className="mb-4 rounded-[10px] border border-line bg-stage">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`flex-none rounded-full px-2 py-0.5 text-[10.5px] font-bold ${tone.pill}`}>
          {tone.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{exam.summary}</span>
        <span className="flex-none text-[10.5px] tabular-nums text-ink-3">
          attempt {exam.attempt} · {exam.steps_shown}/{exam.steps_shown + exam.steps_skipped} steps
        </span>
        <span className="flex-none text-[11px] text-ink-3">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="border-t border-line-soft px-3 py-2.5">
          <p className="mb-2 text-[12px] leading-relaxed text-ink-2">{exam.summary}</p>
          {exam.findings.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {exam.findings.map((f, i) => (
                <li key={i} className="flex gap-2 text-[12px]">
                  <span className={`flex-none font-bold ${f.met ? 'text-green' : 'text-red'}`}>
                    {f.met ? '✓' : '✗'}
                  </span>
                  <span className="min-w-0">
                    <span className="text-ink">{f.claim}</span>
                    {f.evidence ? <span className="block text-[11.5px] text-ink-3">{f.evidence}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {exam.shots.length > 0 ? (
            <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-1">
              {exam.shots.map((_, i) => (
                <a
                  key={i}
                  href={`/api/exam-shot/${exam.id}?i=${i}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block flex-none overflow-hidden rounded-md border border-line hover:border-qa-bright"
                  title={i === 0 ? 'start' : `step ${i}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed-URL redirect, not a static asset */}
                  <img
                    src={`/api/exam-shot/${exam.id}?i=${i}`}
                    alt={i === 0 ? 'starting frame' : `frame after step ${i}`}
                    className="h-16 w-auto"
                  />
                </a>
              ))}
            </div>
          ) : null}
          <p className="mt-2 text-[10.5px] text-ink-3">
            Judged by an examiner that never saw the code change — only what the app did.
          </p>
        </div>
      ) : null}
    </div>
  );
}
