'use client';

// Hero segmented switch (contracts § Task page layout). The task hero is a
// single window whose content is chosen by this control:
//   [Screens (mobile only) | Before (the report) | After the fix | Live preview]
// Only tabs whose content exists are passed in; when just one survives the
// switch itself is hidden and the panel stands alone (no lonely segment).
//
// Panels stay MOUNTED once visited (hidden, not unmounted) so the preview
// iframe keeps its handshake/replay state and each replay player only fetches
// when first opened. `eager` panels mount immediately even while another tab is
// showing — the Live preview uses it so its auto-replay (and therefore the
// after-the-fix capture) still runs when "Before" is the default tab.
//
// The tab set grows at runtime (an after-the-fix recording appears mid-session),
// so the active id is validated against the current tabs on every render.

import { useState, type ReactNode } from 'react';

export interface HeroTab {
  id: string;
  label: string;
  content: ReactNode;
  /** Mount the panel even before it is first shown (hidden). */
  eager?: boolean;
}

export function HeroTabs({ tabs, defaultTab }: { tabs: HeroTab[]; defaultTab: string }) {
  const [active, setActive] = useState(defaultTab);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([defaultTab]));

  if (tabs.length === 0) return null;

  // The selected tab may have disappeared (preview went offline) — fall back to
  // the requested default, then to whatever is left.
  const has = (id: string) => tabs.some((tab) => tab.id === id);
  const activeId = has(active) ? active : has(defaultTab) ? defaultTab : (tabs[0] as HeroTab).id;

  const select = (id: string) => {
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  return (
    <div>
      {tabs.length > 1 ? (
        <div
          role="tablist"
          aria-label="Task hero view"
          className="mb-2 flex w-fit max-w-full flex-wrap overflow-hidden rounded-lg border border-line bg-stage"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeId === tab.id}
              onClick={() => select(tab.id)}
              className={`px-3.5 py-[5px] text-[12.5px] font-semibold transition-colors ${
                activeId === tab.id ? 'bg-qa-soft text-qa' : 'text-ink-3 hover:text-ink'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      {tabs.map((tab) =>
        tab.eager || visited.has(tab.id) || activeId === tab.id ? (
          <div key={tab.id} role="tabpanel" hidden={activeId !== tab.id}>
            {tab.content}
          </div>
        ) : null,
      )}
    </div>
  );
}
