import type { QaReport } from '@/lib/types';

/** Original report — collapsed at the top of the task page. */
export function ReportContext({ report }: { report: QaReport }) {
  const failing = report.network_log.filter((n) => n.status < 200 || n.status >= 300);
  const hasScreenshot = report.screenshots.length > 0;

  return (
    <details className="card mt-4">
      <summary className="cursor-pointer text-[13px] font-semibold text-ink-2">
        Original report{report.route ? ` · ${report.route}` : ''}
      </summary>
      <div className={`mt-3 grid gap-4 ${hasScreenshot ? 'md:grid-cols-2' : ''}`}>
        <div className="min-w-0">
          {report.description ? <p className="text-[13.5px] text-ink-2">{report.description}</p> : null}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {report.route ? (
              <span className="chip font-mono">
                <span className="chip-key">route</span> {report.route}
              </span>
            ) : null}
            {report.component ? (
              <span className="chip font-mono">
                <span className="chip-key">component</span> {report.component}
                {report.source_file ? ` · ${report.source_file}` : ''}
              </span>
            ) : null}
            {report.viewport ? (
              <span className="chip tabular-nums">
                {report.viewport.w}×{report.viewport.h} @{report.viewport.dpr}x
              </span>
            ) : null}
          </div>
          {report.console_log.length > 0 || failing.length > 0 ? (
            <div className="mt-2 flex flex-col items-start gap-1.5">
              {report.console_log.slice(0, 4).map((entry, i) => (
                <span key={`c${i}`} className="chip chip-err font-mono">
                  <span className="chip-key">console</span> {entry.text}
                </span>
              ))}
              {failing.slice(0, 4).map((entry, i) => (
                <span key={`n${i}`} className="chip chip-err font-mono">
                  <span className="chip-key">network</span> {entry.method} {entry.url} → {entry.status}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {hasScreenshot ? (
          // ALL screenshots as a thumbnail row; each opens the signed URL in a
          // new tab via the shot endpoint (?i=N → the Nth stored path).
          <div className="flex flex-wrap content-start gap-2">
            {report.screenshots.map((path, i) => (
              <a
                key={path}
                href={`/api/shot/${report.id}?i=${i}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                {/* Signed-URL redirect; plain img on purpose (next/image can't follow it). */}
                <img
                  src={`/api/shot/${report.id}?i=${i}`}
                  alt={i === 0 ? 'Screenshot with the reported element marked' : `Additional screenshot ${i + 1}`}
                  className="h-28 w-auto max-w-full rounded-[10px] border border-line bg-surface object-contain transition-colors hover:border-qa-bright"
                />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
