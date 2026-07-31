import { createClient } from '@/lib/supabase/server';
import { Board } from '@/components/board/board';
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
    // Hand-off summaries for the "Needs {name}" band — only the signed-in
    // user's blocked reports can appear there.
    const blockedIds = reports
      .filter((r) => r.status === 'blocked' && r.reporter_email === userEmail)
      .map((r) => r.id);
    const [runRes, eventRes] = await Promise.all([
      supabase.from('qa_runs').select('*').in('report_id', ids).order('id', { ascending: false }),
      blockedIds.length > 0
        ? supabase
            .from('qa_events')
            .select('*')
            .eq('type', 'needs_human')
            .in('report_id', blockedIds)
            .order('id', { ascending: false })
        : Promise.resolve({ data: null }),
    ]);
    runs = (runRes.data ?? []) as QaRun[];
    needsHuman = (eventRes.data ?? []) as QaEvent[];
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
