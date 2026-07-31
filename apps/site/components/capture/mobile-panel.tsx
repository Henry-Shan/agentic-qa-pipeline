import Link from 'next/link';
import { nameOf, relativeAge } from '@/lib/format';
import type { QaReport } from '@/lib/types';
import { StatusPill } from '@/components/status-pill';
import { QrBlock } from '@/components/capture/qr-block';

// Next.js only inlines NEXT_PUBLIC_* env vars on direct property access.
// Read here (server) and passed down; the QR itself is generated client-side.
const MOBILE_CAPTURE_URL = process.env.NEXT_PUBLIC_MOBILE_CAPTURE_URL;

const STEPS: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: 'Install the internal TestFlight build',
    detail: 'The QA reporter only exists in internal builds — grab the latest one.',
  },
  {
    title: 'Sign in and find the floating 🐛 bubble',
    detail: 'It drifts over every screen in the app; drag it out of the way anytime.',
  },
  {
    title: 'Point, describe, send — reports land here',
    detail: 'Tap the bug on the broken spot, add a sentence, and submit. Claude picks it up from this board.',
  },
];

/**
 * Guided mobile capture panel (contracts § /capture platform toggle): capture
 * itself happens IN the app — this is the desk-side companion with the how-to,
 * an optional install QR, and the latest mobile-filed reports.
 */
export function MobilePanel({
  reports,
  names,
}: {
  reports: QaReport[];
  names: Record<string, string>;
}) {
  return (
    <div className="h-[calc(100dvh-3rem)] overflow-y-auto">
      <div className="mx-auto w-full max-w-[640px] px-5 py-8">
        <div className="card">
          <h2 className="text-[14.5px] font-semibold">Report from the mobile app</h2>
          <ol className="mt-4 flex flex-col gap-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-px grid size-6 flex-none place-items-center rounded-full bg-qa-soft text-[12px] font-bold text-qa"
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold">{step.title}</div>
                  <div className="mt-0.5 text-[12.5px] text-ink-3">{step.detail}</div>
                </div>
              </li>
            ))}
          </ol>

          {MOBILE_CAPTURE_URL ? <QrBlock url={MOBILE_CAPTURE_URL} /> : null}
        </div>

        <div className="mt-6">
          <div className="cap-label">Latest mobile reports</div>
          {reports.length === 0 ? (
            <div className="card py-6 text-center text-[13px] text-ink-3">
              No mobile reports yet — the first one filed from the app lands here.
            </div>
          ) : (
            <ul className="overflow-hidden rounded-[14px] border border-line bg-stage shadow-card">
              {reports.map((report) => {
                const reporter = report.reporter_email
                  ? names[report.reporter_email] || nameOf(report.reporter_email)
                  : 'unknown';
                return (
                  <li key={report.id} className="border-b border-line-soft last:border-b-0">
                    <Link
                      href={`/task/${report.id}`}
                      className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold">{report.title}</div>
                        <div className="mt-0.5 text-[11.5px] text-ink-3">
                          <span title={report.reporter_email ?? undefined}>{reporter}</span>
                          {' · '}
                          <span suppressHydrationWarning>{relativeAge(report.created_at)}</span>
                        </div>
                      </div>
                      <StatusPill status={report.status} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
