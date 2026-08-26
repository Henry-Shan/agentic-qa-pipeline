import { pathToFileURL } from 'node:url';
import { startClaimLoop } from './claim';
import { acquireLock, loadConfig, type WorkerConfig } from './config';
import { Db } from './db';
import { stopAllPreviews } from './preview';
import { reconcile, startOrphanWatcher } from './reconcile';
import { maxPreviews, maxRuns, refreshSettings, startSettingsLoop } from './settings';
import { startShim } from './shim';
import { startShipLoop } from './ship';
import { startTerminalHost } from './term';
import { WorkerState, type Ctx } from './state';
import { startSteerLoop } from './steer';
import { startFrontDoor } from './frontdoor';
import { startPreviewSyncLoop } from './preview-sync';
import { log } from './util';

export interface WorkerHandle {
  ctx: Ctx;
  stop(): Promise<void>;
}

export async function startWorker(cfg: WorkerConfig): Promise<WorkerHandle> {
  const ctx: Ctx = { cfg, db: new Db(cfg), state: new WorkerState() };
  const releaseLock = acquireLock(cfg);
  try {
    // Before reconcile: reconcile re-publishes the tunnel, and every preview
    // request goes through this. Starting it after would leave a window where
    // every task URL 502s.
    const frontDoor = startFrontDoor(ctx);
    await reconcile(ctx);
    // Initial qa_settings fetch (site-editable limits); table missing → env values.
    await refreshSettings(ctx).catch((e: Error) => log('settings', `initial fetch failed — using env limits: ${e.message}`));
    const shim = await startShim(ctx);
    const closeTerminals = startTerminalHost(ctx);
    const timers = [startClaimLoop(ctx), startSteerLoop(ctx), startShipLoop(ctx), startOrphanWatcher(ctx), startSettingsLoop(ctx), startPreviewSyncLoop(ctx)];
    log('worker', `up — shim 127.0.0.1:${cfg.shimPort} · runner ${cfg.runnerRepo} · max ${maxRuns(ctx)} runs / ${maxPreviews(ctx)} previews / ${cfg.runsPerDay} runs-per-day · preview ${cfg.previewMode}`);
    return {
      ctx,
      async stop(): Promise<void> {
        for (const t of timers) clearInterval(t);
        closeTerminals();
        if (frontDoor) await new Promise<void>((resolve) => frontDoor.close(() => resolve()));
        await new Promise<void>((resolve) => shim.close(() => resolve()));
        releaseLock();
      },
    };
  } catch (e) {
    releaseLock();
    throw e;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const handle = await startWorker(cfg);
  let shuttingDown = false;
  const shutdown = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('worker', `${sig} received — graceful shutdown (previews stopped + down-marked, runs left running)`);
    void (async () => {
      try {
        await stopAllPreviews(handle.ctx);
      } catch (e) {
        log('worker', `preview shutdown failed: ${(e as Error).message}`);
      }
      await handle.stop();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e: Error) => {
    console.error(e);
    process.exit(1);
  });
}
