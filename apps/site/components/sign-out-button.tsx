'use client';

import { useState } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={() => {
        setBusy(true);
        void getBrowserClient()
          .auth.signOut()
          .then(() => {
            window.location.href = '/login';
          });
      }}
      disabled={busy}
      className="rounded-lg border border-line bg-stage px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
    >
      Sign out
    </button>
  );
}
