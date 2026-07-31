// The drawer's "Replay · what Claude will see" step list — a LIVE view over the
// trail ring (contract §Widget drawer replay-first). Kept out of ui.ts so it can
// be unit-tested without pulling in rrweb/modern-screenshot.
//
// Live-append contract:
//  · `sync(entries)` renders ONLY what is new — the rows already on screen are
//    never rebuilt (no re-render thrash, no lost scroll position, no flicker).
//  · The newest step can also be UPDATED in place (buffers coalesces a typing
//    burst into one entry) — that row's label is refreshed, not re-created.
//  · New rows flash teal briefly, unless prefers-reduced-motion.
//  · The list auto-scrolls to the newest row ONLY when it was already scrolled
//    near the bottom — a tester who scrolled up is never yanked back down.
//  · Identity, not indexes, anchors the diff: `clickTrail()` hands back the same
//    entry OBJECTS every call (Ring.list() is a shallow copy), so the last
//    rendered entry is found by reference. If it moved (the 200-entry ring
//    evicted from the head) the list rebuilds so the numbering stays honest.

import type { ClickTrailEntry, StepKind } from './types';

/** How close to the bottom still counts as "following the newest step". */
const NEAR_BOTTOM_PX = 48;
/** Teal flash lifetime on a freshly appended row. */
const FLASH_MS = 900;
const CLICK_TEXT_CHARS = 44;

export interface TrailListOptions {
  /** Defaults to matchMedia('(prefers-reduced-motion: reduce)'). */
  reducedMotion?: boolean;
  /** Test seam: how "already scrolled near the bottom" is measured. */
  nearBottom?: (el: HTMLElement) => boolean;
  /**
   * Two-way sync with the mini player (contract "Player UX"): a row click asks
   * the player to seek to that step. `index` is 0-based (row 1 → 0).
   */
  onPick?: (index: number) => void;
}

export interface TrailSyncResult {
  /** Rows appended by this sync. */
  added: number;
  /** Whether the newest row's label was refreshed in place (coalesced typing). */
  updated: boolean;
  /** Whether the list auto-scrolled to the newest row. */
  scrolled: boolean;
  /** Steps now rendered — the header's live count. */
  total: number;
}

export interface TrailList {
  el: HTMLOListElement;
  count(): number;
  sync(entries: ClickTrailEntry[]): TrailSyncResult;
  /**
   * Highlight the row the player is parked on (0-based) and scroll it into
   * view; `null`/out-of-range clears the highlight. Survives live appends and
   * rebuilds — the same row stays lit.
   */
  setActive(index: number | null): void;
  /** The highlighted row, or -1. */
  active(): number;
  dispose(): void;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** True when the entry carries step metadata (i.e. it is not a bare route marker). */
function isTargeted(entry: ClickTrailEntry): boolean {
  return Boolean(entry.selector ?? entry.text ?? entry.testid ?? entry.component);
}

/**
 * The ONE source of truth for a step's short human label — rendered in the
 * drawer's numbered list AND carried in the `qa-step` marker payload
 * (contract §Session replay "Step markers"), so list and player always agree.
 */
export function stepLabel(entry: ClickTrailEntry): string {
  if (entry.kind === 'input') {
    if (entry.value === 'checked' || entry.value === 'unchecked') {
      const name = entry.text ?? entry.testid ?? entry.component ?? 'field';
      return `toggled ${truncate(name, 26)} · ${entry.value}`;
    }
    const where = entry.text ?? entry.testid ?? entry.component;
    const typed = `typed "${truncate(entry.value ?? '', 32)}"`;
    return where ? `${typed} · ${truncate(where, 22)}` : typed;
  }
  if (entry.text === 'pressed Enter') return 'pressed Enter';
  const label = entry.text ?? entry.testid ?? entry.component;
  return label ? truncate(label, CLICK_TEXT_CHARS) : entry.route;
}

/** Row icon for one trail entry (contract replay-first icons). */
export function stepIcon(entry: ClickTrailEntry): string {
  if (entry.kind === 'input') {
    return entry.value === 'checked' || entry.value === 'unchecked' ? '☑' : '⌨';
  }
  if (entry.text === 'pressed Enter') return '⏎';
  // Mirrors stepLabel: a step with no human name falls back to its route.
  return entry.text ?? entry.testid ?? entry.component ? '⊕' : '→';
}

/** Marker `kind` for one trail entry — route markers carry no `kind` of their own. */
export function stepKind(entry: ClickTrailEntry): StepKind {
  if (entry.kind) return entry.kind;
  return isTargeted(entry) ? 'click' : 'route';
}

/** Icon + label for one trail entry (contract replay-first icons). */
export function stepView(entry: ClickTrailEntry): { icon: string; label: string } {
  return { icon: stepIcon(entry), label: stepLabel(entry) };
}

/** Scroll geometry check — pure, so the "don't yank the view" rule is testable. */
export function isNearBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack: number = NEAR_BOTTOM_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;
}

export function createTrailList(
  initial: ClickTrailEntry[] = [],
  opts: TrailListOptions = {},
): TrailList {
  const el = document.createElement('ol');
  el.className = 'replay-list';
  const flash = !(opts.reducedMotion ?? prefersReducedMotion());
  const measure = opts.nearBottom ?? ((node: HTMLElement) => isNearBottom(node));
  const timers = new Set<number>();
  let rendered: ClickTrailEntry[] = [];
  let empty: HTMLLIElement | null = null;
  /** Row the player is parked on — survives appends and rebuilds. */
  let activeIndex = -1;

  function showEmpty(): void {
    if (empty) return;
    const li = document.createElement('li');
    li.className = 'replay-empty';
    li.textContent = 'No steps yet — keep using the app and they appear here';
    el.appendChild(li);
    empty = li;
  }

  function clearEmpty(): void {
    empty?.remove();
    empty = null;
  }

  function paintRow(li: HTMLLIElement, entry: ClickTrailEntry, index: number): void {
    const view = stepView(entry);
    const num = li.querySelector('.rs-num');
    const ico = li.querySelector('.rs-ico');
    const lbl = li.querySelector('.rs-lbl');
    if (num && ico && lbl) {
      num.textContent = String(index + 1);
      ico.textContent = view.icon;
      lbl.textContent = view.label;
      return;
    }
    li.textContent = '';
    for (const [cls, text] of [
      ['rs-num', String(index + 1)],
      ['rs-ico', view.icon],
      ['rs-lbl', view.label],
    ] as const) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      li.appendChild(span);
    }
  }

  function row(entry: ClickTrailEntry, index: number): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'replay-step';
    paintRow(li, entry, index);
    return li;
  }

  function rows(): HTMLLIElement[] {
    return Array.from(el.querySelectorAll('li.replay-step'));
  }

  function markFresh(li: HTMLLIElement): void {
    if (!flash) return;
    li.classList.add('fresh');
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      li.classList.remove('fresh');
    }, FLASH_MS);
    timers.add(timer);
  }

  /**
   * Highlight one row and bring it into view. The scroll is a direct scrollTop
   * write — instant, so prefers-reduced-motion needs no special case and the
   * surrounding drawer is never yanked (scrollIntoView would scroll ancestors).
   */
  function paintActive(): void {
    const list = rows();
    list.forEach((li, i) => li.classList.toggle('active', i === activeIndex));
    const li = activeIndex >= 0 ? list[activeIndex] : undefined;
    if (!li) return;
    try {
      const top = li.offsetTop;
      const bottom = top + li.offsetHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    } catch {
      /* detached / jsdom has no layout */
    }
  }

  function rebuild(entries: ClickTrailEntry[]): void {
    el.textContent = '';
    empty = null;
    entries.forEach((entry, i) => el.appendChild(row(entry, i)));
    rendered = entries.slice();
    if (rendered.length === 0) showEmpty();
    if (activeIndex >= entries.length) activeIndex = -1;
    paintActive();
  }

  function scrollToNewest(): void {
    try {
      el.scrollTop = el.scrollHeight;
    } catch {
      /* detached / jsdom */
    }
  }

  // Clicking a row seeks the player to that step (list and video are one
  // control). Delegated, so rows appended live are pickable with no rebinding.
  const pick = opts.onPick;
  const onRowClick = (e: Event): void => {
    if (!pick) return;
    const target = e.target;
    const li = target instanceof Element ? target.closest('li.replay-step') : null;
    if (!(li instanceof HTMLLIElement)) return;
    const index = rows().indexOf(li);
    if (index >= 0) pick(index);
  };
  if (pick) {
    el.classList.add('pickable');
    el.addEventListener('click', onRowClick);
  }

  rebuild(initial);

  return {
    el,
    count: () => rendered.length,
    active: () => activeIndex,
    setActive: (index) => {
      const next = index === null || index < 0 || index >= rendered.length ? -1 : Math.trunc(index);
      activeIndex = next;
      paintActive();
    },
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if (pick) el.removeEventListener('click', onRowClick);
    },
    sync: (entries) => {
      const result: TrailSyncResult = { added: 0, updated: false, scrolled: false, total: entries.length };
      if (rendered.length === 0) {
        if (entries.length === 0) return result;
        const following = measure(el);
        clearEmpty();
        entries.forEach((entry, i) => {
          const li = row(entry, i);
          markFresh(li);
          el.appendChild(li);
        });
        rendered = entries.slice();
        result.added = entries.length;
        if (following) {
          scrollToNewest();
          result.scrolled = true;
        }
        return result;
      }

      const tail = rendered[rendered.length - 1];
      if (!tail) {
        rebuild(entries);
        result.added = entries.length;
        return result;
      }
      let at = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i] === tail) {
          at = i;
          break;
        }
      }
      // Tail gone (ring eviction / a different trail) or the head shifted:
      // rebuild so every row's number matches its position in the trail.
      if (at === -1 || at !== rendered.length - 1) {
        const following = measure(el);
        const before = rendered.length;
        rebuild(entries);
        if (following && entries.length > 0) {
          scrollToNewest();
          result.scrolled = true;
        }
        result.added = Math.max(0, entries.length - before);
        return result;
      }

      const following = measure(el);
      const existing = rows();
      // The newest step may have been coalesced in place (typing) — repaint it.
      const lastRow = existing[existing.length - 1];
      if (lastRow) {
        const before = lastRow.querySelector('.rs-lbl')?.textContent ?? '';
        paintRow(lastRow, tail, rendered.length - 1);
        result.updated = (lastRow.querySelector('.rs-lbl')?.textContent ?? '') !== before;
      }

      const fresh = entries.slice(at + 1);
      if (fresh.length === 0) return result;
      for (let i = 0; i < fresh.length; i++) {
        const entry = fresh[i];
        if (!entry) continue;
        const li = row(entry, at + 1 + i);
        markFresh(li);
        el.appendChild(li);
      }
      rendered = entries.slice();
      result.added = fresh.length;
      if (following) {
        scrollToNewest();
        result.scrolled = true;
      }
      return result;
    },
  };
}
