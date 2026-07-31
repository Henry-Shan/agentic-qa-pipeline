'use client';

// Install QR for NEXT_PUBLIC_MOBILE_CAPTURE_URL (e.g. the TestFlight or
// dev-client link). The server-side panel hides this block entirely when the
// env is unset; the code itself is generated client-side onto a canvas.

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

export function QrBlock({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, url, {
      width: 168,
      margin: 1,
      color: { dark: '#1e1e1e', light: '#ffffff' },
    }).catch(() => setFailed(true));
  }, [url]);

  return (
    <div className="mt-5 flex items-center gap-4 rounded-[10px] border border-line bg-surface p-4">
      {failed ? null : (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="QR code for the mobile capture build"
          className="size-[104px] flex-none rounded-lg border border-line bg-paper p-1.5"
        />
      )}
      <div className="min-w-0">
        <div className="text-[13px] font-semibold">Scan to get the build</div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 block truncate font-mono text-[11.5px] text-qa hover:underline"
        >
          {url}
        </a>
      </div>
    </div>
  );
}
