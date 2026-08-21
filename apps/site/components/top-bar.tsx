'use client';

import Link from 'next/link';
import { SignOutButton } from '@/components/sign-out-button';
import { WorkerSettings } from '@/components/worker-settings';
import { useDisplayName } from '@/lib/display-names';

/** Slim app chrome: wordmark, who you are. Nothing else. */
export function TopBar({ email }: { email: string }) {
  const name = useDisplayName(email);
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex h-12 w-full max-w-[1140px] items-center gap-1 px-5">
        <Link href="/" className="flex items-center gap-2 text-[13.5px] font-semibold tracking-[-0.01em]">
          <span className="grid size-[22px] flex-none place-items-center rounded-[6px] bg-qa text-[11px] font-bold text-on-accent">
            Q
          </span>
          QA Pipeline
        </Link>

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
