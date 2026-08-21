import type { ReactNode } from 'react';
import { PIPELINE_STAGES, pipeFor } from '@/lib/status';
import type { ReportStatus } from '@/lib/types';

const NOW_TEXT = {
  amber: 'text-amber',
  teal: 'text-qa',
  neutral: 'text-ink-2',
} as const;

const NOW_DOT = {
  amber: 'bg-amber-soft text-amber',
  teal: 'bg-qa-soft text-qa',
  neutral: 'bg-line-soft text-ink-2',
} as const;

const BADGE_CLS = {
  red: 'bg-red-soft text-red',
  gray: 'bg-line-soft text-ink-3',
} as const;

/** Filed → Queued → Fixing → PR ready → Preview → Verified breadcrumb (per CONTRACTS.md). */
export function Pipeline({ status, detail = false }: { status: ReportStatus; detail?: boolean }) {
  const spec = pipeFor(status);
  const stageCount = spec.badge ? spec.done : PIPELINE_STAGES.length;
  const items: ReactNode[] = [];

  for (let i = 0; i < stageCount; i++) {
    const isDone = i < spec.done;
    const isNow = spec.now?.index === i;
    const tone = isNow ? (spec.now?.tone ?? 'neutral') : 'neutral';

    let label: string = PIPELINE_STAGES[i] ?? '';
    if (i === PIPELINE_STAGES.length - 1 && spec.finalLabel) label = spec.finalLabel;
    if (detail && isNow && status === 'preview') label = 'Preview — awaiting your verdict';

    if (i > 0) {
      items.push(
        <span
          key={`link-${i}`}
          className={`mx-1.5 h-px w-5 flex-none ${i <= spec.done ? 'bg-qa-bright' : 'bg-line'}`}
        />,
      );
    }
    items.push(
      <span
        key={`node-${i}`}
        className={`flex items-center gap-1.5 text-[12px] font-medium ${
          isDone ? 'text-ink-2' : isNow ? NOW_TEXT[tone] : 'text-ink-3'
        }`}
      >
        <span
          className={`grid size-4 flex-none place-items-center rounded-full text-[9px] tabular-nums ${
            isDone ? 'bg-qa-soft text-qa' : isNow ? NOW_DOT[tone] : 'bg-line-soft text-ink-3'
          }`}
        >
          {isDone ? '✓' : isNow ? '●' : i + 1}
        </span>
        {label}
      </span>,
    );
  }

  if (spec.badge) {
    items.push(
      <span
        key="badge"
        className={`ml-2 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${BADGE_CLS[spec.badge.tone]}`}
      >
        {spec.badge.label}
      </span>,
    );
  }

  return <div className="mt-2 flex flex-wrap items-center gap-y-2">{items}</div>;
}
