'use client';

// Presentational pieces of the /canvas world: screen frames, report stickies,
// free text labels. Interaction (drag/select/edit) lives in canvas-view.tsx and
// reaches these through data-block attributes + the edit props.

import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type Ref } from 'react';
import { FRAME_Y, type FrameSpec } from '@/lib/canvas-layout';
import { STATUS_PILL } from '@/lib/status';
import { initialOf, nameOf, relativeAge } from '@/lib/format';
import type { QaCanvasBlock, QaReport, ReportStatus } from '@/lib/types';

export type SizeReporter = (key: string, w: number, h: number) => void;

/** In-place editor wiring passed down only while this block is being edited. */
export interface EditProps {
  ref: Ref<HTMLDivElement>;
  /** Text captured at edit start — kept constant so React never clobbers typing. */
  snapshot: string;
  hint?: string;
  onBlur: (e: FocusEvent<HTMLDivElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

/** Reports the element's layout size (unscaled world units) for wire geometry. */
function useMeasured(key: string, onSize: SizeReporter) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onSize(key, el.offsetWidth, el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [key, onSize]);
  return ref;
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

/** One screen per route: newest widget screenshot (or a placeholder) + open count. */
export function ScreenFrame({ frame, onSize }: { frame: FrameSpec; onSize: SizeReporter }) {
  const ref = useMeasured(`f${frame.route}`, onSize);
  return (
    <div
      ref={ref}
      className="absolute w-[240px] overflow-hidden rounded-[18px] border border-line bg-stage shadow-pop"
      style={{ left: frame.x, top: FRAME_Y }}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate font-mono text-[11px] font-semibold">{frame.route}</span>
        <span className="flex-none rounded-full bg-qa-soft px-2 py-0.5 text-[10px] font-bold tabular-nums text-qa">
          {frame.openCount} open
        </span>
      </div>
      {frame.shotReportId !== null ? (
        <div className="relative border-t border-line-soft">
          {/* Signed-URL redirect; plain img on purpose (next/image can't follow it). */}
          <img
            src={`/api/shot/${frame.shotReportId}`}
            alt={`Latest screenshot for ${frame.route}`}
            draggable={false}
            className="block w-full"
          />
          <span className="absolute right-2 top-2 rounded bg-qa px-1.5 py-px text-[8.5px] font-bold text-on-accent">
            auto-screenshot
          </span>
        </div>
      ) : (
        <div className="flex h-[300px] flex-col items-center justify-center gap-1.5 border-t border-line-soft bg-canvas text-ink-3">
          <span className="text-lg" aria-hidden>
            ▢
          </span>
          <span className="font-mono text-[11px]">{frame.route}</span>
          <span className="text-[10px]">no screenshot yet</span>
        </div>
      )}
    </div>
  );
}

/** One sticky per report — coral bug / purple feature, live status pill. */
export function StickyNote({
  report,
  x,
  y,
  selected,
  edit,
  onSize,
}: {
  report: QaReport;
  x: number;
  y: number;
  selected: boolean;
  edit: EditProps | null;
  onSize: SizeReporter;
}) {
  const ref = useMeasured(`s${report.id}`, onSize);
  const done = report.status === 'shipped' || report.status === 'verified';
  const editing = edit !== null;
  return (
    <div
      ref={ref}
      data-block={`s${report.id}`}
      className={`absolute w-[200px] select-none rounded-[4px_4px_12px_4px] px-3 pb-2 pt-2.5 text-[11.5px] leading-[1.45] ${
        report.kind === 'feature'
          ? 'bg-sticky-feat text-sticky-feat-deep'
          : 'bg-sticky-bug text-sticky-bug-deep'
      } ${done ? 'opacity-60' : ''} ${
        selected ? 'outline outline-[2.5px] outline-offset-2 outline-qa-bright' : ''
      } ${editing ? 'cursor-text shadow-pop' : 'cursor-default shadow-card'}`}
      style={{ left: x, top: y, zIndex: selected || editing ? 10 : undefined }}
    >
      <div
        ref={edit?.ref}
        contentEditable={editing}
        suppressContentEditableWarning
        data-hint={editing ? edit?.hint : undefined}
        onBlur={edit?.onBlur}
        onKeyDown={edit?.onKeyDown}
        className={editing ? 'select-text whitespace-pre-wrap outline-none' : 'line-clamp-6 whitespace-pre-wrap'}
      >
        {editing ? edit.snapshot : report.description || report.title}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] opacity-90">
        <span className="grid size-4 flex-none place-items-center rounded-full bg-white/60 text-[8.5px] font-extrabold">
          {initialOf(report.reporter_email)}
        </span>
        <span className="font-semibold">{nameOf(report.reporter_email)}</span>
        <span suppressHydrationWarning>· {relativeAge(report.created_at)}</span>
        <MiniPill status={report.status} />
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
