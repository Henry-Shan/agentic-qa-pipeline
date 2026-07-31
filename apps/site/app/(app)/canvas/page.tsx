import { createClient } from '@/lib/supabase/server';
import { CanvasView } from '@/components/canvas/canvas-view';
import type { QaCanvasBlock, QaReport, QaRun } from '@/lib/types';

export default async function CanvasPage() {
  const supabase = await createClient();
  const [{ data: userData }, { data: reportRows }, { data: blockRows }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from('qa_reports').select('*').order('id', { ascending: false }).limit(100),
    supabase.from('qa_canvas_blocks').select('*').order('id'),
  ]);
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
    <main className="mx-auto w-full max-w-[1500px] px-5 py-5">
      <CanvasView
        initialReports={reports}
        initialRuns={runs}
        initialBlocks={(blockRows ?? []) as QaCanvasBlock[]}
        userEmail={userData.user?.email ?? ''}
      />
    </main>
  );
}
