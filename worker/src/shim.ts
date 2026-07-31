import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { autoAssignOnBlock } from './assign';
import type { FileChanged, GroundingChip, QaRun } from './db';
import { SHIM_TOKEN } from './dispatch';
import { startPreview } from './preview';
import type { Ctx } from './state';
import { log, parsePrNumber } from './util';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Constant-time token check (hash both sides so timingSafeEqual gets equal-length buffers). */
function shimTokenMatches(provided: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(SHIM_TOKEN).digest();
  return timingSafeEqual(a, b);
}

/** Resolve `worktree` and require it inside cfg.worktreeBase; null = reject. */
function resolveWorktree(worktreeBase: string, raw: string): string | null {
  const base = path.resolve(worktreeBase);
  const resolved = path.resolve(raw);
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

interface RuninfoBody {
  session_id?: string;
  pr_url?: string;
  branch?: string;
  worktree?: string;
  test_plan?: string;
  files_changed?: FileChanged[];
  grounding?: GroundingChip[];
  pr_number?: number;
  tier?: number;
}

function respond(res: http.ServerResponse, code: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

async function findRunBySession(ctx: Ctx, sessionId: string): Promise<QaRun | null> {
  return await ctx.db.runBySession(sessionId);
}

/** ship-task's callback contract, translated to Supabase writes. Localhost only. */
export function startShim(ctx: Ctx): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void route(ctx, req, res).catch((e: Error) => {
      log('shim', `handler error ${req.method} ${req.url ?? ''}: ${e.message}`);
      if (!res.headersSent) respond(res, 500, { error: 'internal error' });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ctx.cfg.shimPort, '127.0.0.1', () => {
      log('shim', `listening on 127.0.0.1:${ctx.cfg.shimPort}`);
      resolve(server);
    });
  });
}

async function route(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const shimHeader = req.headers['x-qa-shim'];
  if (typeof shimHeader !== 'string' || !shimTokenMatches(shimHeader)) {
    respond(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  switch (key) {
    case 'POST /api/runinfo':
      return handleRuninfo(ctx, req, res);
    case 'POST /api/featuretest':
      return handleFeaturetest(ctx, req, res);
    case 'POST /api/ask':
      return handleAsk(ctx, req, res);
    case 'POST /api/progress':
      return handleProgress(ctx, req, res);
    case 'GET /api/answer':
      return handleAnswer(ctx, url, res);
    default:
      respond(res, 404, { error: 'not found' });
  }
}

async function handleRuninfo(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as RuninfoBody | null;
  if (!body || typeof body.session_id !== 'string' || !body.session_id) {
    respond(res, 400, { error: 'session_id required' });
    return;
  }
  const run = await findRunBySession(ctx, body.session_id);
  if (!run) {
    respond(res, 404, { error: 'unknown session' });
    return;
  }
  const patch: Record<string, unknown> = { phase: 'pr' };
  if (typeof body.worktree === 'string' && body.worktree) {
    const resolved = resolveWorktree(ctx.cfg.worktreeBase, body.worktree);
    if (!resolved) {
      await ctx.db.insertEvent({
        report_id: run.report_id,
        run_id: run.id,
        type: 'error',
        message: `runinfo rejected: worktree outside WORKTREE_BASE (${body.worktree})`,
      });
      respond(res, 400, { error: 'worktree outside WORKTREE_BASE' });
      return;
    }
    patch.worktree = resolved;
  }
  if (typeof body.branch === 'string' && body.branch) patch.branch = body.branch;
  if (typeof body.pr_url === 'string' && body.pr_url) {
    patch.pr_url = body.pr_url;
    patch.pr_number = typeof body.pr_number === 'number' ? body.pr_number : parsePrNumber(body.pr_url);
  }
  if (typeof body.test_plan === 'string' && body.test_plan) patch.test_plan = body.test_plan;
  if (Array.isArray(body.files_changed)) patch.files_changed = body.files_changed;
  if (Array.isArray(body.grounding)) patch.grounding = body.grounding;
  if (typeof body.tier === 'number') patch.tier = body.tier;

  const updated = (await ctx.db.updateRun(run.id, patch)) ?? run;
  await ctx.db.updateReport(run.report_id, { status: 'pr_ready' });
  const handle = ctx.state.runBySession(body.session_id);
  if (handle) handle.runinfoReceived = true;
  await ctx.db.insertEvent({ report_id: run.report_id, run_id: run.id, type: 'phase', message: 'pr' });
  await ctx.db.insertEvent({
    report_id: run.report_id,
    run_id: run.id,
    type: 'system',
    message: `PR ready: ${typeof body.pr_url === 'string' ? body.pr_url : '(no url)'}`,
  });
  log('shim', `runinfo for run ${run.id}: ${updated.pr_url ?? 'no pr'} @ ${updated.worktree ?? 'no worktree'}`);
  // preview boot is slow — never block the reporting agent on it
  void startPreview(ctx, updated).catch((e: Error) =>
    log('shim', `preview start failed for run ${run.id}: ${e.message}`),
  );
  respond(res, 200, { ok: true });
}

async function handleFeaturetest(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const sessionId = body && typeof body.session_id === 'string' ? body.session_id : '';
  if (!body || !sessionId) {
    respond(res, 400, { error: 'session_id required' });
    return;
  }
  const run = await findRunBySession(ctx, sessionId);
  if (!run) {
    respond(res, 404, { error: 'unknown session' });
    return;
  }
  const { session_id: _drop, ...verdict } = body;
  await ctx.db.updateRun(run.id, { featuretest: verdict });
  await ctx.db.insertEvent({
    report_id: run.report_id,
    run_id: run.id,
    type: 'system',
    message: 'feature-test verdict recorded',
    payload: verdict,
  });
  respond(res, 200, { ok: true });
}

async function handleAsk(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const sessionId = body && typeof body.session_id === 'string' ? body.session_id : '';
  const question = body && typeof body.question === 'string' ? body.question : '';
  if (!body || !sessionId || !question) {
    respond(res, 400, { error: 'session_id and question required' });
    return;
  }
  const run = await findRunBySession(ctx, sessionId);
  if (!run) {
    respond(res, 404, { error: 'unknown session' });
    return;
  }
  await ctx.db.insertEvent({
    report_id: run.report_id,
    run_id: run.id,
    type: 'question',
    message: question,
    payload: {
      options: Array.isArray(body.options) ? body.options : null,
      context: typeof body.context === 'string' ? body.context : null,
    },
  });
  await ctx.db.updateReport(run.report_id, { status: 'blocked' });
  // a parked question is a needs-a-human handoff too — give it an owner
  await autoAssignOnBlock(ctx, run.report_id);
  // the run is now polling GET /api/answer — steer must deliver there, not SIGINT
  ctx.state.setAskPending(run.report_id, true);
  log('shim', `question from run ${run.id}: ${question.slice(0, 120)}`);
  respond(res, 200, { ok: true });
}

async function handleAnswer(ctx: Ctx, url: URL, res: http.ServerResponse): Promise<void> {
  const sessionId = url.searchParams.get('session_id') ?? '';
  if (!sessionId) {
    respond(res, 400, { error: 'session_id required' });
    return;
  }
  const run = await findRunBySession(ctx, sessionId);
  if (!run) {
    respond(res, 404, { error: 'unknown session' });
    return;
  }
  const msg = await ctx.db.oldestPendingAnswer(run.report_id);
  if (!msg) {
    respond(res, 200, { answer: null });
    return;
  }
  await ctx.db.updateMessage(msg.id, 'done');
  ctx.state.setAskPending(run.report_id, false);
  await ctx.db.updateReport(run.report_id, { status: 'running' });
  await ctx.db.insertEvent({
    report_id: run.report_id,
    run_id: run.id,
    type: 'system',
    message: `answer delivered to run: ${msg.body.slice(0, 200)}`,
  });
  respond(res, 200, { answer: msg.body });
}

async function handleProgress(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const sessionId = body && typeof body.session_id === 'string' ? body.session_id : '';
  const phase = body && typeof body.phase === 'string' ? body.phase.slice(0, 40) : '';
  if (!body || !sessionId || !phase) {
    respond(res, 400, { error: 'session_id and phase required' });
    return;
  }
  const run = await findRunBySession(ctx, sessionId);
  if (!run) {
    respond(res, 404, { error: 'unknown session' });
    return;
  }
  await ctx.db.updateRun(run.id, { phase });
  await ctx.db.insertEvent({ report_id: run.report_id, run_id: run.id, type: 'phase', message: phase });
  respond(res, 200, { ok: true });
}
