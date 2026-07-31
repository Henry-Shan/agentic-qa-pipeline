import type { ReactNode } from 'react';
import { createClient } from '@/lib/supabase/server';
import { TopBar } from '@/components/top-bar';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  // Width is per-page: list/task use a reading column, /canvas goes wide.
  return (
    <div className="min-h-dvh">
      <TopBar email={data.user?.email ?? ''} />
      {children}
    </div>
  );
}
