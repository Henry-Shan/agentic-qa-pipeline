'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SignOutButton } from '@/components/sign-out-button';
import { WorkerSettings } from '@/components/worker-settings';
import { useDisplayName } from '@/lib/display-names';

/** Slim app chrome: wordmark, two destinations, who you are. Nothing else. */
export function TopBar({ email }: { email: string }) {
  const name = useDisplayName(email);
  const pathname = usePathname() ?? '';
  const nav = [
    { href: '/', label: 'Board', on: pathname === '/' || pathname.startsWith('/task') },
    { href: '/docs', label: 'Docs', on: pathname.startsWith('/docs') },
  ];

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex h-12 w-full max-w-[1140px] items-center gap-1 px-5">
        <Link href="/" className="mr-3 flex items-center gap-2 text-[13.5px] font-semibold tracking-[-0.01em]">
          <span className="grid size-[22px] flex-none place-items-center rounded-[6px] bg-qa text-[11px] font-bold text-on-accent">
            Q
          </span>
          QA Pipeline
        </Link>

        {nav.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.on ? 'true' : undefined} className="nav-item">
            {n.label}
          </Link>
        ))}

        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden max-w-[168px] truncate text-[12.5px] text-ink-3 sm:inline" title={email}>
            {name}
          </span>
          <WorkerSettings email={email} />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
