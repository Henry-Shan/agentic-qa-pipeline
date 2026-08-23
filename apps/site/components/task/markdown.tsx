import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Put back the blank lines the tester's paste lost.
 *
 * Markdown needs a blank line to close a block. Reports routinely arrive without
 * them — a spec pasted out of a doc keeps its single newlines and drops the
 * doubles — and the result is not a cosmetic wobble: a table with no blank line
 * after it SWALLOWS the prose and the next table beneath it, so three separate
 * blocks render as one wrong table. (Observed on task 46: two colour tables and
 * two paragraphs merged into a single table with a `---` row in the middle.)
 *
 * So we insert the separators the author meant at block boundaries — around
 * tables and before headings — and nowhere else. Fenced code is left strictly
 * alone: inside a fence the text is content, not markup.
 */
export function normalizeMarkdown(src: string): string {
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isHeading = (l: string) => /^\s{0,3}#{1,6}\s/.test(l);
  const out: string[] = [];
  let inFence = false;

  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence) {
      const prev = out.length > 0 ? out[out.length - 1]! : '';
      const prevIsBlank = prev.trim() === '';
      const needsBreak =
        !prevIsBlank &&
        ((isHeading(line) && prev.trim() !== '') ||
          (isRow(line) && !isRow(prev)) ||
          (!isRow(line) && line.trim() !== '' && isRow(prev)));
      if (needsBreak) out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * A tester's own words, rendered as what they wrote.
 *
 * Reports are frequently specs, not sentences — headings, tables of states and
 * hex values, checklists. Dropping that into a single `<p>` runs it together
 * into an unreadable line, which is precisely the input a spec-shaped report
 * needs most: a colour table is only legible AS a table.
 *
 * `remark-gfm` is what supplies tables, strikethrough and task lists. Raw HTML
 * stays disabled (react-markdown's default): this is untrusted text from whoever
 * filed the report, so it is rendered as markup, never executed as markup.
 */
export function Markdown({ children, className = '' }: { children: string; className?: string }) {
  return (
    <div className={`md text-[13.5px] leading-[1.65] text-ink-2 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Report headings sit inside a card, so they step down from the page's
          // own hierarchy rather than competing with it.
          h1: ({ children }) => <h3 className="mt-4 mb-1.5 text-[14px] font-semibold text-ink first:mt-0">{children}</h3>,
          h2: ({ children }) => <h4 className="mt-4 mb-1.5 text-[13.5px] font-semibold text-ink first:mt-0">{children}</h4>,
          h3: ({ children }) => <h5 className="mt-3 mb-1 text-[13px] font-semibold text-ink-2 first:mt-0">{children}</h5>,
          h4: ({ children }) => <h6 className="mt-3 mb-1 text-[12.5px] font-semibold text-ink-2 first:mt-0">{children}</h6>,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc pl-5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal pl-5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-qa underline underline-offset-2">
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-line-soft px-1 py-0.5 font-mono text-[12px] text-ink">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-[10px] border border-line bg-surface p-3 font-mono text-[12px] leading-[1.55]">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-line pl-3 text-ink-3">{children}</blockquote>
          ),
          hr: () => <hr className="my-3 border-line" />,
          // Wide tables scroll inside their own box; the card must never scroll
          // sideways and take the rest of the page with it.
          table: ({ children }) => (
            <div className="my-2.5 overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-line-soft">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-line px-2.5 py-1.5 text-left font-semibold text-ink whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-line px-2.5 py-1.5 align-top">{children}</td>,
        }}
      >
        {normalizeMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
}
