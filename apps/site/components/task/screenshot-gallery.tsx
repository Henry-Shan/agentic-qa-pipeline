'use client';

// Mobile-report hero (contracts § Mobile reports on the task page): the
// screenshot gallery replaces the web preview iframe/offline strip — replay
// and the preview embed don't apply to mobile captures. Large primary image
// (served via the signed-URL redirect at /api/shot/[id]?i=N), thumbnails to
// switch, and ← / → keys navigate (ignored while typing in the steer box).

import { useEffect, useState } from 'react';
import type { QaReport } from '@/lib/types';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

export function ScreenshotGallery({ report }: { report: QaReport }) {
  const shots = report.screenshots;
  const [rawIndex, setIndex] = useState(0);
  const count = shots.length;
  // Live report updates can change the screenshot list — keep the index valid.
  const index = Math.min(rawIndex, Math.max(0, count - 1));

  useEffect(() => {
    if (count < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setIndex((prev) =>
        event.key === 'ArrowLeft' ? (prev - 1 + count) % count : (prev + 1) % count,
      );
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [count]);

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-stage">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2.5 py-1.5">
        <span className="flex-none text-[11px] font-semibold text-ink-2">
          📱 mobile capture
        </span>
        {count > 1 ? (
          <span className="flex-none font-mono text-[10.5px] tabular-nums text-ink-3">
            {index + 1} / {count} · ← → to switch
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {count > 0 ? (
          <a
            href={`/api/shot/${report.id}?i=${index}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-none rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-qa transition-colors hover:bg-qa-soft"
          >
            Open full size ↗
          </a>
        ) : null}
      </div>

      {count === 0 ? (
        <div className="grid min-h-[200px] place-items-center px-4 py-8 text-[12.5px] text-ink-3">
          No screenshots came with this mobile report.
        </div>
      ) : (
        <>
          <div className="grid place-items-center bg-paper p-3">
            {/* Signed-URL redirect; plain img on purpose (next/image can't follow it). */}
            <img
              key={index}
              src={`/api/shot/${report.id}?i=${index}`}
              alt={
                index === 0
                  ? 'Screenshot with the reported element marked'
                  : `Additional screenshot ${index + 1}`
              }
              className="max-h-[62vh] w-auto max-w-full rounded-lg border border-line bg-surface object-contain md:min-h-[320px]"
            />
          </div>

          {count > 1 ? (
            <div className="flex flex-wrap gap-2 border-t border-line px-3 py-2.5">
              {shots.map((path, i) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-label={`Show screenshot ${i + 1}`}
                  aria-current={i === index}
                  className={`overflow-hidden rounded-lg border transition-colors ${
                    i === index ? 'border-qa-bright' : 'border-line hover:border-qa-bright/60'
                  }`}
                >
                  <img
                    src={`/api/shot/${report.id}?i=${i}`}
                    alt=""
                    className="h-16 w-auto max-w-[120px] bg-surface object-contain"
                  />
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
