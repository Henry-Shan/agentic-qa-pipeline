// Shadow-root stylesheet. Tokens mirror the approved Figma-studio light theme
// (white surfaces, #FAFAFA fills, hairline #ECECF0 borders, teal #0D9488 accent).
// Light-only by design — the QA site renders white for everyone.

export const widgetCss = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.root {
  --paper: #fafafa; --stage: #ffffff;
  --ink: #1e1e1e; --ink-2: #57606a; --ink-3: #9aa4af;
  --line: #ececf0; --line-soft: #f3f4f6;
  --qa: #0d9488; --qa-bright: #14b8a6; --qa-soft: #effaf8; --qa-ring: rgba(13,148,136,.28);
  --qa-contrast: #ffffff;
  --red: #dc2626; --red-soft: #fee2e2; --green: #16a34a;
  --shadow: 0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.05);
  --shadow-big: 0 2px 8px rgba(0,0,0,.06), 0 16px 40px rgba(0,0,0,.10);
  font-family: Inter, -apple-system, "Segoe UI", system-ui, sans-serif;
  font-size: 14px; line-height: 1.5; color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
.mono { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace; }
button { font-family: inherit; }

/* ---- fab + menu ---- */
.qa-fab {
  position: fixed; right: 22px; bottom: 20px; z-index: 10;
  width: 48px; height: 48px; border-radius: 50%; border: none; cursor: pointer;
  background: var(--qa); color: var(--qa-contrast); font-size: 20px;
  display: grid; place-items: center; box-shadow: var(--shadow-big);
}
.qa-fab:hover { transform: scale(1.06); }
.qa-fab:focus-visible { outline: 2px solid var(--qa-bright); outline-offset: 2px; }

/* ---- picker ---- */
.qa-veil { position: fixed; inset: 0; z-index: 40; cursor: crosshair; background: rgba(30,30,30,.06); }
.qa-picker-banner {
  position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 42;
  background: var(--ink); color: var(--paper); font-size: 12.5px; font-weight: 600;
  padding: 7px 16px; border-radius: 999px; box-shadow: var(--shadow);
  white-space: nowrap; pointer-events: none;
}
.qa-spot {
  position: fixed; z-index: 41; pointer-events: none;
  border: 2px solid var(--qa-bright); border-radius: 9px;
  background: rgba(20,184,166,.08); box-shadow: 0 0 0 4px var(--qa-ring);
}
.qa-spot-label {
  position: absolute; bottom: calc(100% + 7px); left: 0; white-space: nowrap;
  background: var(--qa); color: var(--qa-contrast); font-size: 11px; font-weight: 600;
  padding: 4px 10px; border-radius: 6px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.qa-spot-label.below { bottom: auto; top: calc(100% + 7px); }

/* ---- drawer ---- */
.qa-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(360px, 92vw); z-index: 30;
  background: var(--stage); border-left: 1px solid var(--line);
  box-shadow: -2px 0 8px rgba(0,0,0,.06), -16px 0 40px rgba(0,0,0,.10); padding: 20px 22px; overflow-y: auto;
}
.drawer-head { display: flex; align-items: center; gap: 10px; }
.drawer-head .di {
  width: 30px; height: 30px; border-radius: 9px; background: var(--qa-soft); color: var(--qa);
  display: grid; place-items: center; font-size: 15px; flex: none;
}
.drawer-head h3 { font-size: 15px; font-weight: 700; }
.drawer-head .sub { font-size: 11.5px; color: var(--ink-3); }
.drawer-collapse, .drawer-close {
  border: none; background: none; color: var(--ink-3);
  font-size: 18px; line-height: 1; cursor: pointer; padding: 4px 8px; border-radius: 6px;
}
.drawer-collapse { margin-left: auto; font-size: 20px; }
.drawer-collapse:hover, .drawer-close:hover { background: var(--line-soft); color: var(--ink); }
.drawer-collapse:focus-visible, .drawer-close:focus-visible { outline: 2px solid var(--qa-bright); outline-offset: 1px; }
/* collapsed state: a compact pill hugging the right edge (🐛 + live step count) */
.qa-pill {
  position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 31;
  display: flex; align-items: center; gap: 7px; cursor: pointer;
  border: 1px solid var(--line); border-right: none; border-radius: 999px 0 0 999px;
  background: var(--stage); color: var(--ink); font: inherit; font-size: 14px;
  padding: 9px 13px 9px 15px; box-shadow: var(--shadow-big);
}
.qa-pill:hover { border-color: var(--qa-bright); }
.qa-pill:focus-visible { outline: 2px solid var(--qa-bright); outline-offset: 2px; }
.pill-count {
  background: var(--qa-soft); color: var(--qa); border-radius: 999px; padding: 1px 7px;
  font-size: 11.5px; font-weight: 700; font-variant-numeric: tabular-nums;
}
.cap-label {
  font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
  color: var(--ink-3); margin: 14px 0 6px;
}
.cap-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.cap-count { color: var(--qa); font-weight: 700; letter-spacing: .04em; flex: none; }
.live-hint { font-size: 11px; color: var(--ink-3); margin-top: 5px; }
.shots { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.shot-row { display: flex; flex-wrap: wrap; gap: 6px; }
.thumb {
  position: relative; width: 92px; height: 64px; flex: none;
  border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--paper);
}
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; cursor: zoom-in; }
.thumb-x {
  position: absolute; top: 3px; right: 3px; width: 16px; height: 16px; padding: 0;
  border: none; border-radius: 50%; cursor: pointer;
  background: rgba(30,30,30,.72); color: #fff; font-size: 11px; line-height: 1;
  display: grid; place-items: center;
}
.thumb-x:hover { background: var(--red); }
.shots-cap { font-size: 11px; color: var(--ink-3); }
.add-shot {
  border: 1px dashed var(--line); border-radius: 8px; cursor: pointer;
  background: var(--paper); color: var(--ink-2); font: inherit; font-size: 11.5px;
  font-weight: 600; padding: 6px 12px;
}
.add-shot:hover { border-color: var(--qa-bright); color: var(--qa); }
.add-shot:focus-visible { outline: 2px solid var(--qa-bright); outline-offset: 2px; }
/* ---- session-replay mini player (drawer, above the trail list) ---- */
.rr-player { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.rr-stage {
  position: relative; overflow: hidden; width: 100%; aspect-ratio: 16 / 10;
  border: 1px solid var(--line); border-radius: 8px; background: var(--paper);
}
.rr-stage iframe { border: none; background: var(--stage); }
.replayer-wrapper { position: absolute; left: 0; top: 0; }
.replayer-mouse {
  position: absolute; width: 10px; height: 10px; border-radius: 50%;
  background: var(--qa-bright); box-shadow: 0 0 0 3px var(--qa-ring);
  transition: left .05s linear, top .05s linear; pointer-events: none;
}
.replayer-mouse-tail { position: absolute; pointer-events: none; }
.rr-player:focus-visible { outline: 2px solid var(--qa-bright); outline-offset: 2px; border-radius: 8px; }
.rr-controls, .rr-foot { display: flex; align-items: center; gap: 6px; }
.rr-btn {
  border: 1px solid var(--line); border-radius: 6px; background: var(--stage);
  color: var(--ink-2); cursor: pointer; font: inherit; font-size: 11px;
  line-height: 1; padding: 4px 8px; flex: none;
}
.rr-btn:hover:not(:disabled) { border-color: var(--qa-bright); color: var(--qa); }
.rr-btn:focus-visible { outline: 2px solid var(--qa-bright); outline-offset: 1px; }
.rr-btn:disabled { opacity: .4; cursor: default; }
.rr-btn[hidden] { display: none; }
/* side-click zones: left third = back, right third = forward, middle inert */
.rr-edges { position: absolute; inset: 0; z-index: 2; display: flex; }
.rr-edges[hidden] { display: none; }
.rr-edge { flex: 1 1 33.333%; position: relative; }
.rr-edge-m { pointer-events: none; }
.rr-edge-l, .rr-edge-r {
  cursor: pointer; transition: background 140ms ease;
  background: linear-gradient(to right, rgba(13,148,136,0), rgba(13,148,136,0));
}
.rr-edge-l:hover { background: linear-gradient(to right, rgba(13,148,136,.10), rgba(13,148,136,0)); }
.rr-edge-r:hover { background: linear-gradient(to left, rgba(13,148,136,.10), rgba(13,148,136,0)); }
.rr-edge-l::after, .rr-edge-r::after {
  content: '‹'; position: absolute; top: 50%; transform: translateY(-50%);
  font-size: 22px; line-height: 1; font-weight: 700; color: var(--qa);
  opacity: 0; transition: opacity 140ms ease;
}
.rr-edge-l::after { left: 6px; }
.rr-edge-r::after { content: '›'; right: 6px; }
.rr-edge-l:hover::after, .rr-edge-r:hover::after { opacity: .75; }
/* synthetic cursor — its own layer ABOVE the stage, never interactive */
@keyframes rr-land {
  0% { opacity: .9; scale: .35; }
  100% { opacity: 0; scale: 1.25; }
}
/* rail of tick marks — one per step, current one filled, all clickable */
.rr-rail { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
.rr-rail[hidden] { display: none; }
.rr-tick {
  flex: 1 1 4px; min-width: 4px; height: 10px; padding: 0; cursor: pointer;
  border: 1px solid var(--line); border-radius: 2px; background: var(--stage);
  transition: background 120ms ease, border-color 120ms ease;
}
.rr-tick:hover { border-color: var(--qa-bright); }
.rr-tick.on { background: var(--qa); border-color: var(--qa); }
.rr-tick:focus-visible { outline: 2px solid var(--qa-bright); outline-offset: 1px; }
.rr-note {
  font-size: 11.5px; color: var(--ink-3); padding: 10px 12px;
  border: 1px dashed var(--line); border-radius: 8px; background: var(--paper);
}

/* ---- replay-first trail list (primary drawer section) ---- */
.replay-list {
  list-style: none; max-height: 180px; overflow-y: auto;
  border: 1px solid var(--line-soft); border-radius: 8px; background: var(--paper);
  padding: 4px 0;
}
.replay-step {
  display: flex; align-items: baseline; gap: 7px; padding: 3px 10px;
  font-size: 11.5px; color: var(--ink-2);
  transition: opacity 200ms ease, background 200ms ease;
}
.replay-step .rs-num {
  flex: none; min-width: 16px; text-align: right; color: var(--ink-3);
  font-size: 10.5px; font-variant-numeric: tabular-nums;
}
.replay-step .rs-ico { flex: none; color: var(--qa); }
.replay-step .rs-lbl { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* the step the player is parked on — list and video are one control */
.replay-step.active { background: var(--qa-soft); color: var(--qa); font-weight: 600; }
.replay-step.active .rs-num { color: var(--qa); }
.replay-list.pickable .replay-step { cursor: pointer; }
.replay-list.pickable .replay-step:hover { background: var(--line-soft); }
/* a step recorded while the drawer is open lands with a brief teal flash */
.replay-step.fresh { animation: qa-step-in 900ms ease-out; }
@keyframes qa-step-in {
  0% { background: var(--qa-soft); color: var(--qa); }
  100% { background: transparent; color: var(--ink-2); }
}
.replay-empty { padding: 7px 10px; font-size: 11.5px; color: var(--ink-3); }
@media (prefers-reduced-motion: reduce) {
  .replay-step { transition: none; }
  .replay-step.fresh { animation: none; }
  .rr-tick, .rr-edge-l, .rr-edge-r { transition: none; }
}

/* ---- lightbox (thumbnail enlarge) ---- */
.qa-lightbox {
  position: fixed; inset: 0; z-index: 70; cursor: zoom-out;
  background: rgba(30,30,30,.55); display: grid; place-items: center;
}
.qa-lightbox img {
  max-width: min(920px, 92vw); max-height: 86vh; border-radius: 10px;
  background: var(--stage); box-shadow: var(--shadow-big);
}
.chips { display: flex; flex-direction: column; gap: 5px; }
.chip {
  display: flex; align-items: center; gap: 8px; font-size: 11.5px; padding: 6px 10px;
  border: 1px solid var(--line-soft); border-radius: 7px; background: var(--paper);
  color: var(--ink-2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.chip .k { color: var(--ink-3); flex: none; }
.chip.err { border-color: rgba(220,38,38,.3); background: var(--red-soft); color: var(--red); }
.chip.err .k { color: inherit; opacity: .7; }
.desc {
  width: 100%; border: 1px solid var(--line); border-radius: 10px; background: var(--paper);
  color: var(--ink); font: inherit; font-size: 13px; padding: 10px 12px; resize: none; height: 74px;
}
.desc:focus { outline: 2px solid var(--qa-ring); border-color: var(--qa-bright); }
.desc.invalid { border-color: var(--red); outline: 2px solid rgba(220,38,38,.25); }
.send-btn {
  width: 100%; margin-top: 14px; border: none; border-radius: 8px; cursor: pointer;
  background: var(--qa); color: var(--qa-contrast); font: inherit; font-size: 14px;
  font-weight: 700; padding: 11px;
}
.send-btn:hover:not(:disabled) { background: var(--qa-bright); }
.send-btn:focus-visible { outline: 2px solid var(--qa-bright); outline-offset: 2px; }
.send-btn:disabled { opacity: .6; cursor: default; }
.send-note { font-size: 11px; color: var(--ink-3); text-align: center; margin-top: 8px; }

/* ---- replay (contracts §Replay) ---- */
.qa-replay { position: fixed; inset: 0; z-index: 60; pointer-events: none; }
.qa-cursor {
  position: absolute; left: 0; top: 0; width: 12px; height: 12px; border-radius: 50%;
  background: var(--qa-bright); box-shadow: 0 0 0 6px var(--qa-ring), 0 1px 4px rgba(0,0,0,.18);
  transition: transform 450ms cubic-bezier(.22,.61,.36,1); will-change: transform;
}
.qa-replay.instant .qa-cursor { display: none; }
.qa-pulse {
  position: absolute; pointer-events: none;
  border: 2px solid var(--qa-bright); border-radius: 9px;
  background: rgba(20,184,166,.08); box-shadow: 0 0 0 4px var(--qa-ring);
  animation: qa-flash 900ms ease-out;
}
@keyframes qa-flash {
  0% { background: rgba(20,184,166,.26); box-shadow: 0 0 0 9px var(--qa-ring); }
  100% { background: rgba(20,184,166,.08); box-shadow: 0 0 0 4px rgba(13,148,136,.12); }
}
.qa-step-chip {
  position: absolute; pointer-events: none; white-space: nowrap;
  background: var(--ink); color: var(--paper); font-size: 11.5px; font-weight: 600;
  padding: 5px 11px; border-radius: 999px; box-shadow: var(--shadow);
}
.qa-final {
  position: absolute; pointer-events: none;
  border: 2px solid var(--qa); border-radius: 9px; background: rgba(20,184,166,.06);
  animation: qa-slow-pulse 1.6s ease-in-out infinite;
}
@keyframes qa-slow-pulse {
  0%, 100% { box-shadow: 0 0 0 3px var(--qa-ring); }
  50% { box-shadow: 0 0 0 10px rgba(13,148,136,.12); }
}
.qa-replay.instant .qa-pulse, .qa-replay.instant .qa-final { animation: none; }

/* ---- toast ---- */
.qa-toast {
  position: fixed; right: 22px; bottom: 84px; z-index: 50;
  display: flex; align-items: center; gap: 12px;
  background: var(--stage); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: var(--shadow-big); padding: 11px 14px; font-size: 13px; color: var(--ink);
  max-width: min(380px, 90vw);
}
.qa-toast.ok { border-left: 3px solid var(--green); }
.qa-toast.err { border-left: 3px solid var(--red); }
.qa-toast a { color: var(--qa); font-weight: 700; text-decoration: none; white-space: nowrap; }
.qa-toast a:hover { text-decoration: underline; }
`;
