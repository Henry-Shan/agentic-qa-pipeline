'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/client';

type Mode = 'checking' | 'form' | 'name' | 'denied';

const NAME_MAX = 24;

const inputCls =
  'w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-qa-bright focus:outline-none';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('checking');
  const [deniedEmail, setDeniedEmail] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Name step: chips from qa_tester_names + the email's saved display_name.
  const [names, setNames] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

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

  /** Load name chips + this email's saved display_name, then show the step. */
  async function enterNameStep() {
    const supabase = getBrowserClient();
    const { data: userData } = await supabase.auth.getUser();
    const authedEmail = userData.user?.email ?? '';
    const [namesRes, meRes] = await Promise.all([
      supabase.from('qa_tester_names').select('name').order('name'),
      supabase.from('qa_allowed_emails').select('display_name').eq('email', authedEmail).maybeSingle(),
    ]);
    const list = ((namesRes.data ?? []) as Array<{ name: string }>).map((r) => r.name);
    const current = ((meRes.data ?? null) as { display_name: string | null } | null)?.display_name ?? null;
    if (current && !list.includes(current)) list.push(current);
    setNames(list);
    setPicked(current); // returning testers get one-click "Continue as <name>"
    setMode('name');
  }

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
    // Any host-app account + the team access code = tester (self-enroll).
    // Already-enrolled users pass regardless of what's typed in the code field.
    const enroll = await fetch('/api/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!enroll.ok) {
      setBusy(false);
      setError(
        enroll.status === 403
          ? 'Wrong access code — check it with your team, then try again.'
          : 'Could not verify the access code. Try again.',
      );
      return;
    }
    await enterNameStep();
    setBusy(false);
  }

  function addName() {
    const name = newName.trim();
    if (!name || name.length > NAME_MAX) {
      setError(`Names are 1-${NAME_MAX} characters.`);
      return;
    }
    setError(null);
    setNames((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setPicked(name);
    setNewName('');
    setAdding(false);
  }

  async function saveName() {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch('/api/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: picked }),
    });
    setBusy(false);
    if (!res.ok) {
      setError('Could not save your name. Try again.');
      return;
    }
    router.replace('/');
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
                Your host-app login works, but <b>{deniedEmail}</b> isn&apos;t enrolled in QA yet. Sign
                out, then sign in again with the team access code — or ask an admin to add you.
              </p>
              <button
                onClick={() => void onSignOut()}
                className="mt-4 rounded-lg border border-line bg-stage px-4 py-2 text-[13px] font-semibold text-ink-2 hover:bg-surface hover:text-ink"
              >
                Sign out
              </button>
            </div>
          )}

          {mode === 'name' && (
            <div>
              <div className="text-sm font-semibold">Who&apos;s testing?</div>
              <p className="mt-1 text-[12.5px] text-ink-3">
                Pick a name — it&apos;s how your reports and notes are signed.
              </p>
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                {names.map((name) => (
                  <button
                    key={name}
                    onClick={() => setPicked(name)}
                    aria-pressed={picked === name}
                    className={`rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
                      picked === name
                        ? 'border-qa bg-qa-soft text-qa'
                        : 'border-line bg-stage text-ink-2 hover:border-qa-bright hover:text-ink'
                    }`}
                  >
                    {name}
                  </button>
                ))}
                {adding ? (
                  <span className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={newName}
                      maxLength={NAME_MAX}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addName();
                        } else if (e.key === 'Escape') {
                          setAdding(false);
                          setNewName('');
                        }
                      }}
                      placeholder="Your name"
                      className="w-32 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-qa-bright focus:outline-none"
                    />
                    <button
                      onClick={addName}
                      className="rounded-full bg-qa px-3 py-1.5 text-[12.5px] font-bold text-on-accent hover:bg-qa-bright"
                    >
                      Add
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setAdding(true)}
                    className="rounded-full border border-dashed border-line px-3.5 py-1.5 text-[13px] font-semibold text-ink-3 transition-colors hover:border-qa-bright hover:text-ink"
                  >
                    ＋ Add name
                  </button>
                )}
              </div>
              {error && (
                <div className="mt-3 rounded-lg bg-red-soft px-3 py-2 text-[12.5px] font-semibold text-red">
                  {error}
                </div>
              )}
              <button
                onClick={() => void saveName()}
                disabled={busy || !picked}
                className="mt-4 w-full rounded-lg bg-qa py-2.5 text-sm font-bold text-on-accent transition-colors hover:bg-qa-bright disabled:opacity-50"
              >
                {busy ? 'Saving…' : picked ? `Continue as ${picked}` : 'Pick a name to continue'}
              </button>
            </div>
          )}

          {mode === 'form' && (
            <form onSubmit={onSubmit}>
              <p className="mb-4 text-[13px] text-ink-2">
                Sign in with your existing host-app account — same email and password as the app.
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
                className="mt-4 w-full rounded-lg bg-qa py-2.5 text-sm font-bold text-on-accent transition-colors hover:bg-qa-bright disabled:opacity-50"
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
