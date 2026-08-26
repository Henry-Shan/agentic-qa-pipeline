import type { ClickTrailEntry } from '@/lib/types';

/**
 * What the tester actually did, in words.
 *
 * The click trail was already being captured and already drives the replay's
 * step markers — but it was never readable. That left the report as a
 * description with no account of the steps behind it, so anyone reading the task
 * (or reviewing what Claude was told) had to scrub a recording to learn what was
 * clicked. The same data, written out, answers it at a glance.
 */
export function ReportActions({ trail }: { trail: ClickTrailEntry[] }) {
  if (trail.length === 0) return null;

  return (
    <ol className="mt-1.5 flex flex-col gap-1">
      {trail.map((step, i) => {
        // Show a route only when it changes: repeating the same path on every
        // line buries the one thing worth noticing, which is a navigation.
        const movedTo = i === 0 || trail[i - 1]?.route !== step.route ? step.route : null;
        return (
          <li key={`${step.ts}-${i}`} className="flex items-baseline gap-2 text-[13px] text-ink-2">
            <span className="w-4 flex-none text-right font-mono text-[11.5px] text-ink-3 tabular-nums">{i + 1}</span>
            <span className="min-w-0">
              {describe(step)}
              {movedTo ? <span className="ml-1.5 font-mono text-[11.5px] text-ink-3">on {movedTo}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function describe(step: ClickTrailEntry): React.ReactNode {
  const target = label(step);
  if (step.kind === 'input') {
    return (
      <>
        typed {step.value ? <q className="text-ink">{step.value}</q> : 'something'}
        {target ? <> into {target}</> : null}
      </>
    );
  }
  return <>clicked {target ?? <span className="text-ink-3">an unlabelled element</span>}</>;
}

/** The most human name available, falling back through to the raw selector. */
function label(step: ClickTrailEntry): React.ReactNode {
  const text = step.text?.trim();
  if (text) return <span className="font-medium text-ink">{text}</span>;
  if (step.testid) return <code className="font-mono text-[12px] text-ink">{step.testid}</code>;
  if (step.component) return <code className="font-mono text-[12px] text-ink">{step.component}</code>;
  if (step.selector) return <code className="font-mono text-[12px] text-ink-2">{step.selector}</code>;
  return null;
}
