'use client';

// Full-screen embedded example.com for filing reports without leaving the QA
// site. Frame handshake (see contracts/CONTRACTS.md § Widget host integration):
//   iframe → hello → we reply activate (endpoint + QA session email) → widget
//   loads inside the frame → on submit the widget posts `filed` → we navigate
//   to the task page.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/client';

// Next.js only inlines NEXT_PUBLIC_* env vars on direct property access.
const CAPTURE_URL = process.env.NEXT_PUBLIC_CAPTURE_URL || 'https://example.com';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

const HELLO_TIMEOUT_MS = 8_000;

function captureOrigin(): string | null {
  try {
    return new URL(CAPTURE_URL).origin;
  } catch {
    return null;
  }
}

export default function CapturePage() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [noteVisible, setNoteVisible] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState(false);

  useEffect(() => {
    const allowedOrigin = captureOrigin();
    if (!allowedOrigin) return;

    // The QA session email, resolved once; hellos that arrive before it is
    // known are simply not answered — the loader retries every second.
    let email: string | null = null;
    void (async () => {
      const { data } = await getBrowserClient().auth.getSession();
      email = data.session?.user.email ?? null;
    })();

    let helloSeen = false;
    const timer = window.setTimeout(() => {
      if (!helloSeen) setNoteVisible(true);
    }, HELLO_TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      // Origin gate: only the embedded capture copy of the host app may talk to us.
      if (event.origin !== allowedOrigin) return;
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'qa-pipeline:hello') {
        helloSeen = true;
        setNoteVisible(false);
        if (!email || !event.source) return; // loader will retry
        (event.source as WindowProxy).postMessage(
          {
            type: 'qa-pipeline:activate',
            endpoint: SITE_URL || window.location.origin,
            email,
          },
          event.origin,
        );
        return;
      }

      if (data.type === 'qa-pipeline:token' && event.source) {
        // The widget authenticates submissions with the QA session's token —
        // the tester is signed in HERE even when the embedded app is not.
        const source = event.source as WindowProxy;
        const targetOrigin = event.origin;
        void (async () => {
          const { data: sessionData } = await getBrowserClient().auth.getSession();
          source.postMessage(
            { type: 'qa-pipeline:token-result', token: sessionData.session?.access_token ?? null },
            targetOrigin,
          );
        })();
        return;
      }

      if (data.type === 'qa-pipeline:filed' && typeof data.url === 'string') {
        try {
          const task = new URL(data.url, window.location.origin);
          routerRef.current.push(task.pathname);
        } catch {
          // Malformed url — stay on the capture page; the widget toast still links out.
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
  }, []);

  return (
    <div className="h-dvh bg-paper">
      <header className="relative flex h-12 items-center gap-4 border-b border-line bg-stage/90 px-4 backdrop-blur">
        <Link href="/" className="flex-none text-[13px] font-semibold text-qa hover:underline">
          ← Board
        </Link>
        <h1 className="flex-none text-[14px] font-bold">Report an issue</h1>
        <p className="hidden truncate text-[12.5px] text-ink-3 md:block">
          Navigate to where the problem is, then click the 🐛 button — bottom right inside the app.
        </p>

        {noteVisible && !noteDismissed && (
          <div
            role="status"
            className="absolute inset-x-0 top-0 z-20 flex min-h-12 items-center justify-between gap-3 border-b border-amber/30 bg-amber-soft px-4 py-2 text-[12.5px] text-amber"
          >
            <span>
              The widget hasn&apos;t loaded inside this copy of the host app — it may not have QA
              embedding enabled yet.
            </span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setNoteDismissed(true)}
              className="flex-none rounded px-1.5 text-[15px] font-bold hover:bg-amber/10"
            >
              ×
            </button>
          </div>
        )}
      </header>

      <iframe
        src={CAPTURE_URL}
        title="the host app — report an issue"
        className="block h-[calc(100dvh-3rem)] w-full border-0"
      />
    </div>
  );
}
