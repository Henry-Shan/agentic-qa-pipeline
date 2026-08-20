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
    const supabase = getBrowserClient();
    const { data: userData } = await supabase.auth.getUser();
    const slug = slugify(trimmed);
    const { error: err } = await supabase.from('qa_docs').insert({
      slug,
      title: trimmed,
      created_by: userData.user?.email ?? null,
    });
    if (err) {
      setBusy(false);
      setError('Could not create the doc — try again.');
      return;
    }
    router.push(`/docs/${slug}`);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="flex-none rounded-md bg-qa px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-qa-bright"
      >
        ＋ New doc
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
        className="w-52 rounded-md border border-line bg-paper px-2.5 py-1.5 text-[12.5px] focus:border-qa-bright focus:outline-none"
      />
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="flex-none rounded-md bg-qa px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
      >
        Create
      </button>
      {error ? <span className="text-[11px] text-red">{error}</span> : null}
    </form>
  );
}
