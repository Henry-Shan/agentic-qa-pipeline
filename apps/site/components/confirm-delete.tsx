'use client';

// "Delete everything" confirm popover — a small white card used by the task
// page danger button. The confirmed action (queue a `destroy` message +
// cancel the report) lives in the caller.

export function TrashIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export function ConfirmDestroy({
  className = '',
  busy = false,
  onConfirm,
  onCancel,
}: {
  /** Positioning (absolute placement, width) supplied by the caller. */
  className?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-pane
      role="alertdialog"
      aria-label="Delete everything?"
      onPointerDown={(e) => e.stopPropagation()}
      className={`rounded-xl border border-line bg-stage p-3 text-left shadow-pop ${className}`}
    >
      <div className="text-[12.5px] font-bold text-ink">Delete everything?</div>
      <p className="mt-1 text-[11.5px] leading-[1.5] text-ink-2">
        Removes the code changes, PR, worktree, and this item. This can&apos;t be undone.
      </p>
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-line bg-stage px-3 py-1.5 text-[11.5px] font-semibold text-ink-2 transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="rounded-lg bg-red px-3 py-1.5 text-[11.5px] font-bold text-on-accent transition-colors hover:opacity-90 disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
