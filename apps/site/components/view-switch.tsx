import Link from 'next/link';

/** Figma-style List | Canvas segmented control — the two board views are routes. */
export function ViewSwitch({ active }: { active: 'list' | 'canvas' }) {
  const item = (on: boolean) =>
    `px-3.5 py-[5px] text-[12.5px] font-semibold transition-colors ${
      on ? 'bg-qa-soft text-qa' : 'text-ink-3 hover:text-ink'
    }`;
  return (
    <nav aria-label="Board view" className="flex flex-none overflow-hidden rounded-lg border border-line bg-stage">
      <Link href="/" aria-current={active === 'list' ? 'page' : undefined} className={item(active === 'list')}>
        List
      </Link>
      <Link
        href="/canvas"
        aria-current={active === 'canvas' ? 'page' : undefined}
        className={item(active === 'canvas')}
      >
        Canvas
      </Link>
    </nav>
  );
}
