'use client';

// Share this run's preview on the one shared hostname (contracts §Preview).
//
// Only ONE preview is shareable at a time: Cloudflare's Universal SSL covers
// `*.example.com` but not a second-level wildcard, so a per-run hostname would
// need a paid certificate. Sharing another run simply moves the hostname.
//
// The link is open to anyone who has it. That is deliberate — testers should be
// able to check a fix without an account — so the button says so plainly rather
// than implying it is private.

import { useCallback, useEffect, useState } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';

const SHARED_HOST = 'https://qa-preview.example.com';

export function SharePreview({ runId, previewLive }: { runId: number | null; previewLive: boolean }) {
  const [publishedRun, setPublishedRun] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const supabase = getBrowserClient();

  const load = useCallback(async () => {
    const { data } = await supabase.from('qa_settings').select('value').eq('key', 'published_run').maybeSingle();
    setPublishedRun(typeof data?.value === 'number' ? data.value : 0);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!runId || !previewLive) return null;
  const isShared = publishedRun === runId;

  const set = async (value: number) => {
    setBusy(true);
    await supabase.from('qa_settings').update({ value }).eq('key', 'published_run');
    setPublishedRun(value);
    setBusy(false);
  };

  if (isShared) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <a href={SHARED_HOST} target="_blank" rel="noopener noreferrer" className="btn">
          {SHARED_HOST.replace('https://', '')} ↗
        </a>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(SHARED_HOST);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          className="btn btn-quiet"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button type="button" disabled={busy} onClick={() => void set(0)} className="btn btn-quiet">
          Stop sharing
        </button>
        <span className="text-[11.5px] text-ink-3">Anyone with this link can open it.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} onClick={() => void set(runId)} className="btn">
        {busy ? 'Sharing…' : 'Share this preview'}
      </button>
      <span className="text-[11.5px] text-ink-3">
        {publishedRun && publishedRun > 0
          ? `Another preview is shared right now — this replaces it.`
          : 'Publishes it at a link anyone can open, until you stop.'}
      </span>
    </div>
  );
}
