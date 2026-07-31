'use client';

// Presentational pieces of the /canvas world: fixed section containers,
// independent report block pairs (screenshot card + sticky note), and free
// text labels. Interaction (drag/select/edit/delete) lives in canvas-view.tsx
// and reaches these through data-block attributes + the edit props.

import type { FocusEvent, KeyboardEvent, Ref } from 'react';
import { PAIR_GAP, SHOT_H, SHOT_W, STICKY_W, type SectionSpec } from '@/lib/canvas-layout';
import { STATUS_PILL } from '@/lib/status';
import { initialOf, relativeAge } from '@/lib/format';
import { useDisplayName } from '@/lib/display-names';
import { ConfirmDestroy, TrashIcon } from '@/components/confirm-delete';
import type { QaCanvasBlock, QaReport, ReportStatus } from '@/lib/types';

/** In-place editor wiring passed down only while this block is being edited. */
export interface EditProps {
  ref: Ref<HTMLDivElement>;
  /** Text captured at edit start — kept constant so React never clobbers typing. */
  snapshot: string;
  hint?: string;
  onBlur: (e: FocusEvent<HTMLDivElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

/** Board status pill scaled down for sticky meta rows (same mapping as the list). */
function MiniPill({ status }: { status: ReportStatus }) {
  const pill = STATUS_PILL[status];
  return (
    <span
      className={`ml-auto flex flex-none items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[9.5px] font-extrabold ${pill.cls}`}
    >
      {pill.working ? <span className="working-dot" style={{ width: 5, height: 5 }} /> : null}
      {pill.label}
    </span>
  );
}

/** Fixed Figma-style section: tinted rounded rect with a chunky label chip. */
export function SectionBox({ section }: { section: SectionSpec }) {
  return (
    <div
      className="absolute rounded-2xl bg-section"
      style={{ left: section.x, top: section.y, width: section.w, height: section.h }}
      aria-hidden
    >
      <span className="absolute left-3 top-2.5 inline-block rounded-[9px] bg-ink-3/85 px-3 py-1 text-[15px] font-bold leading-[1.4] text-white">
        {section.name}
      </span>
    </div>
  );
}

/**
 * One report = one independent block pair: its screenshot card with its sticky
 * note directly beside it. The whole pair drags/selects as a unit (data-block).
 */
export function BlockPair({
  report,
  x,
  y,
  selected,
  edit,
  confirmingDelete,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  report: QaReport;
  x: number;
  y: number;
  selected: boolean;
  edit: EditProps | null;
  confirmingDelete: boolean;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const done = report.status === 'shipped' || report.status === 'verified';
  const editing = edit !== null;
  const reporter = useDisplayName(report.reporter_email);
  return (
    <div
      data-block={`s${report.id}`}
      className={`group absolute flex items-start rounded-lg ${
        selected ? 'outline outline-[2.5px] outline-offset-4 outline-qa-bright' : ''
      }`}
      style={{ left: x, top: y, gap: PAIR_GAP, zIndex: selected || editing || confirmingDelete ? 10 : undefined }}
    >
      <div
        className={`relative flex-none overflow-hidden rounded-xl border border-line bg-stage shadow-card ${
          done ? 'opacity-60' : ''
        }`}
        style={{ width: SHOT_W }}
      >
        {report.screenshots.length > 0 ? (
          <>
            {/* Signed-URL redirect; plain img on purpose (next/image can't follow it). */}
            <img
              src={`/api/shot/${report.id}`}
              alt={`Screenshot for report ${report.id}`}
              draggable={false}
              className="block w-full object-cover object-top"
              style={{ height: SHOT_H }}
            />
            <span className="absolute right-2 top-2 rounded bg-qa px-1.5 py-px text-[8.5px] font-bold text-on-accent">
              auto-screenshot
            </span>
          </>
        ) : (
          <div
            className="flex flex-col items-center justify-center gap-1 bg-canvas text-ink-3"
            style={{ height: SHOT_H }}
          >
            <span className="text-lg" aria-hidden>
              ▢
            </span>
            <span className="text-[10px]">no screenshot yet</span>
          </div>
        )}
      </div>

      <div
        className={`relative select-none rounded-[4px_4px_12px_4px] px-3 pb-2 pt-2.5 text-[11.5px] leading-[1.45] ${
          report.kind === 'feature'
            ? 'bg-sticky-feat text-sticky-feat-deep'
            : 'bg-sticky-bug text-sticky-bug-deep'
        } ${done ? 'opacity-60' : ''} ${editing ? 'cursor-text shadow-pop' : 'cursor-default shadow-card'}`}
        style={{ width: STICKY_W }}
      >
        <button
          data-pane
          onClick={onRequestDelete}
          aria-label="Delete everything for this report"
          title="Delete everything"
          className="absolute right-1 top-1 grid size-5 place-items-center rounded text-current opacity-0 transition-opacity hover:opacity-100! group-hover:opacity-50"
        >
          <TrashIcon size={12} />
        </button>
        <div
          ref={edit?.ref}
          contentEditable={editing}
          suppressContentEditableWarning
          data-hint={editing ? edit?.hint : undefined}
          onBlur={edit?.onBlur}
          onKeyDown={edit?.onKeyDown}
          className={`pr-4 ${editing ? 'select-text whitespace-pre-wrap outline-none' : 'line-clamp-6 whitespace-pre-wrap'}`}
        >
          {editing ? edit.snapshot : report.description || report.title}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] opacity-90">
          <span className="grid size-4 flex-none place-items-center rounded-full bg-white/60 text-[8.5px] font-extrabold">
            {initialOf(reporter)}
          </span>
          <span className="font-semibold" title={report.reporter_email ?? undefined}>
            {reporter}
          </span>
          <span suppressHydrationWarning>· {relativeAge(report.created_at)}</span>
          <MiniPill status={report.status} />
        </div>
        {confirmingDelete ? (
          <ConfirmDestroy
            className="absolute right-0 top-7 z-30 w-[232px]"
            onConfirm={onConfirmDelete}
            onCancel={onCancelDelete}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Free-floating annotation label (qa_canvas_blocks kind='text'). */
export function TextLabel({
  block,
  x,
  y,
  selected,
  edit,
}: {
  block: QaCanvasBlock;
  x: number;
  y: number;
  selected: boolean;
  edit: EditProps | null;
}) {
  const editing = edit !== null;
  return (
    <div
      data-block={`t${block.id}`}
      className={`absolute min-w-[60px] max-w-[300px] select-none px-1.5 py-1 text-[13px] font-semibold text-ink-2 ${
        selected ? 'rounded outline outline-2 outline-offset-2 outline-qa-bright' : ''
      } ${editing ? 'cursor-text' : 'cursor-default'}`}
      style={{ left: x, top: y, zIndex: selected || editing ? 10 : undefined }}
    >
      <div
        ref={edit?.ref}
        contentEditable={editing}
        suppressContentEditableWarning
        data-hint={editing ? edit?.hint : undefined}
        onBlur={edit?.onBlur}
        onKeyDown={edit?.onKeyDown}
        className={editing ? 'select-text whitespace-pre-wrap outline-none' : 'whitespace-pre-wrap'}
      >
        {editing ? edit.snapshot : (block.text ?? '')}
      </div>
    </div>
  );
}
