'use client';

// Parent-side half of the frame handshake (contracts/CONTRACTS.md § Widget host
// integration), shared by /capture and the task page's embedded replay preview:
//   iframe loader → hello → we reply activate (endpoint + signed-in QA email)
//   widget → token → we reply token-result (QA session access token)
// Every message is origin-gated to `allowedOrigin` — the origin of the embedded
// copy of the host app (NEXT_PUBLIC_CAPTURE_URL for /capture, the run's preview_url
// origin for the embed). Anything else that passes the gate (filed, replay-done)
// is forwarded to `onMessage` for the caller to handle.

import { useEffect, useRef } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';

// Next.js only inlines NEXT_PUBLIC_* env vars on direct property access.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

export interface FrameHostMessage {
  type?: unknown;
  [key: string]: unknown;
}

export interface FrameHostHandlers {
  /** A hello passed the origin gate (fires even before the QA email resolves). */
  onHello?: () => void;
  /**
   * An activate was just sent in reply to a hello. May fire more than once —
   * the loader retries hello every second until activated and ignores
   * duplicate activates — so callers de-dupe follow-ups themselves.
   */
  onActivate?: (source: WindowProxy, origin: string) => void;
  /** Any other origin-gated message (filed, replay-done, …). */
  onMessage?: (data: FrameHostMessage, event: MessageEvent) => void;
}

/**
 * An embed whose src is the preview launcher starts at the launcher's origin
 * (`http://localhost:<agent port>`) and lands, after the front door's redirect,
 * on the preview's own port — a DIFFERENT localhost origin, unknowable in
 * advance because the port is picked at start time. Both are this machine, so
 * when the expected origin is localhost, the whole localhost family is the
 * trust boundary; every other expected origin stays an exact match.
 */
function originAllowed(allowed: string, actual: string): boolean {
  if (actual === allowed) return true;
  return allowed.startsWith('http://localhost') && actual.startsWith('http://localhost:');
}

export function useFrameHost(allowedOrigin: string | null, handlers: FrameHostHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!allowedOrigin) return;

    // The QA session email, resolved once; hellos that arrive before it is
    // known are simply not answered — the loader retries every second.
    let email: string | null = null;
    void (async () => {
      const { data } = await getBrowserClient().auth.getSession();
      email = data.session?.user.email ?? null;
    })();

    const onMessage = (event: MessageEvent) => {
      // Origin gate: only the embedded copy of the host app may talk to us.
      if (!originAllowed(allowedOrigin, event.origin)) return;
      const data = event.data as FrameHostMessage | null;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'qa-pipeline:hello') {
        handlersRef.current.onHello?.();
        if (!email || !event.source) return; // loader will retry
        const source = event.source as WindowProxy;
        source.postMessage(
          {
            type: 'qa-pipeline:activate',
            endpoint: SITE_URL || window.location.origin,
            email,
          },
          event.origin,
        );
        handlersRef.current.onActivate?.(source, event.origin);
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

      handlersRef.current.onMessage?.(data, event);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [allowedOrigin]);
}
