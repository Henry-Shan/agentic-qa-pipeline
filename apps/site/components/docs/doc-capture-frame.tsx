'use client';

// Doc-mode capture (contracts §QA Docs): the same embedded-the host app handshake
// as /capture, plus one extra message each way — after activate we tell the
// widget `doc-mode`, and its Send posts the whole draft BACK here instead of
// filing. We store the light fields on the section (tester RLS), upload the
// blobs to signed storage URLs (/api/docs/section-capture — Vercel never sees
// them), then return to the doc.

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/client';
import { useFrameHost } from '@/lib/use-frame-host';
import type { ClickTrailEntry, ReportKind } from '@/lib/types';

const CAPTURE_URL = process.env.NEXT_PUBLIC_CAPTURE_URL || 'https://example.com';

interface DraftPayload {
  kind?: ReportKind;
  description?: string;
  route?: string;
  component?: string;
  sourceFile?: string;
  selector?: string;
  testid?: string;
  elementText?: string;
  clickTrail?: ClickTrailEntry[];
  viewport?: { w: number; h: number; dpr: number };
  shots?: string[];
  replayJson?: string;
}

function captureOrigin(): string | null {
  try {
    return new URL(CAPTURE_URL).origin;
  } catch {
    return null;
  }
}

export function DocCaptureFrame({
  sectionId,
  docSlug,
  currentBody,
}: {
  sectionId: number;
  docSlug: string;
  currentBody: string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const save = async (draft: DraftPayload) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      // 1. Light fields straight onto the section (tester RLS).
      const patch: Record<string, unknown> = {
        route: draft.route ?? null,
        component: draft.component ?? null,
        source_file: draft.sourceFile ?? null,
        selector: draft.selector ?? null,
        element_text: draft.elementText ?? null,
        click_trail: draft.clickTrail ?? [],
        viewport: draft.viewport ?? null,
      };
      if (draft.kind === 'bug' || draft.kind === 'feature') patch.kind = draft.kind;
      // The widget description fills an EMPTY section body, never overwrites one.
      // Its first line doubles as the section's name (TOC + task title).
      if (draft.description && !currentBody.trim()) {
        patch.body = draft.description;
        patch.title = draft.description.trim().split('\n')[0]?.trim().slice(0, 80) ?? '';
      }
      const { error: patchErr } = await getBrowserClient()
        .from('qa_doc_sections')
        .update(patch)
        .eq('id', sectionId);
      if (patchErr) throw new Error(patchErr.message);

      // 2. Blobs → signed storage uploads.
      const shots = draft.shots ?? [];
      const wantReplay = typeof draft.replayJson === 'string' && draft.replayJson.length > 0;
      if (shots.length > 0 || wantReplay) {
        const res = await fetch('/api/docs/section-capture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sectionId, shots: shots.length, replay: wantReplay }),
        });
        if (!res.ok) throw new Error(`capture upload setup ${res.status}`);
        const { uploads } = (await res.json()) as {
          uploads: {
            shots: Array<{ signedUrl: string }>;
            replay: { signedUrl: string } | null;
          };
        };
        const puts: Array<Promise<unknown>> = [];
        uploads.shots.forEach((target, i) => {
          const dataUrl = shots[i];
          if (!dataUrl || !target?.signedUrl) return;
          puts.push(
            fetch(dataUrl)
              .then((r) => r.blob())
              .then((blob) =>
                fetch(target.signedUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: blob }),
              ),
          );
        });
        if (uploads.replay?.signedUrl && wantReplay) {
          puts.push(
            fetch(uploads.replay.signedUrl, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: draft.replayJson as string,
            }),
          );
        }
        await Promise.all(puts);
      }

      router.push(`/docs/${docSlug}#section-${sectionId}`);
    } catch (e) {
      savingRef.current = false;
      setSaving(false);
      setError(`Couldn't save the capture: ${(e as Error).message}`);
    }
  };

  useFrameHost(captureOrigin(), {
    onActivate: (source, origin) => {
      // Repeated activates are fine — the flag is idempotent widget-side.
      source.postMessage({ type: 'qa-pipeline:doc-mode' }, origin);
    },
    onMessage: (data) => {
      if (data.type === 'qa-pipeline:draft' && data.draft && typeof data.draft === 'object') {
        void save(data.draft as DraftPayload);
      }
    },
  });

  return (
    <>
      {saving ? (
        <div
          role="status"
          className="absolute inset-x-0 top-12 z-20 flex items-center gap-2 border-b border-line bg-qa-soft px-4 py-2 text-[12.5px] text-qa"
        >
          <span className="spinner" aria-hidden /> Saving the capture to your section…
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="absolute inset-x-0 top-12 z-20 border-b border-red/30 bg-red-soft px-4 py-2 text-[12.5px] text-red"
        >
          {error}
        </div>
      ) : null}
      <iframe
        src={CAPTURE_URL}
        title="the host app — attach context"
        className="block h-[calc(100dvh-3rem)] w-full border-0"
      />
    </>
  );
}
