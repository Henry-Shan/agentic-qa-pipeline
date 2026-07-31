'use client';

import { useEffect, useRef } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';

export interface LiveSub {
  table: string;
  filter?: string;
}

/**
 * Subscribes to postgres_changes for the given tables; on channel failure falls
 * back to invoking `refetch` every 5s until the channel recovers.
 * `onDelete` (optional) receives DELETE events — payloads carry the old row's
 * primary key only, which is enough to drop it from local state.
 */
export function useLive(
  channelName: string,
  subs: LiveSub[],
  onRow: (table: string, row: Record<string, unknown>) => void,
  refetch: () => void,
  onDelete?: (table: string, oldRow: Record<string, unknown>) => void,
): void {
  const onRowRef = useRef(onRow);
  onRowRef.current = onRow;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const subsKey = JSON.stringify(subs);

  useEffect(() => {
    const supabase = getBrowserClient();
    const parsed = JSON.parse(subsKey) as LiveSub[];
    let poll: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const startPoll = () => {
      if (!disposed && !poll) poll = setInterval(() => refetchRef.current(), 5000);
    };
    const stopPoll = () => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    };

    let channel = supabase.channel(channelName);
    for (const sub of parsed) {
      channel = channel.on(
        'postgres_changes',
        { event: '*' as const, schema: 'public', table: sub.table, filter: sub.filter },
        (payload: { eventType?: string; new?: unknown; old?: unknown }) => {
          if (payload.eventType === 'DELETE') {
            const old = payload.old;
            if (old && typeof old === 'object' && Object.keys(old).length > 0) {
              onDeleteRef.current?.(sub.table, old as Record<string, unknown>);
            }
            return;
          }
          const row = payload.new;
          if (row && typeof row === 'object' && Object.keys(row).length > 0) {
            onRowRef.current(sub.table, row as Record<string, unknown>);
          }
        },
      );
    }
    channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        stopPoll();
        refetchRef.current(); // catch anything missed while (re)connecting
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        startPoll();
      }
    });

    return () => {
      disposed = true;
      stopPoll();
      void supabase.removeChannel(channel);
    };
  }, [channelName, subsKey]);
}
