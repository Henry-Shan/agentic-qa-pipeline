import { Fragment } from 'react';
import type { GroundingChip } from '@/lib/types';

/** Full-stack trace chips from qa_runs.grounding; the last hop is the "deep" one. */
export function GroundingChips({ chips }: { chips: GroundingChip[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip, i) => (
        <Fragment key={`${chip.label}-${i}`}>
          {i > 0 ? <span className="text-[11px] text-ink-3">→</span> : null}
          <span
            className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
              i === chips.length - 1
                ? 'border-transparent bg-qa-soft font-semibold text-qa'
                : 'border-line-soft bg-paper text-ink-2'
            }`}
          >
            {chip.label}
            {chip.file ? <span className="opacity-70"> · {chip.file}</span> : null}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
