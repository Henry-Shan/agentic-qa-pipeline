'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/client';

type Mode = 'checking' | 'form' | 'denied';

const inputCls =
  'w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink focus:border-qa-bright focus:outline-none';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('checking');
  const [deniedEmail, setDeniedEmail] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const routeSignedIn = useCallback(async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      setMode('form');
      return;
    }
    const { data: isTester } = await supabase.rpc('qa_is_tester');
    if (isTester) {
      router.replace('/');
      return;
    }
    setDeniedEmail(data.user.email ?? '');
    setMode('denied');
  }, [router]);

  useEffect(() => {
    void routeSignedIn();
  }, [routeSignedIn]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setBusy(false);
      setError(signInError.message);
      return;
    }
    // Any the host app account + the team access code = tester (self-enroll).
    // Already-enrolled users pass regardless of what's typed in the code field.
    const enroll = await fetch('/api/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    setBusy(false);
    if (!enroll.ok) {
      setError(
        enroll.status === 403
          ? 'Wrong access code — check it with your team, then try again.'
          : 'Could not verify the access code. Try again.',
      );
      return;
    }
    setMode('checking');
    await routeSignedIn();
  }

  async function onSignOut() {
    await getBrowserClient().auth.signOut();
    setDeniedEmail('');
    setMode('form');
  }

  return (
    <div className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center justify-center gap-2.5 text-lg font-bold">
          <span className="grid size-8 flex-none place-items-center rounded-lg bg-qa text-sm font-extrabold text-on-accent">
            Q
          </span>
          QA Pipeline
        </div>

        <div className="card">
          {mode === 'checking' && (
            <div className="py-6 text-center text-[13px] text-ink-3">Checking your session…</div>
          )}

          {mode === 'denied' && (
            <div className="text-center">
              <div className="text-sm font-semibold">Not on the tester list yet</div>
              <p className="mt-2 text-[13px] text-ink-2">
                Your the host app login works, but <b>{deniedEmail}</b> isn&apos;t enrolled in QA yet. Sign
                out, then sign in again with the team access code — or ask an admin to add you.
              </p>
              <button
                onClick={() => void onSignOut()}
                className="mt-4 rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-ink-2 hover:border-qa-bright hover:text-ink"
              >
                Sign out
              </button>
            </div>
          )}

          {mode === 'form' && (
            <form onSubmit={onSubmit}>
              <p className="mb-4 text-[13px] text-ink-2">
                Sign in with your existing the host app account — same email and password as the app.
              </p>
              <label className="cap-label block" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputCls}
              />
              <label className="cap-label mt-3 block" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
              />
              <label className="cap-label mt-3 block" htmlFor="code">
                Access code
              </label>
              <input
                id="code"
                type="password"
                autoComplete="off"
                placeholder="First time here? Ask your team for the code."
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={inputCls}
              />
              {error && (
                <div className="mt-3 rounded-lg bg-red-soft px-3 py-2 text-[12.5px] font-semibold text-red">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={busy}
                className="mt-4 w-full rounded-lg bg-qa py-2.5 text-sm font-bold text-on-accent disabled:opacity-50"
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
