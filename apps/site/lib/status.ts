import type { ReportStatus } from '@/lib/types';

export type TabKey = 'all' | 'fixing' | 'preview' | 'queued' | 'shipped';

export const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'fixing', label: 'Fixing' },
  { key: 'preview', label: 'Preview' },
  { key: 'queued', label: 'Queued' },
  { key: 'shipped', label: 'Shipped' },
];

/** Board filter bucket for a status; null → visible only under "All". */
export function tabOf(status: ReportStatus): Exclude<TabKey, 'all'> | null {
  switch (status) {
    case 'running':
    case 'rework':
      return 'fixing';
    case 'pr_ready':
    case 'preview':
      return 'preview';
    case 'queued':
      return 'queued';
    case 'verified':
    case 'shipped':
      return 'shipped';
    default:
      return null;
  }
}

export interface PillSpec {
  label: string;
  cls: string;
  working?: boolean;
}

export const STATUS_PILL: Record<ReportStatus, PillSpec> = {
  queued: { label: 'Queued', cls: 'bg-line-soft text-ink-2' },
  running: { label: 'Claude working', cls: 'bg-amber-soft text-amber', working: true },
  rework: { label: 'Reworking', cls: 'bg-amber-soft text-amber', working: true },
  pr_ready: { label: 'PR ready', cls: 'bg-qa-soft text-qa' },
  preview: { label: 'Preview live', cls: 'bg-qa-soft text-qa' },
  verified: { label: '✓ Verified', cls: 'bg-green-soft text-green' },
  shipped: { label: '✓ Shipped', cls: 'bg-green-soft text-green' },
  failed: { label: 'Failed', cls: 'bg-red-soft text-red' },
  blocked: { label: 'Blocked — needs a human', cls: 'bg-red-soft text-red' },
  stopped: { label: 'Stopped', cls: 'bg-line-soft text-ink-3' },
  cancelled: { label: 'Cancelled', cls: 'bg-line-soft text-ink-3' },
};

export const PIPELINE_STAGES = ['Filed', 'Queued', 'Fixing', 'PR ready', 'Preview', 'Verified'] as const;

export interface PipeSpec {
  /** Stages 0..done-1 render as completed. */
  done: number;
  now?: { index: number; tone: 'amber' | 'teal' | 'neutral' };
  /** Overrides the last stage label (e.g. "Shipped"). */
  finalLabel?: string;
  /** Terminal badge instead of remaining stages (blocked/stopped/failed/cancelled). */
  badge?: { label: string; tone: 'red' | 'gray' };
}

export function pipeFor(status: ReportStatus): PipeSpec {
  switch (status) {
    case 'queued':
      return { done: 1, now: { index: 1, tone: 'neutral' } };
    case 'running':
    case 'rework':
      return { done: 2, now: { index: 2, tone: 'amber' } };
    case 'pr_ready':
    case 'preview':
      return { done: 4, now: { index: 4, tone: 'teal' } };
    case 'verified':
      return { done: 6 };
    case 'shipped':
      return { done: 6, finalLabel: 'Shipped' };
    case 'failed':
      return { done: 2, badge: { label: 'Failed', tone: 'red' } };
    case 'blocked':
      return { done: 2, badge: { label: 'Blocked', tone: 'red' } };
    case 'stopped':
      return { done: 2, badge: { label: 'Stopped', tone: 'gray' } };
    case 'cancelled':
      return { done: 1, badge: { label: 'Cancelled', tone: 'gray' } };
  }
}
