import type { ReactNode } from 'react';

// Renderer for the worker's needs_human hand-off summary (contracts § Needs-a-
// human): markdown-ish PLAIN TEXT with exactly three **bold** sections plus
// bullet / numbered lines. We render only those affordances — no markdown lib.

/** Render `**bold**` runs inside one plain-text line. */
export function boldSpans(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    parts.push(
      <strong key={match.index} className="font-semibold text-ink">
        {match[1]}
      </strong>,
    );
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

/** First non-empty line of the summary — the collapsed preview. */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** Full summary: bold section headers, bullets, and numbered steps. */
export function NeedsHumanText({ text }: { text: string }) {
  return (
    <div className="space-y-1 text-[12.5px] leading-[1.55] text-ink-2">
      {text.split('\n').map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
        if (numbered) {
          return (
            <div key={i} className="flex gap-1.5 pl-2">
              <span className="flex-none font-semibold tabular-nums text-amber">{numbered[1]}.</span>
              <span className="min-w-0">{boldSpans(numbered[2] ?? '')}</span>
            </div>
          );
        }
        const bullet = /^[-–•*]\s+(.*)$/.exec(trimmed);
        if (bullet) {
          return (
            <div key={i} className="flex gap-1.5 pl-2">
              <span className="flex-none text-amber">•</span>
              <span className="min-w-0">{boldSpans(bullet[1] ?? '')}</span>
            </div>
          );
        }
        return <p key={i}>{boldSpans(trimmed)}</p>;
      })}
    </div>
  );
}
