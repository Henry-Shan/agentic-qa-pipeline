'use client';

// A QA Doc (contracts §QA Docs): editable title/description, ordered sections.
// Each section is a dispatchable unit — description + captured app context +
// ⏺ recording — and, once dispatched, tracks its report live (same realtime
// channel as the board). Edits save on blur straight through tester RLS.

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { Pipeline } from '@/components/pipeline';
import { StatusPill } from '@/components/status-pill';
import { ReplayPlayer } from '@/components/task/replay-player';
import { getBrowserClient } from '@/lib/supabase/client';
import { useLive } from '@/lib/use-live';
import type { QaDoc, QaDocSection, QaReport } from '@/lib/types';

interface Props {
  initialDoc: QaDoc;
  initialSections: QaDocSection[];
  initialReports: QaReport[];
}

const dotFor = (report: QaReport | null | undefined, hasContext: boolean): string => {
  if (!report) return hasContext ? 'bg-qa-bright/50' : 'bg-line';
  switch (report.status) {
    case 'verified':
    case 'shipped':
      return 'bg-green';
    case 'blocked':
    case 'failed':
      return 'bg-red';
    case 'pr_ready':
    case 'preview':
      return 'bg-qa-bright';
    default:
      return 'bg-amber';
  }
};

export function DocView({ initialDoc, initialSections, initialReports }: Props) {
  const [doc, setDoc] = useState(initialDoc);
  const [sections, setSections] = useState(initialSections);
  const [reports, setReports] = useState<Record<number, QaReport>>(() =>
    Object.fromEntries(initialReports.map((r) => [r.id, r])),
  );

  const supabase = getBrowserClient();

  const refetch = useCallback(() => {
    void (async () => {
      const { data: sectionRows } = await supabase
        .from('qa_doc_sections')
        .select('*')
        .eq('doc_id', doc.id)
        .order('position', { ascending: true });
      if (sectionRows) setSections(sectionRows as QaDocSection[]);
    })();
  }, [supabase, doc.id]);

  useLive(
    `doc-${doc.id}`,
    [
      { table: 'qa_doc_sections', filter: `doc_id=eq.${doc.id}` },
      { table: 'qa_reports' },
      { table: 'qa_docs', filter: `id=eq.${doc.id}` },
    ],
    (table, row) => {
      if (table === 'qa_doc_sections') {
        const section = row as unknown as QaDocSection;
        setSections((prev) => {
          const idx = prev.findIndex((s) => s.id === section.id);
          const next = idx >= 0 ? prev.map((s) => (s.id === section.id ? section : s)) : [...prev, section];
          return next.slice().sort((a, b) => a.position - b.position);
        });
      } else if (table === 'qa_reports') {
        const report = row as unknown as QaReport;
        setReports((prev) => (prev[report.id] || report.doc_section_id ? { ...prev, [report.id]: report } : prev));
      } else if (table === 'qa_docs') {
        setDoc(row as unknown as QaDoc);
      }
    },
    refetch,
    (table, oldRow) => {
      if (table === 'qa_doc_sections') {
        const id = (oldRow as { id?: number }).id;
        if (id) setSections((prev) => prev.filter((s) => s.id !== id));
      }
    },
  );

  const patchDoc = (patch: Partial<Pick<QaDoc, 'title' | 'description' | 'emoji'>>) => {
    setDoc((d) => ({ ...d, ...patch }));
    void supabase.from('qa_docs').update(patch).eq('id', doc.id);
  };

  const patchSection = (id: number, patch: Partial<QaDocSection>) => {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    void supabase.from('qa_doc_sections').update(patch).eq('id', id);
  };

  const addSection = async () => {
    const last = sections[sections.length - 1];
    const { data } = await supabase
      .from('qa_doc_sections')
      .insert({ doc_id: doc.id, position: (last?.position ?? 0) + 1, title: '', body: '' })
      .select('*')
      .single();
    if (data) setSections((prev) => [...prev, data as QaDocSection]);
  };

  const move = (id: number, dir: -1 | 1) => {
    const idx = sections.findIndex((s) => s.id === id);
    const other = sections[idx + dir];
    const self = sections[idx];
    if (!self || !other) return;
    // Swap positions; realtime echoes will keep everyone else in sync.
    patchSection(self.id, { position: other.position });
    patchSection(other.id, { position: self.position });
    setSections((prev) => prev.slice().sort((a, b) => a.position - b.position));
  };

  const remove = (id: number) => {
    setSections((prev) => prev.filter((s) => s.id !== id));
    void supabase.from('qa_doc_sections').delete().eq('id', id);
  };

  const shipped = useMemo(
    () =>
      sections.filter((s) => {
        const r = s.report_id !== null ? reports[s.report_id] : null;
        return r && (r.status === 'verified' || r.status === 'shipped');
      }).length,
    [sections, reports],
  );

  return (
    <div className="flex flex-col gap-0 md:flex-row md:gap-6">
      {/* TOC */}
      <nav aria-label="Sections" className="hidden w-44 flex-none md:block">
        <div className="sticky top-20">
          <div className="mb-2 text-[9.5px] font-bold uppercase tracking-[0.07em] text-ink-3">
            Sections · {shipped}/{sections.length} shipped
          </div>
          <ul className="flex flex-col gap-0.5">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#section-${s.id}`}
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-ink-3 hover:bg-surface"
                >
                  <span
                    className={`size-1.5 flex-none rounded-full ${dotFor(
                      s.report_id !== null ? reports[s.report_id] : null,
                      Boolean(s.route || s.replay_path),
                    )}`}
                  />
                  <span className="truncate">{s.title || 'untitled'}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-start gap-2.5">
          <span className="text-[22px] leading-tight">{doc.emoji || '📄'}</span>
          <div className="min-w-0 flex-1">
            <input
              defaultValue={doc.title}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== doc.title) patchDoc({ title: v });
              }}
              aria-label="Doc title"
              className="w-full bg-transparent text-[18px] font-bold tracking-[-0.01em] focus:outline-none"
            />
            <div className="text-[11px] text-ink-3">
              {doc.created_by ?? 'unknown'} · <Link href="/docs" className="text-qa hover:underline">all docs</Link>
            </div>
          </div>
        </div>
        <textarea
          defaultValue={doc.description}
          onBlur={(e) => {
            if (e.target.value !== doc.description) patchDoc({ description: e.target.value });
          }}
          placeholder="What is this doc about?"
          aria-label="Doc description"
          rows={2}
          className="mb-2 w-full resize-none bg-transparent text-[12.5px] text-ink-2 placeholder:text-ink-3 focus:outline-none"
        />

        {sections.map((s, idx) => (
          <SectionCard
            key={s.id}
            section={s}
            report={s.report_id !== null ? (reports[s.report_id] ?? null) : null}
            first={idx === 0}
            last={idx === sections.length - 1}
            onPatch={(patch) => patchSection(s.id, patch)}
            onMove={(dir) => move(s.id, dir)}
            onRemove={() => remove(s.id)}
            onDispatched={(report) => {
              setReports((prev) => ({ ...prev, [report.id]: report }));
              setSections((prev) => prev.map((x) => (x.id === s.id ? { ...x, report_id: report.id } : x)));
            }}
          />
        ))}

        <button
          type="button"
          onClick={() => void addSection()}
          className="mt-3.5 w-full rounded-[9px] border border-dashed border-line px-3 py-2.5 text-center text-[12px] text-ink-3 transition-colors hover:border-qa-bright hover:text-qa"
        >
          ＋ Add a section
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SectionCard({
  section,
  report,
  first,
  last,
  onPatch,
  onMove,
  onRemove,
  onDispatched,
}: {
  section: QaDocSection;
  report: QaReport | null;
  first: boolean;
  last: boolean;
  onPatch: (patch: Partial<QaDocSection>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onDispatched: (report: QaReport) => void;
}) {
  const [showReplay, setShowReplay] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const dispatched = section.report_id !== null;
  const stepCount = section.click_trail?.length ?? 0;

  const dispatch = async () => {
    if (dispatching || dispatched) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      const res = await fetch('/api/docs/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sectionId: section.id }),
      });
      const out = (await res.json()) as { id?: number; error?: string };
      if (!res.ok || !out.id) throw new Error(out.error ?? `dispatch ${res.status}`);
      // Minimal local report so the pill flips immediately; realtime fills it in.
      onDispatched({ id: out.id, status: 'queued' } as QaReport);
    } catch (e) {
      setDispatchError((e as Error).message);
    } finally {
      setDispatching(false);
    }
  };

  return (
    <section id={`section-${section.id}`} className="mt-3.5 rounded-[9px] border border-line bg-stage">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex flex-none flex-col text-[9px] leading-[0.8] text-ink-3/60">
          <button type="button" disabled={first} onClick={() => onMove(-1)} aria-label="Move section up" className="hover:text-qa disabled:opacity-30">▲</button>
          <button type="button" disabled={last} onClick={() => onMove(1)} aria-label="Move section down" className="hover:text-qa disabled:opacity-30">▼</button>
        </span>
        <input
          defaultValue={section.title}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== section.title) onPatch({ title: v });
          }}
          placeholder="Section title…"
          aria-label="Section title"
          className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold placeholder:font-normal placeholder:text-ink-3 focus:outline-none"
        />
        {report ? (
          <StatusPill status={report.status} />
        ) : (
          <button
            type="button"
            onClick={() => onPatch({ kind: section.kind === 'bug' ? 'feature' : 'bug' })}
            title="Toggle bug / feature"
            className="flex-none rounded-full bg-line-soft px-2 py-0.5 text-[10.5px] font-semibold text-ink-3 hover:text-ink"
          >
            {section.kind}
          </button>
        )}
        {!dispatched &&
          (confirmDelete ? (
            <button type="button" onClick={onRemove} className="flex-none rounded px-1.5 text-[10.5px] font-semibold text-red">
              delete?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              onBlur={() => setConfirmDelete(false)}
              aria-label="Delete section"
              className="flex-none rounded px-1 text-[13px] text-ink-3/60 hover:text-red"
            >
              ×
            </button>
          ))}
      </div>

      <div className="px-3 pb-2.5 pl-8">
        <textarea
          defaultValue={section.body}
          onBlur={(e) => {
            if (e.target.value !== section.body) onPatch({ body: e.target.value });
          }}
          placeholder="Describe the work — this text is exactly what Claude receives."
          aria-label="Section description"
          rows={Math.max(2, Math.min(8, section.body.split('\n').length))}
          className="mb-2 w-full resize-y bg-transparent text-[12px] leading-relaxed text-ink-2 placeholder:text-ink-3 focus:outline-none"
        />

        <div className="flex flex-wrap items-center gap-1.5">
          {section.route ? (
            <span className="rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
              <span className="text-ink-3">at </span>
              {section.route}
            </span>
          ) : null}
          {section.component ? (
            <span className="rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
              {section.component}
            </span>
          ) : null}
          {section.replay_path || stepCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowReplay((v) => !v)}
              disabled={!section.replay_path}
              className="rounded-md border border-line bg-paper px-1.5 py-0.5 text-[10.5px] text-ink-2 hover:border-qa-bright disabled:cursor-default"
            >
              ⏺ {stepCount} step{stepCount === 1 ? '' : 's'}
              {section.replay_path ? (showReplay ? ' · hide' : ' · play') : ''}
            </button>
          ) : null}

          <Link
            href={`/doc-capture/${section.id}`}
            className="rounded-md border border-line bg-paper px-2 py-0.5 text-[10.5px] font-semibold text-ink-2 hover:border-qa-bright hover:text-qa"
          >
            ⌖ {section.route ? 'Re-capture context' : 'Attach context from the app'}
          </Link>

          {report ? (
            <Link
              href={`/task/${report.id}`}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-line bg-paper px-2 py-0.5 text-[11px] font-semibold text-ink-2 hover:border-qa-bright"
            >
              task <span className="font-mono text-[10.5px] text-qa">#{report.id}</span> ↗
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => void dispatch()}
              disabled={dispatching || !(section.title.trim() || section.body.trim())}
              className="ml-auto rounded-md bg-qa px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-qa-bright disabled:opacity-40"
            >
              {dispatching ? 'Dispatching…' : 'Send to Claude ▸'}
            </button>
          )}
        </div>
        {dispatchError ? <div className="mt-1.5 text-[11px] text-red">{dispatchError}</div> : null}

        {report ? (
          <div className="mt-2 overflow-x-auto">
            <Pipeline status={report.status} />
          </div>
        ) : null}

        {showReplay && section.replay_path ? (
          <div className="mt-2.5">
            <ReplayPlayer
              reportId={0}
              fetchUrl={`/api/doc-replay/${section.id}`}
              label={`⏺ recorded for “${section.title || 'this section'}”`}
              steps={section.click_trail ?? []}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
