'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/client';

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return base ? `${base}-${suffix}` : suffix;
}

export function NewDocButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const create = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      // getSession reads the local session — no network round-trip to hang on.
      const { data: sessionData } = await supabase.auth.getSession();
      const slug = slugify(trimmed);
      const { error: err } = await supabase.from('qa_docs').insert({
        slug,
        title: trimmed,
        created_by: sessionData.session?.user.email ?? null,
      });
      if (err) throw new Error(err.message);
      router.push(`/docs/${slug}`);
    } catch (e) {
      setBusy(false);
      setError(`Could not create the doc: ${(e as Error).message}`);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="btn btn-primary flex-none"
      >
        New doc
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Doc title…"
        aria-label="Doc title"
        className="w-52 rounded-[7px] border border-line bg-paper px-2.5 py-1.5 text-[13.5px] transition-shadow focus:border-line-strong focus:outline-none focus:ring-[3px] focus:ring-qa/15"
      />
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="btn btn-primary flex-none"
      >
        Create
      </button>
      {error ? <span className="text-[12.5px] text-red">{error}</span> : null}
    </form>
  );
}
