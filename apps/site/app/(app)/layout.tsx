import type { ReactNode } from 'react';
import { createClient } from '@/lib/supabase/server';
import { DisplayNamesProvider } from '@/lib/display-names';
import { TopBar } from '@/components/top-bar';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  // Email → display_name map for every tester (RLS: testers can SELECT this
  // table). Fetched once per page load; components resolve via useDisplayName.
  const [{ data }, { data: allowedRows }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from('qa_allowed_emails').select('email, display_name'),
  ]);
  const names: Record<string, string> = {};
  for (const row of (allowedRows ?? []) as Array<{ email: string; display_name: string | null }>) {
    if (row.display_name) names[row.email] = row.display_name;
  }
  // Width is per-page: list/task use a reading column, /canvas goes wide.
  return (
    <DisplayNamesProvider names={names}>
      <div className="min-h-dvh">
        <TopBar email={data.user?.email ?? ''} />
        {children}
      </div>
    </DisplayNamesProvider>
  );
}
