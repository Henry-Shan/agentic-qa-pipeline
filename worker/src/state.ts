import type { ChildProcess } from 'node:child_process';
import { pidAlive, type WorkerConfig } from './config';
import type { Db } from './db';

export interface RunHandle {
  runId: number;
  reportId: number;
  sessionId: string;
  /** Process-group leader (detached spawn); null until spawned. */
  pid: number | null;
  /** Null for runs re-attached after a worker restart (no stdout stream). */
  child: ChildProcess | null;
  stopRequested: boolean;
  steerInterrupt: boolean;
  runinfoReceived: boolean;
}

export interface PreviewHandle {
  runId: number;
  reportId: number;
  worktree: string;
  port: number;
  pid: number;
  hostname: string | null;
  startedAt: number;
}

export interface Ctx {
  cfg: WorkerConfig;
  db: Db;
  state: WorkerState;
}

export class WorkerState {
  private readonly bySession = new Map<string, RunHandle>();
  private readonly byReport = new Map<number, RunHandle>();
  readonly previews = new Map<number, PreviewHandle>();
  private readonly askPendingReports = new Set<number>();
  /** Rate-limit cooldown: claim loop stays idle until this epoch-ms. */
  cooldownUntil = 0;
  /** Spawned-and-not-yet-settled runs (part of the MAX_RUNS gate). */
  activeDispatches = 0;

  registerRun(h: RunHandle): void {
    this.bySession.set(h.sessionId, h);
    this.byReport.set(h.reportId, h);
  }

  removeRun(h: RunHandle): void {
    if (this.bySession.get(h.sessionId) === h) this.bySession.delete(h.sessionId);
    if (this.byReport.get(h.reportId) === h) this.byReport.delete(h.reportId);
  }

  runBySession(sessionId: string): RunHandle | null {
    return this.bySession.get(sessionId) ?? null;
  }

  runByReport(reportId: number): RunHandle | null {
    return this.byReport.get(reportId) ?? null;
  }

  allRunHandles(): RunHandle[] {
    return [...this.bySession.values()];
  }

  runAlive(h: RunHandle): boolean {
    return h.pid !== null && pidAlive(h.pid);
  }

  setAskPending(reportId: number, pending: boolean): void {
    if (pending) this.askPendingReports.add(reportId);
    else this.askPendingReports.delete(reportId);
  }

  askPending(reportId: number): boolean {
    return this.askPendingReports.has(reportId);
  }
}
