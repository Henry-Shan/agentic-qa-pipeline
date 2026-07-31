// "Report an issue" — a slim top bar over one of two capture experiences,
// switched by the segmented Web | Mobile toggle (contracts § /capture platform
// toggle). Web = the full-screen embedded example.com iframe with the widget
// handshake (CaptureFrame, unchanged behavior). Mobile = a guided desk-side
// panel: how-to steps, an optional QR code for the internal build, and the
// latest mobile-filed reports. The active platform lives in ?platform=mobile
// so either view is linkable; mobile's report list is server-fetched here.

import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { CaptureFrame } from '@/components/capture/capture-frame';
import { MobilePanel } from '@/components/capture/mobile-panel';
import { PlatformToggle } from '@/components/capture/platform-toggle';
import type { QaReport } from '@/lib/types';

const MOBILE_REPORT_LIMIT = 8;

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const platform = params.platform === 'mobile' ? 'mobile' : 'web';

  // Latest mobile reports + display names — fetched with the page (realtime
  // not required for this panel). Cancelled rows are teardown tombstones and
  // never show in views (contracts § Status model).
  let mobileReports: QaReport[] = [];
  let names: Record<string, string> = {};
  if (platform === 'mobile') {
    const supabase = await createClient();
    const [{ data: reportRows }, { data: allowedRows }] = await Promise.all([
      supabase
        .from('qa_reports')
        .select('*')
        .eq('app_context->>platform', 'mobile')
        .neq('status', 'cancelled')
        .order('id', { ascending: false })
        .limit(MOBILE_REPORT_LIMIT),
      supabase.from('qa_allowed_emails').select('email, display_name'),
    ]);
    mobileReports = (reportRows ?? []) as QaReport[];
    names = {};
    for (const row of (allowedRows ?? []) as Array<{ email: string; display_name: string | null }>) {
      if (row.display_name) names[row.email] = row.display_name;
    }
  }

  return (
    <div className="relative h-dvh bg-paper">
      <header className="flex h-12 items-center gap-4 border-b border-line bg-stage/90 px-4 backdrop-blur">
        <Link href="/" className="flex-none text-[13px] font-semibold text-qa hover:underline">
          ← Board
        </Link>
        <h1 className="flex-none text-[14px] font-bold">Report an issue</h1>
        <PlatformToggle active={platform} />
        <p className="hidden min-w-0 truncate text-[12.5px] text-ink-3 md:block">
          {platform === 'web'
            ? 'Navigate to where the problem is, then click the 🐛 button — bottom right inside the app.'
            : 'Capture happens in the app — this page is the desk-side companion.'}
        </p>
      </header>

      {platform === 'web' ? (
        <CaptureFrame />
      ) : (
        <MobilePanel reports={mobileReports} names={names} />
      )}
    </div>
  );
}
