// Element picker: veil that swallows page clicks, a pointer-events:none highlight
// box with a label chip, hover via elementFromPoint. Click selects, Esc cancels.

import { elementMeta } from './selector';

export interface PickerOptions {
  /** The widget's own host — never pickable. */
  ignore?: Element;
}

export function pickElement(container: HTMLElement, opts: PickerOptions = {}): Promise<Element | null> {
  return new Promise((resolve) => {
    const veil = document.createElement('div');
    veil.className = 'qa-veil';
    const banner = document.createElement('div');
    banner.className = 'qa-picker-banner';
    banner.textContent = 'Click the element that has the problem — Esc to cancel';
    const box = document.createElement('div');
    box.className = 'qa-spot';
    box.hidden = true;
    const label = document.createElement('div');
    label.className = 'qa-spot-label';
    box.appendChild(label);
    container.append(veil, banner, box);

    let current: Element | null = null;

    function setCurrent(el: Element | null): void {
      current = el;
      if (!el) {
        box.hidden = true;
        return;
      }
      const r = el.getBoundingClientRect();
      box.hidden = false;
      box.style.top = `${r.top - 3}px`;
      box.style.left = `${r.left - 3}px`;
      box.style.width = `${r.width + 6}px`;
      box.style.height = `${r.height + 6}px`;
      const meta = elementMeta(el);
      label.textContent = meta.component
        ? `<${meta.component}>${meta.sourceFile ? ` · ${meta.sourceFile}` : ''}`
        : `${el.tagName.toLowerCase()}${meta.testid ? ` · ${meta.testid}` : ''}`;
      label.classList.toggle('below', r.top < 44);
    }

    function hoverAt(x: number, y: number): void {
      // The veil sits on top; drop its hit-testing for one lookup so
      // elementFromPoint reaches the page underneath.
      veil.style.pointerEvents = 'none';
      let el = document.elementFromPoint(x, y);
      veil.style.pointerEvents = 'auto';
      if (el && opts.ignore && (el === opts.ignore || opts.ignore.contains(el))) el = null;
      if (el === document.documentElement) el = null;
      setCurrent(el);
    }

    function finish(el: Element | null): void {
      veil.remove();
      banner.remove();
      box.remove();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      resolve(el);
    }

    function onMove(e: MouseEvent): void {
      hoverAt(e.clientX, e.clientY);
    }
    function onClick(e: MouseEvent): void {
      e.preventDefault();
      e.stopPropagation();
      finish(current);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    }
    function onScroll(): void {
      if (current) setCurrent(current);
    }

    veil.addEventListener('mousemove', onMove);
    veil.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
  });
}
