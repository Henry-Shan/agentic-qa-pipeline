// Base context (contracts §Base context).
//
// A run can START from an existing Claude Code session instead of cold — the
// "base-context" session, which already holds an accumulated understanding of
// the the host app codebase. The spawn becomes `--resume <base> --fork-session`,
// which branches: the fork inherits the parent's context and the PARENT IS
// NEVER WRITTEN TO (verified — the parent transcript gains nothing).
//
// The one constraint: Claude Code scopes sessions to the project directory
// derived from cwd. base-context lives under the user's own checkout
// (~/the host app) while runs execute from the runner clone, so `--resume` there
// finds nothing. We therefore STAGE a copy of the transcript into the runner's
// project directory. The copy is read-only input; forks write new session ids.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './util';

/** Claude Code's project-directory encoding: the abs path with / → -. */
export function projectDir(repoPath: string): string {
  return path.join(os.homedir(), '.claude', 'projects', repoPath.replace(/\//g, '-'));
}

function transcript(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.jsonl`);
}

/**
 * Make `sessionId` resumable from a run spawned with cwd=runnerRepo. Returns
 * true when the transcript is in place. Never throws — a base session that
 * cannot be staged simply means the run starts cold, which is always valid.
 */
export function stageBaseSession(sessionId: string, runnerRepo: string, sourceRepo: string): boolean {
  try {
    const target = projectDir(runnerRepo);
    const dest = transcript(target, sessionId);
    const src = transcript(projectDir(sourceRepo), sessionId);

    if (!fs.existsSync(src)) {
      // Already staged from an earlier run (or the source checkout moved) — the
      // staged copy is enough to fork from.
      if (fs.existsSync(dest)) return true;
      log('base', `base session ${sessionId} not found under ${sourceRepo} — running cold`);
      return false;
    }
    // Re-copy only when the source moved on; these transcripts are large.
    if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return true;

    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(src, dest);
    log('base', `staged base session ${sessionId} for the runner repo`);
    return true;
  } catch (e) {
    log('base', `staging base session failed (${(e as Error).message}) — running cold`);
    return false;
  }
}
