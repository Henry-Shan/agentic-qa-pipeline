// Shared assignment label (contracts § Auto-assign on block · § "Assigned to
// me"). `qa_reports.assignee` already holds a tester DISPLAY NAME — the same
// identity every other surface shows — so resolution here is just the null
// case: an unassigned report reads "unassigned" rather than blank. Used by the
// board's "Assigned to me" rows and the task page's blocked hand-off card, so
// the two never drift. No hooks: safe in server and client components alike.

/** "<name> is on it", or "unassigned" when nobody owns the report. */
export function assignmentLabel(assignee: string | null): string {
  return assignee ? `${assignee} is on it` : 'unassigned';
}

export function AssigneeChip({
  assignee,
  className = '',
}: {
  assignee: string | null;
  className?: string;
}) {
  return (
    <span
      title={assignee ? `Assigned to ${assignee}` : 'Nobody is assigned yet'}
      className={`flex-none rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
        assignee ? 'bg-qa-soft text-qa' : 'bg-line-soft text-ink-3'
      } ${className}`}
    >
      {assignmentLabel(assignee)}
    </span>
  );
}
