'use client';

// /canvas — the living Figma board. Fixed section containers (directory,
// inventory, …), one independent block pair per report (screenshot card +
// sticky note), free text labels, pan/zoom, drag-persist, edit-in-place, and
// add-block tools. Data flows: server-fetched initial state → Supabase
// realtime (5s poll fallback) → optimistic local writes.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getBrowserClient } from '@/lib/supabase/client';
import { useLive } from '@/lib/use-live';
import { latestByReport, upsertReport } from '@/lib/merge';
import {
  PAIR_H,
  PAIR_W,
  SECTION_ROUTE,
  computeSections,
  defaultPairPos,
  sectionAt,
  sectionOf,
} from '@/lib/canvas-layout';
import type { QaCanvasBlock, QaReport, QaRun } from '@/lib/types';
import { ViewSwitch } from '@/components/view-switch';
import { BlockPair, SectionBox, TextLabel, type EditProps } from '@/components/canvas/canvas-items';
import { TaskPane } from '@/components/canvas/task-pane';

type Tool = 'select' | 'sticky' | 'text';

type Selection = { kind: 'sticky'; reportId: number } | { kind: 'text'; blockId: number };

interface DragState {
  mode: 'pan' | 'move';
  key: string | null;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  moved: boolean;
}

const TOOLS: ReadonlyArray<{ key: Tool; label: string; kbd: string }> = [
  { key: 'select', label: '▲ Move', kbd: 'V' },
  { key: 'sticky', label: '▣ Sticky', kbd: 'S' },
  { key: 'text', label: 'T Text', kbd: 'T' },
];

const HINTS: Record<Tool, string> = {
  select: 'Move tool — drag blocks, double-click to edit',
  sticky: 'Click inside a section to drop a note — it files a real report',
  text: 'Click anywhere to add a text label',
};

const STICKY_HINT = 'Describe the bug or the feature idea…';

function upsertBlock(list: QaCanvasBlock[], block: QaCanvasBlock): QaCanvasBlock[] {
  // A pos row is keyed by report_id (temp negative-id rows get replaced by the
  // server row); text rows are keyed by id.
  const next = list.filter(
    (b) => b.id !== block.id && !(block.kind === 'pos' && b.kind === 'pos' && b.report_id === block.report_id),
  );
  next.push(block);
  return next;
}

export function CanvasView({
  initialReports,
  initialRuns,
  initialBlocks,
  userEmail,
}: {
  initialReports: QaReport[];
  initialRuns: QaRun[];
  initialBlocks: QaCanvasBlock[];
  userEmail: string;
}) {
  const [reports, setReports] = useState<QaReport[]>(initialReports);
  const [runs, setRuns] = useState<Record<number, QaRun>>(() => latestByReport(initialRuns));
  const [blocks, setBlocks] = useState<QaCanvasBlock[]>(initialBlocks);
  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState({ x: 10, y: -20, scale: 0.8 });
  const [panning, setPanning] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<{ key: string; snapshot: string } | null>(null);
  const [livePos, setLivePos] = useState<{ key: string; x: number; y: number } | null>(null);
  /** Report id whose "Delete everything?" popover is open. */
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const vpRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const editRef = useRef<HTMLDivElement | null>(null);
  const editCancelRef = useRef(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** Reports/text labels created from this canvas session, still unconfirmed by a first edit. */
  const draftReportIds = useRef(new Set<number>());
  const draftTextIds = useRef(new Set<number>());

  const mergeBlock = useCallback((block: QaCanvasBlock) => {
    setBlocks((prev) => upsertBlock(prev, block));
  }, []);

  // ---------- live data ----------

  const refetch = useCallback(async () => {
    const supabase = getBrowserClient();
    const [reportRes, blockRes] = await Promise.all([
      supabase.from('qa_reports').select('*').order('id', { ascending: false }).limit(100),
      supabase.from('qa_canvas_blocks').select('*').order('id'),
    ]);
    const fresh = (reportRes.data ?? []) as QaReport[];
    if (reportRes.data) setReports(fresh);
    if (blockRes.data) setBlocks(blockRes.data as QaCanvasBlock[]);
    if (fresh.length > 0) {
      const { data: runRows } = await supabase
        .from('qa_runs')
        .select('*')
        .in(
          'report_id',
          fresh.map((r) => r.id),
        )
        .order('id', { ascending: false });
      if (runRows) setRuns(latestByReport(runRows as QaRun[]));
    }
  }, []);

  useLive(
    'qa-canvas',
    [{ table: 'qa_reports' }, { table: 'qa_runs' }, { table: 'qa_canvas_blocks' }],
    (table, row) => {
      if (table === 'qa_reports') {
        setReports((prev) => upsertReport(prev, row as unknown as QaReport));
      } else if (table === 'qa_runs') {
        const run = row as unknown as QaRun;
        setRuns((prev) => {
          const current = prev[run.report_id];
          if (current && current.id > run.id) return prev;
          return { ...prev, [run.report_id]: run };
        });
      } else {
        mergeBlock(row as unknown as QaCanvasBlock);
      }
    },
    () => void refetch(),
    (table, oldRow) => {
      const id = Number(oldRow.id);
      if (!Number.isFinite(id)) return;
      if (table === 'qa_canvas_blocks') setBlocks((prev) => prev.filter((b) => b.id !== id));
      else if (table === 'qa_reports') {
        setReports((prev) => prev.filter((r) => r.id !== id));
        setBlocks((prev) => prev.filter((b) => b.report_id !== id));
      }
    },
  );

  // ---------- derived layout (deterministic; default placement is index-based) ----------

  const active = reports.filter((r) => r.status !== 'cancelled');
  const sections = computeSections(active);
  const sectionByName = new Map(sections.map((s) => [s.name, s]));

  const posByReport = new Map<number, QaCanvasBlock>();
  for (const b of blocks) {
    if (b.kind === 'pos' && b.report_id !== null) posByReport.set(b.report_id, b);
  }

  // Every report keeps its index slot in its section's grid (sorted by id), so
  // slots never reshuffle when a neighbour is dragged away.
  const pairItems: Array<{ report: QaReport; x: number; y: number }> = [];
  const bySection = new Map<ReturnType<typeof sectionOf>, QaReport[]>();
  for (const report of active) {
    const name = sectionOf(report.route);
    const group = bySection.get(name);
    if (group) group.push(report);
    else bySection.set(name, [report]);
  }
  for (const [name, group] of bySection) {
    const section = sectionByName.get(name);
    if (!section) continue;
    group.sort((a, b) => a.id - b.id);
    group.forEach((report, index) => {
      const saved = posByReport.get(report.id);
      const base = saved ? { x: saved.x, y: saved.y } : defaultPairPos(section, index);
      const key = `s${report.id}`;
      const p = livePos?.key === key ? livePos : base;
      pairItems.push({ report, x: p.x, y: p.y });
    });
  }

  const textItems = blocks
    .filter((b) => b.kind === 'text')
    .map((b) => {
      const key = `t${b.id}`;
      const p = livePos?.key === key ? livePos : b;
      return { block: b, x: p.x, y: p.y };
    });

  const posByKey = new Map<string, { x: number; y: number }>();
  for (const s of pairItems) posByKey.set(`s${s.report.id}`, { x: s.x, y: s.y });
  for (const t of textItems) posByKey.set(`t${t.block.id}`, { x: t.x, y: t.y });

  let worldW = 1700;
  let worldH = 900;
  for (const s of sections) {
    worldW = Math.max(worldW, s.x + s.w + 220);
    worldH = Math.max(worldH, s.y + s.h + 220);
  }
  for (const p of pairItems) {
    worldW = Math.max(worldW, p.x + PAIR_W + 220);
    worldH = Math.max(worldH, p.y + PAIR_H + 220);
  }
  for (const t of textItems) {
    worldW = Math.max(worldW, t.x + 340);
    worldH = Math.max(worldH, t.y + 120);
  }

  // ---------- persistence ----------

  function persistStickyPos(reportId: number, x: number, y: number) {
    setBlocks((prev) => {
      const existing = prev.find((b) => b.kind === 'pos' && b.report_id === reportId);
      const next: QaCanvasBlock = existing
        ? { ...existing, x, y, updated_by: userEmail }
        : {
            id: -reportId,
            kind: 'pos',
            report_id: reportId,
            text: null,
            x,
            y,
            updated_by: userEmail,
            updated_at: new Date().toISOString(),
          };
      return upsertBlock(prev, next);
    });
    void getBrowserClient()
      .from('qa_canvas_blocks')
      .upsert({ report_id: reportId, kind: 'pos', x, y, updated_by: userEmail }, { onConflict: 'report_id' })
      .select()
      .single()
      .then(({ data, error }: { data: unknown; error: unknown }) => {
        if (error || !data) void refetch();
        else mergeBlock(data as QaCanvasBlock);
      });
  }

  function persistTextPos(blockId: number, x: number, y: number) {
    setBlocks((prev) => prev.map((b) => (b.id === blockId ? { ...b, x, y, updated_by: userEmail } : b)));
    void getBrowserClient()
      .from('qa_canvas_blocks')
      .update({ x, y, updated_by: userEmail })
      .eq('id', blockId)
      .then(({ error }: { error: unknown }) => {
        if (error) void refetch();
      });
  }

  async function addSticky(wx: number, wy: number) {
    // A canvas sticky is a REAL report: it queues and autofires like any other.
    // The route comes from the SECTION the click lands in.
    const supabase = getBrowserClient();
    const route = SECTION_ROUTE[sectionAt(sections, wx, wy)?.name ?? 'other'];
    const { data, error } = await supabase
      .from('qa_reports')
      .insert({
        kind: 'feature',
        status: 'queued',
        description: '',
        title: 'New note',
        reporter_email: userEmail,
        route,
      })
      .select()
      .single();
    if (error || !data) return;
    const report = data as QaReport;
    draftReportIds.current.add(report.id);
    const x = wx - PAIR_W / 2;
    const y = wy - 20;
    const { data: blockRow } = await supabase
      .from('qa_canvas_blocks')
      .insert({ kind: 'pos', report_id: report.id, x, y, updated_by: userEmail })
      .select()
      .single();
    setReports((prev) => upsertReport(prev, report));
    mergeBlock(
      (blockRow as QaCanvasBlock | null) ?? {
        id: -report.id,
        kind: 'pos',
        report_id: report.id,
        text: null,
        x,
        y,
        updated_by: userEmail,
        updated_at: report.created_at,
      },
    );
    setSelected({ kind: 'sticky', reportId: report.id });
    setEditing({ key: `s${report.id}`, snapshot: '' });
  }

  async function addTextLabel(wx: number, wy: number) {
    const { data, error } = await getBrowserClient()
      .from('qa_canvas_blocks')
      .insert({ kind: 'text', text: 'Label', x: wx, y: wy - 12, updated_by: userEmail })
      .select()
      .single();
    if (error || !data) return;
    const block = data as QaCanvasBlock;
    draftTextIds.current.add(block.id);
    mergeBlock(block);
    setSelected({ kind: 'text', blockId: block.id });
    setEditing({ key: `t${block.id}`, snapshot: block.text ?? '' });
  }

  async function abandonDraftReport(reportId: number) {
    setSelected((s) => (s?.kind === 'sticky' && s.reportId === reportId ? null : s));
    setReports((prev) => prev.filter((r) => r.id !== reportId));
    setBlocks((prev) => prev.filter((b) => b.report_id !== reportId));
    const supabase = getBrowserClient();
    await supabase.from('qa_canvas_blocks').delete().eq('report_id', reportId);
    await supabase.from('qa_reports').delete().eq('id', reportId);
  }

  async function commitStickyEdit(reportId: number, text: string, cancelled: boolean, snapshot: string) {
    const supabase = getBrowserClient();
    if (draftReportIds.current.has(reportId)) {
      draftReportIds.current.delete(reportId);
      if (cancelled || !text) {
        await abandonDraftReport(reportId);
        return;
      }
      const title = text.slice(0, 80);
      setReports((prev) => prev.map((r) => (r.id === reportId ? { ...r, description: text, title } : r)));
      await supabase.from('qa_reports').update({ description: text, title }).eq('id', reportId);
      return;
    }
    if (cancelled || !text || text === snapshot) return;
    const title = text.slice(0, 80);
    setReports((prev) => prev.map((r) => (r.id === reportId ? { ...r, description: text, title } : r)));
    await supabase.from('qa_reports').update({ description: text, title }).eq('id', reportId);
    await supabase
      .from('qa_events')
      .insert({ report_id: reportId, type: 'system', message: `description edited by ${userEmail}` });
  }

  async function deleteTextBlock(blockId: number) {
    draftTextIds.current.delete(blockId);
    setSelected((s) => (s?.kind === 'text' && s.blockId === blockId ? null : s));
    setBlocks((prev) => prev.filter((b) => b.id !== blockId));
    await getBrowserClient().from('qa_canvas_blocks').delete().eq('id', blockId);
  }

  async function commitTextEdit(blockId: number, text: string, cancelled: boolean, snapshot: string) {
    const isDraft = draftTextIds.current.has(blockId);
    draftTextIds.current.delete(blockId);
    if (cancelled && !isDraft) return; // Escape on an existing label → revert
    if (!text || (cancelled && isDraft)) {
      await deleteTextBlock(blockId);
      return;
    }
    if (text === snapshot) return;
    setBlocks((prev) => prev.map((b) => (b.id === blockId ? { ...b, text, updated_by: userEmail } : b)));
    await getBrowserClient()
      .from('qa_canvas_blocks')
      .update({ text, updated_by: userEmail })
      .eq('id', blockId);
  }

  /**
   * "Delete everything" for a report: queue a `destroy` message (the worker
   * tears down the run, PR, worktree, and row) and cancel the report so it
   * disappears from views immediately.
   */
  async function destroyReport(reportId: number) {
    setConfirmDelete(null);
    setSelected((s) => (s?.kind === 'sticky' && s.reportId === reportId ? null : s));
    draftReportIds.current.delete(reportId);
    setReports((prev) => prev.map((r) => (r.id === reportId ? { ...r, status: 'cancelled' as const } : r)));
    const supabase = getBrowserClient();
    await supabase
      .from('qa_messages')
      .insert({ report_id: reportId, kind: 'destroy', author_email: userEmail, body: '' });
    await supabase.from('qa_reports').update({ status: 'cancelled' }).eq('id', reportId);
  }

  const deleteSelected = useCallback(async () => {
    const sel = selectedRef.current;
    if (!sel) return;
    if (sel.kind === 'sticky') {
      // Deleting a report is a full teardown — always route through the confirm popover.
      setConfirmDelete(sel.reportId);
    } else {
      setSelected(null);
      await deleteTextBlock(sel.blockId);
    }
  }, []);

  // ---------- edit-in-place ----------

  function startEdit(key: string) {
    if (key.startsWith('s')) {
      const id = Number(key.slice(1));
      const report = reports.find((r) => r.id === id);
      if (!report) return;
      setSelected({ kind: 'sticky', reportId: id });
      setEditing({ key, snapshot: report.description ?? '' });
    } else {
      const id = Number(key.slice(1));
      const block = blocks.find((b) => b.id === id);
      if (!block) return;
      setSelected({ kind: 'text', blockId: id });
      setEditing({ key, snapshot: block.text ?? '' });
    }
  }

  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  function onEditBlur(e: React.FocusEvent<HTMLDivElement>) {
    const ed = editingRef.current;
    if (!ed) return;
    const text = (e.currentTarget.innerText ?? '').replace(/\u00a0/g, ' ').trim();
    const cancelled = editCancelRef.current;
    editCancelRef.current = false;
    setEditing(null);
    const id = Number(ed.key.slice(1));
    if (ed.key.startsWith('s')) void commitStickyEdit(id, text, cancelled, ed.snapshot.trim());
    else void commitTextEdit(id, text, cancelled, ed.snapshot.trim());
  }

  function onEditKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      editCancelRef.current = true;
      e.currentTarget.blur();
    }
  }

  const editProps = (key: string): EditProps | null =>
    editing?.key === key
      ? {
          ref: editRef,
          snapshot: editing.snapshot,
          hint: key.startsWith('s') ? STICKY_HINT : 'Label…',
          onBlur: onEditBlur,
          onKeyDown: onEditKeyDown,
        }
      : null;

  // ---------- pointer interactions ----------

  function worldPoint(e: { clientX: number; clientY: number }) {
    const rect = vpRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (e.clientX - rect.left - view.x) / view.scale, y: (e.clientY - rect.top - view.y) / view.scale };
  }

  function selectKey(key: string) {
    if (key.startsWith('s')) setSelected({ kind: 'sticky', reportId: Number(key.slice(1)) });
    else setSelected({ kind: 'text', blockId: Number(key.slice(1)) });
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-pane]')) return;
    if (confirmDelete !== null) setConfirmDelete(null);
    const blockEl = target.closest<HTMLElement>('[data-block]');
    const key = blockEl?.dataset.block ?? null;

    if (tool !== 'select' && !key) {
      const p = worldPoint(e);
      if (tool === 'sticky') void addSticky(p.x, p.y);
      else void addTextLabel(p.x, p.y);
      setTool('select');
      return;
    }
    if (key && editingRef.current?.key === key) return; // caret placement inside the editor

    if (key) {
      const base = posByKey.get(key);
      if (!base) return;
      dragRef.current = { mode: 'move', key, startX: e.clientX, startY: e.clientY, origX: base.x, origY: base.y, moved: false };
    } else {
      dragRef.current = { mode: 'pan', key: null, startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y, moved: false };
      setPanning(true);
    }
    vpRef.current?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.mode === 'pan') setView((v) => ({ ...v, x: d.origX + dx, y: d.origY + dy }));
    else if (d.key) setLivePos({ key: d.key, x: d.origX + dx / view.scale, y: d.origY + dy / view.scale });
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (!d) return;
    if (d.mode === 'move' && d.key) {
      if (d.moved) {
        const x = d.origX + (e.clientX - d.startX) / view.scale;
        const y = d.origY + (e.clientY - d.startY) / view.scale;
        if (d.key.startsWith('s')) persistStickyPos(Number(d.key.slice(1)), x, y);
        else persistTextPos(Number(d.key.slice(1)), x, y);
      } else {
        selectKey(d.key);
      }
      setLivePos(null);
    } else if (d.mode === 'pan' && !d.moved) {
      setSelected(null);
      if (editingRef.current) (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  function onDoubleClick(e: React.MouseEvent) {
    const blockEl = (e.target as HTMLElement).closest<HTMLElement>('[data-block]');
    const key = blockEl?.dataset.block;
    if (!key || editingRef.current?.key === key) return;
    e.preventDefault();
    startEdit(key);
  }

  // ---------- keyboard ----------

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'v') setTool('select');
      else if (k === 's') setTool('sticky');
      else if (k === 't') setTool('text');
      else if (k === 'escape') {
        setConfirmDelete(null);
        setSelected(null);
      } else if ((k === 'delete' || k === 'backspace') && selectedRef.current) {
        e.preventDefault();
        void deleteSelected();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelected]);

  // ---------- render ----------

  const zoom = (delta: number) =>
    setView((v) => ({ ...v, scale: Math.min(1.4, Math.max(0.4, Math.round((v.scale + delta) * 10) / 10)) }));

  const paneReport =
    selected?.kind === 'sticky' ? (reports.find((r) => r.id === selected.reportId) ?? null) : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5 rounded-t-[14px] border border-b-0 border-line bg-stage px-3 py-2">
        <ViewSwitch active="canvas" />
        <div className="flex gap-0.5 rounded-[9px] border border-line p-0.5" role="toolbar" aria-label="Canvas tools">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTool(t.key)}
              aria-pressed={tool === t.key}
              className={`flex items-center gap-1.5 rounded-[7px] px-3 py-1 text-[12.5px] font-semibold transition-colors ${
                tool === t.key ? 'bg-qa text-on-accent' : 'text-ink-2 hover:text-ink'
              }`}
            >
              {t.label}
              <kbd
                className={`rounded border px-1 font-sans text-[10px] ${
                  tool === t.key ? 'border-white/40 text-white/80' : 'border-line text-ink-3'
                }`}
              >
                {t.kbd}
              </kbd>
            </button>
          ))}
        </div>
        <span className="ml-auto hidden text-[11.5px] text-ink-3 lg:inline">{HINTS[tool]}</span>
        <div className="ml-auto flex items-center rounded-lg border border-line lg:ml-0">
          <button onClick={() => zoom(-0.1)} aria-label="Zoom out" className="h-[26px] w-7 text-[15px] text-ink-2 hover:text-ink">
            −
          </button>
          <span className="min-w-[42px] text-center text-[11.5px] tabular-nums text-ink-3">
            {Math.round(view.scale * 100)}%
          </span>
          <button onClick={() => zoom(0.1)} aria-label="Zoom in" className="h-[26px] w-7 text-[15px] text-ink-2 hover:text-ink">
            ＋
          </button>
        </div>
        <Link
          href="/capture"
          className="inline-flex flex-none items-center gap-1.5 rounded-lg bg-qa px-3.5 py-1.5 text-[12.5px] font-bold text-on-accent shadow-card transition-colors hover:bg-qa-bright"
        >
          ＋ Report an issue
        </Link>
      </div>

      <div
        ref={vpRef}
        role="application"
        aria-label="Canvas board — drag to pan, V/S/T tools, double-click a sticky to edit"
        className={`relative h-[max(480px,calc(100dvh-192px))] overflow-hidden rounded-b-[14px] border border-line bg-canvas shadow-card ${
          tool !== 'select' ? 'cursor-crosshair' : panning ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          backgroundImage: 'radial-gradient(color-mix(in srgb, var(--ink-3) 16%, transparent) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <div
          className="absolute left-0 top-0 select-none"
          style={{
            width: worldW,
            height: worldH,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: '0 0',
            touchAction: 'none',
          }}
        >
          {sections.map((s) => (
            <SectionBox key={s.name} section={s} />
          ))}

          {pairItems.map((p) => (
            <BlockPair
              key={p.report.id}
              report={p.report}
              x={p.x}
              y={p.y}
              selected={selected?.kind === 'sticky' && selected.reportId === p.report.id}
              edit={editProps(`s${p.report.id}`)}
              confirmingDelete={confirmDelete === p.report.id}
              onRequestDelete={() => setConfirmDelete(p.report.id)}
              onConfirmDelete={() => void destroyReport(p.report.id)}
              onCancelDelete={() => setConfirmDelete(null)}
            />
          ))}

          {textItems.map((t) => (
            <TextLabel
              key={t.block.id}
              block={t.block}
              x={t.x}
              y={t.y}
              selected={selected?.kind === 'text' && selected.blockId === t.block.id}
              edit={editProps(`t${t.block.id}`)}
            />
          ))}

          {active.length === 0 && textItems.length === 0 ? (
            <div className="absolute text-[13px] text-ink-3" style={{ left: 250, top: 20 }}>
              No reports yet — press <b className="text-ink-2">S</b> and click inside a section to drop a note, or
              file one from the widget.
            </div>
          ) : null}
        </div>

        {paneReport && paneReport.status !== 'cancelled' ? (
          <TaskPane
            report={paneReport}
            run={runs[paneReport.id] ?? null}
            userEmail={userEmail}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
