'use client';

// Web capture: full-screen embedded example.com for filing reports without
// leaving the QA site. The hello/activate/token handshake lives in the shared
// useFrameHost hook (also used by the task page's embedded replay preview);
// this component adds the capture-only bits: the 8s "widget hasn't loaded"
// note (overlaying the server-rendered top bar) and navigation to the task
// page when the widget posts `filed`.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFrameHost } from '@/lib/use-frame-host';

// Next.js only inlines NEXT_PUBLIC_* env vars on direct property access.
const CAPTURE_URL = process.env.NEXT_PUBLIC_CAPTURE_URL || 'https://example.com';

const HELLO_TIMEOUT_MS = 8_000;

function captureOrigin(): string | null {
  try {
    return new URL(CAPTURE_URL).origin;
  } catch {
    return null;
  }
}

export function CaptureFrame() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [noteVisible, setNoteVisible] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState(false);
  const helloSeenRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!helloSeenRef.current) setNoteVisible(true);
    }, HELLO_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useFrameHost(captureOrigin(), {
    onHello: () => {
      helloSeenRef.current = true;
      setNoteVisible(false);
    },
    onMessage: (data) => {
      if (data.type === 'qa-pipeline:filed' && typeof data.url === 'string') {
        try {
          const task = new URL(data.url, window.location.origin);
          routerRef.current.push(task.pathname);
        } catch {
          // Malformed url — stay on the capture page; the widget toast still links out.
        }
      }
    },
  });

  return (
    <>
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

      <iframe
        src={CAPTURE_URL}
        title="Report an issue"
        className="block h-[calc(100dvh-3rem)] w-full border-0"
      />
    </>
  );
}
