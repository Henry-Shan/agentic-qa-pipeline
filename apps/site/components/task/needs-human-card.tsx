'use client';

// Prominent amber hand-off card shown on the task page whenever the report is
// `blocked` (contracts § Needs-a-human). It carries the ASSIGNMENT next to the
// heading — "<name> is on it", or "unassigned" if somehow null — because the
// worker auto-assigns the moment a report blocks (contracts § Auto-assign on
// block), so this is where the human reading the hand-off learns whose it is.
//
// The card must answer two questions every time: what went wrong, and what to
// do about it. When the worker wrote a needs_human summary it answers both —
// the code lane writes "What went wrong / What I analyzed / What to do", the
// infra lane writes a runbook ("Confirm it / Fix it / Verify / Careful"). When
// it did NOT — a run that died mid-flight never reaches the hand-off step — the
// card used to say only "the details are in Claude's log below", which is a
// dead end: the reader is told they are needed and not what for. So we diagnose
// from the run itself and always offer the next actions.

import { useDisplayName } from '@/lib/display-names';
import { AssigneeChip } from '@/components/assignee-chip';
import { NeedsHumanText } from '@/components/needs-human-text';
import { RerunTask } from '@/components/task/rerun-task';
import type { QaEvent, QaReport, QaRun } from '@/lib/types';

export function NeedsHumanCard({
  report,
  event,
  run,
  events = [],
}: {
  report: QaReport;
  event: QaEvent | null;
  run?: QaRun | null;
  events?: QaEvent[];
}) {
  const reporter = useDisplayName(report.reporter_email);
  const fallback = event ? null : diagnose(run ?? null, events);

  return (
    <div className="mb-4 rounded-[14px] border border-amber/30 bg-amber-soft/50 p-4 shadow-card">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="working-dot flex-none text-amber" aria-hidden />
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-amber">
          Needs {report.reporter_email ? reporter : 'a human'}
        </h2>
        <AssigneeChip assignee={report.assignee} />
      </div>

      {event ? (
        <NeedsHumanText text={event.message ?? ''} />
      ) : fallback ? (
        <div className="space-y-1 text-[12.5px] leading-[1.55] text-ink-2">
          <p>
            <strong className="font-semibold text-ink">What went wrong</strong> {fallback.problem}
          </p>
          <p className="pt-1">
            <strong className="font-semibold text-ink">What to do</strong>
          </p>
          {fallback.steps.map((step, i) => (
            <div key={i} className="flex gap-1.5 pl-2">
              <span className="flex-none font-semibold tabular-nums text-amber">{i + 1}.</span>
              <span className="min-w-0">{step}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Re-running is the one action that always applies, and it is the answer
          for an interrupted run — so put it in the card rather than making the
          reader hunt for it further down the page. */}
      <div className="mt-3">
        <RerunTask reportId={report.id} label="Re-run this task" />
      </div>
    </div>
  );
}

/**
 * Work out what to tell the reader when the worker left no summary.
 *
 * Ordered most-specific first. The interrupted case matters most: a run whose
 * process vanished did not fail on the merits — the Mac slept or the worker
 * restarted — and telling someone to debug a task that was never actually tried
 * wastes their time.
 */
function diagnose(run: QaRun | null, events: QaEvent[]): { problem: string; steps: string[] } {
  const reason = run?.stopped_reason ?? '';
  const lastError = [...events].reverse().find((e) => e.type === 'error')?.message ?? '';
  const question = [...events].reverse().find((e) => e.type === 'question')?.message ?? '';
  const detached = /exited while detached|went to sleep|worker (stopped|restarted)/i.test(`${reason} ${lastError}`);

  if (detached) {
    return {
      problem:
        'The run stopped part-way because the machine went to sleep or the worker restarted — not because anything is wrong with this task. No fix was attempted, so there is nothing to review yet.',
      steps: [
        'Re-run it with the button below. It starts fresh from the report and needs nothing from you.',
        'If you would rather keep the work already done, open the Terminal on this page and resume the session there.',
      ],
    };
  }

  if (question) {
    return {
      problem: `Claude asked a question and stopped until it is answered: “${trim(question, 200)}”`,
      steps: [
        'Answer it in "Talk to Claude" on the right. The run resumes with your reply.',
        'If the question no longer matters, re-run the task instead.',
      ],
    };
  }

  if (reason) {
    return {
      problem: trim(reason, 300),
      steps: [
        'Read Claude\'s log below for the last thing it tried.',
        'Reply in "Talk to Claude" with the missing decision or context, and the run continues from there.',
        'Or re-run the task if the report itself needs to be tried again from scratch.',
      ],
    };
  }

  return {
    problem:
      'Claude stopped and handed this to a person, but did not leave a summary — which usually means it ended before it could write one.',
    steps: [
      'Read Claude\'s log below; the last few lines say where it stopped.',
      'Reply in "Talk to Claude" to resume the same session with more context.',
      'Or re-run the task to start over from the report.',
    ],
  };
}

function trim(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
