import type { QaRun } from '@/lib/types';

export function ResultCard({ run }: { run: QaRun | null }) {
  const previewUrl = run?.preview_status === 'live' ? run.preview_url : null;
  const verdict = typeof run?.featuretest?.verdict === 'string' ? run.featuretest.verdict : null;

  return (
    <div className="rounded-[14px] border border-line bg-stage p-3.5 shadow-card">
      {previewUrl ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full rounded-lg bg-qa px-3 py-2.5 text-center text-[12.5px] font-bold text-on-accent transition-colors hover:bg-qa-bright"
        >
          Open the fixed app ↗
        </a>
      ) : (
        <button
          disabled
          title={run?.preview_status === 'starting' ? 'Preview is starting…' : 'No live preview yet'}
          className="block w-full cursor-not-allowed rounded-lg bg-qa px-3 py-2.5 text-center text-[12.5px] font-bold text-on-accent opacity-40"
        >
          Open the fixed app ↗
        </button>
      )}

      {run?.pr_url ? (
        <a
          href={run.pr_url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block w-full rounded-lg border border-line bg-stage px-3 py-2.5 text-center text-[12.5px] font-semibold text-ink-2 transition-colors hover:bg-canvas hover:text-ink"
        >
          PR {run.pr_number ? `#${run.pr_number} ` : ''}on GitHub ↗
        </a>
      ) : null}

      {run?.files_changed?.length ? (
        <div className="mt-3 border-t border-line-soft pt-2 font-mono text-[11px] text-ink-2">
          {run.files_changed.map((change) => (
            <div key={change.file} className="flex items-center gap-2 py-0.5">
              <span className="font-semibold text-green tabular-nums">+{change.add}</span>
              <span className="font-semibold text-red tabular-nums">−{change.del}</span>
              <span className="truncate">{change.file}</span>
            </div>
          ))}
        </div>
      ) : null}

      {verdict ? (
        <div className="mt-3">
          <span
            className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-bold ${
              /pass/i.test(verdict)
                ? 'bg-green-soft text-green'
                : /fail/i.test(verdict)
                  ? 'bg-red-soft text-red'
                  : 'bg-line-soft text-ink-2'
            }`}
          >
            Feature test · {verdict}
          </span>
        </div>
      ) : null}

      {run?.test_plan ? (
        <details className="mt-3 border-t border-line-soft pt-2">
          <summary className="cursor-pointer text-xs font-semibold text-ink-2">Test plan</summary>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink-2">
            {run.test_plan}
          </pre>
        </details>
      ) : null}

      {!run ? (
        <div className="mt-3 text-center text-xs text-ink-3">Queued — a run hasn&apos;t started yet.</div>
      ) : null}
    </div>
  );
}
