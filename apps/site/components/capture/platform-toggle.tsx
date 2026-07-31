import Link from 'next/link';

/**
 * Web | Mobile segmented control in the capture top bar — same visual language
 * as the old List | Canvas board switch; the two capture experiences are
 * linkable via the ?platform searchParam (contracts § /capture platform toggle).
 */
export function PlatformToggle({ active }: { active: 'web' | 'mobile' }) {
  const item = (on: boolean) =>
    `px-3.5 py-[5px] text-[12.5px] font-semibold transition-colors ${
      on ? 'bg-qa-soft text-qa' : 'text-ink-3 hover:text-ink'
    }`;
  return (
    <nav
      aria-label="Capture platform"
      className="flex flex-none overflow-hidden rounded-lg border border-line bg-stage"
    >
      <Link
        href="/capture"
        aria-current={active === 'web' ? 'page' : undefined}
        className={item(active === 'web')}
      >
        Web
      </Link>
      <Link
        href="/capture?platform=mobile"
        aria-current={active === 'mobile' ? 'page' : undefined}
        className={item(active === 'mobile')}
      >
        Mobile
      </Link>
    </nav>
  );
}
