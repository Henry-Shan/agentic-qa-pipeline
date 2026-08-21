'use client';

// A QA Doc (contracts §QA Docs): editable title/description, ordered sections.
// Each section is a dispatchable unit — description + captured app context +
// ⏺ recording — and, once dispatched, tracks its report live (same realtime
// channel as the board). Edits save on blur straight through tester RLS.

import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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

/** What is behind the toggle, said in one line — never "Details" alone. */
function detailSummary(s: QaDocSection): string {
  const bits: string[] = [];
  const steps = s.click_trail?.length ?? 0;
  if (s.route) bits.push(s.route);
  if (steps > 0) bits.push(`${steps} step${steps === 1 ? '' : 's'}`);
  if (s.screenshots.length > 0) bits.push(`${s.screenshots.length} screenshot${s.screenshots.length === 1 ? '' : 's'}`);
  if (s.files.length > 0) bits.push(`${s.files.length} file${s.files.length === 1 ? '' : 's'}`);
  if (bits.length === 0) bits.push('nothing captured yet');
  if (s.constraints.trim()) bits.push('constraints');
  bits.push(s.model ?? 'default model');
  return bits.join(' · ');
}

/** A section's display name = the first line of its description. */
const firstLine = (body: string): string => body.trim().split('\n')[0]?.trim().slice(0, 80) ?? '';

/** Human label for a captured step — mirrors the widget's trail language. */
const stepText = (e: { kind?: string; value?: string; text?: string; route?: string }): string => {
  if (e.kind === 'input') {
    const typed = `typed "${(e.value ?? '').slice(0, 32)}"`;
    return e.text ? `${typed} · ${e.text.slice(0, 24)}` : typed;
  }
  if (e.text) return `clicked ${e.text.slice(0, 44)}`;
  return `went to ${e.route ?? '?'}`;
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
    <div className="flex flex-col gap-10 lg:flex-row">
      {/* Sections rail — a quiet index, tight against the column it indexes. */}
      <nav aria-label="Sections" className="hidden w-[190px] flex-none lg:block">
        <div className="sticky top-[68px]">
          <div className="mb-2 flex items-baseline gap-2 px-2">
            <span className="eyebrow">Tasks</span>
            <span className="text-[12px] tabular-nums text-ink-3">
              {shipped}/{sections.length} shipped
            </span>
          </div>
          <ul className="flex flex-col gap-px">
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#section-${s.id}`} className="nav-item">
                  <span
                    className={`size-[6px] flex-none rounded-full ${dotFor(
                      s.report_id !== null ? reports[s.report_id] : null,
                      Boolean(s.route || s.replay_path),
                    )}`}
                  />
                  <span className="truncate">{s.title || firstLine(s.body) || 'Untitled'}</span>
                </a>
              </li>
            ))}
            {sections.length === 0 ? <li className="px-2 py-1 text-[13px] text-ink-3">No tasks yet</li> : null}
          </ul>
        </div>
      </nav>

      {/* Document column — one measure, everything left-aligned to it. */}
      <div className="min-w-0 flex-1 lg:max-w-[720px]">
        <input
          defaultValue={doc.title}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== doc.title) patchDoc({ title: v });
          }}
          aria-label="Doc title"
          placeholder="Untitled"
          className="-ml-1.5 w-full rounded-[6px] border border-transparent bg-transparent px-1.5 py-0.5 text-[26px] font-semibold tracking-[-0.02em] placeholder:text-ink-3 focus:outline-none focus-visible:border-line"
        />
        <textarea
          defaultValue={doc.description}
          onBlur={(e) => {
            if (e.target.value !== doc.description) patchDoc({ description: e.target.value });
          }}
          placeholder="Add a description…"
          aria-label="Doc description"
          rows={1}
          className="field -ml-2 mt-0.5 resize-none text-[13.5px] text-ink-2"
        />
        <div className="mb-7 mt-0.5 px-2 text-[12.5px] text-ink-3">{doc.created_by ?? 'unknown'}</div>

        <div className="flex flex-col gap-4">
          {sections.map((s, idx) => (
            <SectionCard
              key={s.id}
              section={s}
              docTitle={doc.title}
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
        </div>

        <button
          type="button"
          onClick={() => void addSection()}
          className="mt-4 flex w-full items-center gap-2 rounded-[8px] px-3 py-2.5 text-[13px] text-ink-3 transition-colors hover:bg-surface hover:text-ink"
        >
          <span className="text-[15px] leading-none">+</span> New task
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------


/**
 * One task, as a questionnaire (contracts §Task input). Every field the task
 * carries is a labelled row in ONE block, read top to bottom: what you write,
 * then what the app captures — the captured rows are visible from the start,
 * empty, so the form's own shape says what the task is still missing — then
 * how it runs. Sending navigates INTO the task page; the answers become the
 * record there.
 */
function SectionCard({
  section,
  report,
  docTitle,
  first,
  last,
  onPatch,
  onMove,
  onRemove,
  onDispatched,
}: {
  section: QaDocSection;
  report: QaReport | null;
  docTitle: string;
  first: boolean;
  last: boolean;
  onPatch: (patch: Partial<QaDocSection>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onDispatched: (report: QaReport) => void;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dispatched = section.report_id !== null;
  const steps = section.click_trail ?? [];
  const captured = Boolean(section.route || steps.length > 0 || section.screenshots.length > 0);
  const errorCount = (section.console_log?.length ?? 0) + (section.network_log?.length ?? 0);
  const ready = section.body.trim().length > 0;

  const dispatch = async () => {
    if (dispatching || dispatched || !ready) return;
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
      onDispatched({ id: out.id, status: 'queued' } as QaReport);
      // Send moves you IN: the form's answers are the task's record from here.
      router.push(`/task/${out.id}`);
    } catch (e) {
      setDispatchError((e as Error).message);
      setDispatching(false);
    }
  };

  const addFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('sectionId', String(section.id));
      for (const file of Array.from(list).slice(0, 5)) form.append('files', file);
      const res = await fetch('/api/docs/section-files', { method: 'POST', body: form });
      const out = (await res.json()) as { files?: string[]; error?: string };
      if (res.ok && out.files) onPatch({ files: out.files });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const roleChips = ROLE_CHOICES.map((role) => ({
    key: role,
    label: role === '' ? 'me · my own roles' : role,
    on: (section.reproduce_as ?? '') === role,
  }));

  return (
    <section id={`section-${section.id}`} className="group border-t border-line-soft pb-2 pt-5 first:border-t-0 first:pt-0">
      {/* Header: the task's name, its state, and controls that stay out of the
          way until the pointer is here. */}
      <div className="mb-1 flex items-center gap-2">
        <span className="-ml-6 flex flex-none flex-col text-[9px] leading-[0.75] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button type="button" disabled={first} onClick={() => onMove(-1)} aria-label="Move up" className="hover:text-ink disabled:opacity-25">▲</button>
          <button type="button" disabled={last} onClick={() => onMove(1)} aria-label="Move down" className="hover:text-ink disabled:opacity-25">▼</button>
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em]">
          {section.title || firstLine(section.body) || 'New task'}
        </span>
        {report ? <StatusPill status={report.status} /> : null}
        {!dispatched &&
          (confirmDelete ? (
            <button type="button" onClick={onRemove} className="btn btn-quiet flex-none text-red">
              Delete
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              onBlur={() => setConfirmDelete(false)}
              aria-label="Delete task"
              className="btn btn-quiet flex-none px-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            >
              ×
            </button>
          ))}
      </div>

      {expanded ? <GroupLabel>you write</GroupLabel> : null}

      <Row label="The problem" required hint="or what you want built">
        <textarea
          defaultValue={section.body}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== section.body) onPatch({ body: v, title: firstLine(v) });
          }}
          disabled={dispatched}
          placeholder="Write it the way you'd tell a colleague. The first line becomes the task's name."
          aria-label="The problem"
          rows={Math.max(2, Math.min(10, section.body.split('\n').length + 1))}
          className={FIELD_CLS}
        />
      </Row>

      <Row label="Done when" required hint="how you'll know it's fixed">
        <textarea
          defaultValue={section.done_when}
          onBlur={(e) => {
            if (e.target.value !== section.done_when) onPatch({ done_when: e.target.value });
          }}
          disabled={dispatched}
          placeholder="“the stock number drops by the amount I entered”"
          aria-label="Done when"
          rows={2}
          className={FIELD_CLS}
        />
        {section.done_when.trim() ? null : (
          <p className="mt-1 px-2 text-[12px] text-ink-3">
            After the fix, your steps are replayed and an examiner checks this sentence.
          </p>
        )}
      </Row>

      {/* A document shows its point; the rest is one click away. The summary
          line says what is inside, so nothing important hides silently. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="mt-1.5 flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] text-ink-3 transition-colors hover:bg-surface hover:text-ink-2"
      >
        <span className={`flex-none text-[9px] transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span className="min-w-0 truncate">{detailSummary(section)}</span>
      </button>

      {expanded ? (
        <>
          <GroupLabel tone="auto">captured from the app</GroupLabel>

      <Row label="Location">
        {section.route ? (
          <div className="flex flex-wrap items-center gap-1.5 px-2 py-1">
            <Chip k="page" mono>{section.route}</Chip>
            {section.component ? <Chip k="component" mono>{section.component}</Chip> : null}
            {section.element_text ? <Chip k="element">“{section.element_text.slice(0, 40)}”</Chip> : null}
          </div>
        ) : (
          <Empty>not captured yet — the page and component you were on</Empty>
        )}
      </Row>

      <Row label="What you did" hint={steps.length > 0 ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : undefined}>
        {steps.length > 0 ? (
          <>
            <ol className="m-0 list-decimal pl-6 text-[13px] leading-relaxed text-ink-2 marker:text-ink-3">
              {steps.slice(0, 4).map((e, i) => (
                <li key={i} className="truncate">{stepText(e)}</li>
              ))}
            </ol>
            <div className="mt-1.5 flex items-center gap-2.5 px-2 text-[12.5px] text-ink-3">
              {steps.length > 4 ? <span>+{steps.length - 4} more</span> : null}
              {section.replay_path ? (
                <button type="button" onClick={() => setShowReplay((v) => !v)} className="font-semibold text-qa hover:underline">
                  {showReplay ? 'hide recording' : 'play recording'}
                </button>
              ) : null}
            </div>
            {showReplay && section.replay_path ? (
              <div className="mt-2">
                <ReplayPlayer
                  reportId={0}
                  fetchUrl={`/api/doc-replay/${section.id}`}
                  label={`⏺ recorded for “${section.title || 'this task'}”`}
                  steps={steps}
                />
              </div>
            ) : null}
          </>
        ) : (
          <Empty>not captured yet — your clicks and typing, recorded</Empty>
        )}
      </Row>

      <Row label="What you saw">
        {section.screenshots.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {section.screenshots.map((_, i) => (
              <span key={i} className="block h-[30px] w-[44px] rounded-[4px] border border-line bg-surface" />
            ))}
            <Chip>{section.screenshots.length} screenshot{section.screenshots.length === 1 ? '' : 's'}</Chip>
          </div>
        ) : (
          <Empty>not captured yet — screenshots</Empty>
        )}
      </Row>

      <Row label="Errors">
        {errorCount > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {(section.network_log ?? []).slice(0, 2).map((n, i) => (
              <span key={i} className="chip chip-err font-mono text-[11.5px]">
                {n.status} {n.method} {n.url.slice(0, 44)}
              </span>
            ))}
            {(section.console_log ?? []).slice(0, 2).map((c, i) => (
              <span key={i} className="chip">
                {c.level}: {c.text.slice(0, 50)}
              </span>
            ))}
          </div>
        ) : captured ? (
          <Empty>none in the recorded session</Empty>
        ) : (
          <Empty>not captured yet — console and network failures</Empty>
        )}
      </Row>

      {/* the one button that fills the four rows above */}
      {!dispatched ? (
        <div className="my-1.5">
          <div className="flex flex-wrap items-center gap-3 rounded-[8px] bg-surface px-3.5 py-2.5">
            <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">
              {captured
                ? 'Captured. Re-capture if the steps changed.'
                : 'The four rows above fill themselves — open the app, do the thing, press record, then finish.'}
            </span>
            <Link href={`/doc-capture/${section.id}`} className="btn flex-none bg-paper">
              {captured ? 'Re-capture' : 'Capture from the app'}
            </Link>
          </div>
        </div>
      ) : null}

      <Row label="Files" hint="optional">
        <div className="flex flex-wrap items-center gap-1.5">
          {section.files.map((f, i) => (
            <Chip key={i}>📎 {f.split('/').pop()}</Chip>
          ))}
          {!dispatched ? (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                onChange={(e) => void addFiles(e.target.files)}
                className="hidden"
                id={`files-${section.id}`}
              />
              <label
                htmlFor={`files-${section.id}`}
                className="cursor-pointer rounded-[6px] border border-dashed border-line px-2.5 py-1 text-[12.5px] text-ink-3 transition-colors hover:border-line-strong hover:bg-surface hover:text-ink"
              >
                {uploading ? 'uploading…' : section.files.length > 0 ? '＋ add' : 'drop a PDF, CSV or spreadsheet that triggers it'}
              </label>
            </>
          ) : null}
          {dispatched && section.files.length === 0 ? <Empty>none</Empty> : null}
        </div>
      </Row>

      <Row label="Reproduce as">
        <div className="flex flex-wrap gap-1.5">
          {roleChips.map((r) => (
            <button
              key={r.key}
              type="button"
              disabled={dispatched}
              onClick={() => onPatch({ reproduce_as: r.key === '' ? null : r.key })}
              aria-pressed={r.on}
              className={`chip transition-colors ${
                r.on ? 'border-qa/40 bg-qa-soft font-medium text-qa' : 'hover:bg-surface'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Must not do" hint="optional">
        <textarea
          defaultValue={section.constraints}
          onBlur={(e) => {
            if (e.target.value !== section.constraints) onPatch({ constraints: e.target.value });
          }}
          disabled={dispatched}
          placeholder="“no schema migration · web only”"
          aria-label="Must not do"
          rows={1}
          className={FIELD_CLS}
        />
      </Row>

      <GroupLabel tone="set">how it runs</GroupLabel>

      <Row label="Model">
        <span className="seg">
          {(['fable', 'opus', 'sonnet'] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={dispatched}
              onClick={() => onPatch({ model: section.model === m ? null : m })}
              aria-pressed={section.model === m}
            >
              {m}
            </button>
          ))}
        </span>
      </Row>

      <Row label="Base context">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-[6px] px-1 py-1 text-[13px] text-ink-2 transition-colors hover:bg-surface">
          <input
            type="checkbox"
            checked={section.base_session !== ''}
            disabled={dispatched}
            onChange={(e) => onPatch({ base_session: e.target.checked ? null : '' })}
            className="accent-qa"
          />
          start from the base-context session
        </label>
      </Row>

      <Row label="Treat as">
        <span className="seg">
          {(['bug', 'feature'] as const).map((k) => (
            <button key={k} type="button" disabled={dispatched} onClick={() => onPatch({ kind: k })} aria-pressed={section.kind === k}>
              {k}
            </button>
          ))}
        </span>
      </Row>

        </>
      ) : null}

      {/* footer */}
      <div className="mt-3.5 flex items-center gap-3">
        <span className="min-w-0 flex-1 text-[12.5px] text-ink-3">
          {dispatchError ? (
            <span className="text-red">{dispatchError}</span>
          ) : report ? (
            <>filed as task #{report.id} from “{docTitle}”</>
          ) : ready ? (
            'Claude starts immediately — a run slot is used.'
          ) : (
            'Nothing is sent until you press Send.'
          )}
        </span>
        {report ? (
          <Link href={`/task/${report.id}`} className="btn flex-none">
            Open task #{report.id} ↗
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => void dispatch()}
            disabled={dispatching || !ready}
            className="btn btn-primary flex-none"
          >
            {dispatching ? 'Sending…' : 'Send to Claude'}
          </button>
        )}
      </div>
    </section>
  );
}

// ---- form atoms -----------------------------------------------------------

const FIELD_CLS = 'field';

/** '' = the reporter's own roles (contracts §Task input). */
const ROLE_CHOICES = ['', 'Lab admin', 'Lab member', 'Department head', 'Institution admin'] as const;

/** A quiet divider that names the group — no chips, no colour blocks. */
function GroupLabel({ children }: { tone?: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 flex items-center gap-3 first:mt-0">
      <span className="eyebrow">{children}</span>
      <span className="h-px flex-1 bg-line-soft" />
    </div>
  );
}

function Row({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="frow">
      <div className="flabel">
        {label}
        {required ? <span className="ml-0.5 text-qa">*</span> : null}
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="fempty">{children}</div>;
}

function Chip({ k, mono, children }: { k?: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <span className={`chip ${mono ? 'font-mono text-[11.5px]' : ''}`}>
      {k ? <span className="chip-key">{k}</span> : null}
      {children}
    </span>
  );
}
