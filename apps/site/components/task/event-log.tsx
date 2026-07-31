'use client';

import { useEffect, useRef } from 'react';
import { timeOf } from '@/lib/format';
import type { QaEvent } from '@/lib/types';

const TYPE_CLS: Record<string, string> = {
  log: 'text-ink-2',
  phase: 'font-semibold text-qa',
  error: 'text-red',
  question: 'font-semibold text-amber',
  system: 'italic text-ink-3',
};

export function EventLog({ events }: { events: QaEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const visible = events.filter((e) => e.type in TYPE_CLS);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  return (
    <div
      ref={scrollRef}
      className="max-h-[420px] overflow-y-auto rounded-[10px] border border-line bg-canvas px-3 py-2.5 font-mono text-[11.5px] leading-[1.9]"
    >
      {visible.length === 0 ? (
        <div className="text-ink-3">Waiting for the worker to pick this up…</div>
      ) : (
        visible.map((event) => (
          <div key={event.id} className={`whitespace-pre-wrap ${TYPE_CLS[event.type] ?? 'text-ink-2'}`}>
            <span suppressHydrationWarning className="mr-2 tabular-nums text-ink-3">
              {timeOf(event.ts)}
            </span>
            {event.message ?? ''}
          </div>
        ))
      )}
    </div>
  );
}
