'use client';

// ⧉ Copy Claude session (contracts § Site pages): copies
// `cd $NEXT_PUBLIC_RUNNER_REPO && claude --resume <latest run session_id>` so a
// developer can reopen the very session that produced the fix. Falls back to
// the bare resume command when the env var is unset.

import { useEffect, useRef, useState } from 'react';

// Next.js only inlines NEXT_PUBLIC_* env vars on direct property access.
const RUNNER_REPO = process.env.NEXT_PUBLIC_RUNNER_REPO;

export function CopySession({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy() {
    const resume = `claude --resume ${sessionId}`;
    const command = RUNNER_REPO ? `cd ${RUNNER_REPO} && ${resume}` : resume;
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return; // clipboard unavailable (permission / insecure context) — label stays put
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="Copy the terminal command that reopens this fix's Claude session"
      className="flex-none rounded-md border border-line bg-stage px-2 py-0.5 text-[11px] font-semibold text-ink-2 transition-colors hover:bg-surface hover:text-ink"
    >
      {copied ? 'Copied ✓' : '⧉ Copy Claude session'}
    </button>
  );
}
