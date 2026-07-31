import { createClient } from '@/lib/supabase/server';
import { Board } from '@/components/board/board';
import type { QaReport, QaRun } from '@/lib/types';

export default async function BoardPage() {
  const supabase = await createClient();
  const { data: reportRows } = await supabase
    .from('qa_reports')
    .select('*')
    .order('id', { ascending: false })
    .limit(100);
  const reports = (reportRows ?? []) as QaReport[];

  let runs: QaRun[] = [];
  if (reports.length > 0) {
    const { data: runRows } = await supabase
      .from('qa_runs')
      .select('*')
      .in(
        'report_id',
        reports.map((r) => r.id),
      )
      .order('id', { ascending: false });
    runs = (runRows ?? []) as QaRun[];
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-6">
      <Board initialReports={reports} initialRuns={runs} />
    </main>
  );
}
