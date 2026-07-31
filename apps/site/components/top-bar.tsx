'use client';

import Link from 'next/link';
import { SignOutButton } from '@/components/sign-out-button';
import { useDisplayName } from '@/lib/display-names';

export function TopBar({ email }: { email: string }) {
  // Greet with the chosen display name; the full email lives in the tooltip.
  const name = useDisplayName(email);
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-stage/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-3">
        <Link href="/" className="flex items-center gap-2.5 text-[15px] font-bold">
          <span className="grid size-7 flex-none place-items-center rounded-lg bg-qa text-[13px] font-extrabold text-on-accent">
            Q
          </span>
          QA Pipeline
        </Link>
        <div className="flex items-center gap-3 text-[12.5px] text-ink-3">
          <span className="hidden sm:inline" title={email}>
            {name}
          </span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
