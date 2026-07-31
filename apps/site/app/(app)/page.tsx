import { createClient } from '@/lib/supabase/server';
import { Board } from '@/components/board/board';
import { inPersonalBand } from '@/lib/merge';
import { nameOf } from '@/lib/format';
import type { QaEvent, QaReport, QaRun } from '@/lib/types';

export default async function BoardPage() {
  const supabase = await createClient();
  const [{ data: userData }, { data: reportRows }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from('qa_reports').select('*').order('id', { ascending: false }).limit(100),
  ]);
  const userEmail = userData.user?.email ?? '';
  const reports = (reportRows ?? []) as QaReport[];

  let runs: QaRun[] = [];
  let needsHuman: QaEvent[] = [];
  if (reports.length > 0) {
    const ids = reports.map((r) => r.id);
    const [runRes, meRes] = await Promise.all([
      supabase.from('qa_runs').select('*').in('report_id', ids).order('id', { ascending: false }),
      supabase
        .from('qa_allowed_emails')
        .select('display_name')
        .eq('email', userEmail)
        .maybeSingle(),
    ]);
    runs = (runRes.data ?? []) as QaRun[];
    // Same display-name fallback as useDisplayName (email local-part), so the
    // server band membership matches what the client renders.
    const myName = (meRes.data?.display_name as string | null) || nameOf(userEmail);
    // Hand-off summaries for "Assigned to me" — the signed-in user's
    // blocked reports plus reports assigned to their display name.
    const bandIds = reports.filter((r) => inPersonalBand(r, userEmail, myName)).map((r) => r.id);
    if (bandIds.length > 0) {
      const { data: eventRows } = await supabase
        .from('qa_events')
        .select('*')
        .eq('type', 'needs_human')
        .in('report_id', bandIds)
        .order('id', { ascending: false });
      needsHuman = (eventRows ?? []) as QaEvent[];
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-6">
      <Board
        initialReports={reports}
        initialRuns={runs}
        initialNeedsHuman={needsHuman}
        userEmail={userEmail}
      />
    </main>
  );
}
