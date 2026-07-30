export function relativeAge(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 172800) return 'yesterday';
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function initialOf(email: string | null | undefined): string {
  const first = (email ?? '').trim().charAt(0);
  return first ? first.toUpperCase() : '?';
}

export function nameOf(email: string | null | undefined): string {
  const local = (email ?? '').split('@')[0] ?? '';
  return local || 'unknown';
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
