'use client';

// Email → chosen display name resolution (qa_allowed_emails.display_name).
// The (app) layout fetches {email, display_name} once per page load and
// provides the map here; components resolve through useDisplayName with the
// email local-part as the fallback. Writes keep author_email as the EMAIL —
// only display resolves the name. No realtime needed.

import { createContext, useContext, type ReactNode } from 'react';
import { nameOf } from '@/lib/format';

const DisplayNamesContext = createContext<Record<string, string>>({});

export function DisplayNamesProvider({
  names,
  children,
}: {
  names: Record<string, string>;
  children: ReactNode;
}) {
  return <DisplayNamesContext.Provider value={names}>{children}</DisplayNamesContext.Provider>;
}

/** Chosen display name for an email, falling back to the email local-part. */
export function useDisplayName(email: string | null | undefined): string {
  const map = useContext(DisplayNamesContext);
  return (email ? map[email] : undefined) || nameOf(email);
}
