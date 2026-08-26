// The machine-independent preview address (contracts §Preview agent).
//
// `http://localhost:<port>/p/<reportId>` resolves on whichever machine the
// click happens: the front door there redirects to that machine's own copy of
// the fix, building it first if it has to. The same link therefore works for
// every tester running a worker or preview agent — unlike the run row's
// stored `preview_url`, which names a port that only exists on the runner.

// Next.js only inlines NEXT_PUBLIC_* env vars on direct property access.
const AGENT_PORT = process.env.NEXT_PUBLIC_PREVIEW_AGENT_PORT || '4521';

export function previewLauncherUrl(reportId: number): string {
  return `http://localhost:${AGENT_PORT}/p/${reportId}`;
}
