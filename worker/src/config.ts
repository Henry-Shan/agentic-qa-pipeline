import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PreviewMode = 'local' | 'tunnel';

export interface WorkerConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  runnerRepo: string;
  worktreeBase: string;
  claudeBin: string;
  /** QA_CLAUDE_MODEL — `--model` for every real claude spawn (alias or full id). */
  claudeModel: string;
  /** QA_CLAUDE_EFFORT — `--effort` for every real claude spawn (low…max). */
  claudeEffort: string;
  /** QA_EXAMINER_MODEL / _EFFORT — the examination's judge (contracts §Examination). */
  examinerModel: string;
  examinerEffort: string;
  /** QA_EXAM=0 disables the examination loop entirely. */
  examEnabled: boolean;
  /**
   * QA_BASE_SESSION — Claude Code session id every fresh run FORKS from
   * (contracts §Base context); '' runs cold. A report's own base_session wins.
   */
  baseSession: string;
  /** QA_BASE_SESSION_REPO — checkout whose project dir holds that transcript. */
  baseSessionRepo: string;
  shimPort: number;
  maxRuns: number;
  maxPreviews: number;
  runsPerDay: number;
  previewMode: PreviewMode;
  previewDomain: string;
  cfTunnelName: string;
  siteUrl: string;
  /** QA_DEFAULT_ASSIGNEE — fallback tester display name for auto-assign-on-block. */
  defaultAssignee: string;
  /** State dir (~/.qa-pipeline): worker.lock, runs/, PAUSED, cloudflared.yml. */
  qaHome: string;
  /** QA_MOCK_DISPATCH=1 — spawn mock/mock-run.mjs instead of claude (selftest). */
  mockDispatch: boolean;
  /** PREVIEW_CMD override; the chosen port is appended to this command string. */
  previewCmd: string | null;
  /** Gap between dispatch STARTS — ship-task's setup-worktree pulls the base
   *  branch in the runner checkout, and two concurrent setups corrupt it. */
  dispatchStaggerMs: number;
  /** Selftest guard: only ever claim/steer this report id. */
  onlyReportId: number | null;
}

// worker/ dir: ../ from both src/ (tsx dev) and dist/ (bundled).
const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function workerDir(): string {
  return WORKER_DIR;
}

/** Minimal .env loader; real process env always wins (so tests can override). */
function loadDotEnv(): void {
  const file = path.join(WORKER_DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !m[1]) continue;
    let val = m[2] ?? '';
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

function intEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function loadConfig(): WorkerConfig {
  loadDotEnv();
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (worker/.env)');
  }
  const previewMode = process.env.PREVIEW_MODE ?? 'local';
  if (previewMode !== 'local' && previewMode !== 'tunnel') {
    throw new Error(`PREVIEW_MODE must be local|tunnel, got "${previewMode}"`);
  }
  const rawHome = process.env.QA_HOME;
  const qaHome = rawHome
    ? path.resolve(rawHome.replace(/^~(?=\/|$)/, os.homedir()))
    : path.join(os.homedir(), '.qa-pipeline');
  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    runnerRepo: process.env.RUNNER_REPO ?? '/Users/YOU/qa-pipeline-runner/the host app',
    worktreeBase: process.env.WORKTREE_BASE ?? '/Users/YOU/qa-pipeline-worktrees',
    claudeBin: process.env.CLAUDE_BIN ?? '/opt/homebrew/bin/claude',
    claudeModel: process.env.QA_CLAUDE_MODEL?.trim() || 'opus',
    claudeEffort: process.env.QA_CLAUDE_EFFORT?.trim() || 'xhigh',
    examinerModel: process.env.QA_EXAMINER_MODEL?.trim() || 'opus',
    examinerEffort: process.env.QA_EXAMINER_EFFORT?.trim() || 'high',
    examEnabled: process.env.QA_EXAM !== '0',
    baseSession: process.env.QA_BASE_SESSION?.trim() ?? '',
    baseSessionRepo: process.env.QA_BASE_SESSION_REPO?.trim() || '/Users/YOU/the host app',
    shimPort: intEnv('SHIM_PORT', 4519),
    maxRuns: intEnv('MAX_RUNS', 2),
    maxPreviews: intEnv('MAX_PREVIEWS', 3),
    runsPerDay: intEnv('RUNS_PER_DAY', 25),
    previewMode,
    previewDomain: process.env.PREVIEW_DOMAIN ?? 'qa-preview.example.com',
    cfTunnelName: process.env.CF_TUNNEL_NAME ?? 'qa-pipeline',
    siteUrl: process.env.SITE_URL ?? 'https://qa.example.com',
    defaultAssignee: process.env.QA_DEFAULT_ASSIGNEE?.trim() || 'owner',
    qaHome,
    mockDispatch: process.env.QA_MOCK_DISPATCH === '1',
    previewCmd: process.env.PREVIEW_CMD ?? null,
    dispatchStaggerMs: intEnv('DISPATCH_STAGGER_MS', 60_000),
    onlyReportId: null,
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Singleton lockfile (stale-pid aware). Returns a release function. */
export function acquireLock(cfg: WorkerConfig): () => void {
  fs.mkdirSync(cfg.qaHome, { recursive: true });
  const lockPath = path.join(cfg.qaHome, 'worker.lock');
  if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      throw new Error(`another worker is already running (pid ${pid}, lock ${lockPath})`);
    }
    fs.rmSync(lockPath, { force: true }); // stale lock from a dead worker
  }
  fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  return () => {
    try {
      if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      // already gone
    }
  };
}

export function isPaused(cfg: WorkerConfig): boolean {
  return fs.existsSync(path.join(cfg.qaHome, 'PAUSED'));
}
