// "Report an issue" — a slim top bar over the full-screen embedded example.com
// iframe with the widget handshake (CaptureFrame). Capture is web-only.

import Link from 'next/link';
import { CaptureFrame } from '@/components/capture/capture-frame';

export default function CapturePage() {
  return (
    <div className="relative h-dvh bg-paper">
      <header className="flex h-12 items-center gap-4 border-b border-line bg-stage/90 px-4 backdrop-blur">
        <Link href="/" className="flex-none text-[13px] font-semibold text-qa hover:underline">
          ← Board
        </Link>
        <h1 className="flex-none text-[14px] font-bold">Report an issue</h1>
        <p className="hidden min-w-0 truncate text-[12.5px] text-ink-3 md:block">
          Navigate to where the problem is, then click the 🐛 button — bottom right inside the app.
        </p>
      </header>

      <CaptureFrame />
    </div>
  );
}
