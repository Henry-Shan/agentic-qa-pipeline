import type { ReactNode } from 'react';
import { createClient } from '@/lib/supabase/server';
import { TopBar } from '@/components/top-bar';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return (
    <div className="min-h-dvh">
      <TopBar email={data.user?.email ?? ''} />
      <main className="mx-auto w-full max-w-5xl px-5 py-6">{children}</main>
    </div>
  );
}
