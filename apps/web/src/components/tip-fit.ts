import { useEffect } from 'react';
import { NARROW } from './narrow';

// ── A hint must not push the page sideways ──
//
// The bubble is centred on whatever carries the hint: `left: 50%` and a half-width pull
// back. On an element near the right edge of the window half the bubble lands past it, and
// an absolutely positioned box past the edge is part of the width the page can scroll — so
// hovering a hint made the whole product shift under the reader. Measured in the browser
// suite's own stand at 1280, where the owner works: `/buyer/suppliers` +82px on the block
// button, `/buyer/dashboard` +71px on the last KPI tile, `/buyer/budgets` +57px on the row
// menus, `/buyer/analytics` +46px. At rest every page was 0 — the bubbles were the whole of
// it. Sideways scrolling is the one thing the owner called a failure rather than a blemish.
//
// Below NARROW none of this applies: the stylesheet moves the bubble to the bottom of the
// window with `position: fixed`, which cannot add to the page's width. The measurement
// found nothing at 1024 for exactly that reason.
//
// The remedy is the one the product already uses for its other floating box: RowMenu
// measures its popup and pulls it back when it would hang off the side (see RowMenu.tsx).
// A pseudo-element has no rect to measure, but its width is readable, and the host's rect
// gives the rest. The shift is published as `--tip-shift` and the stylesheet adds it to the
// transform it already had. The arrow stays where it was, on the element: a shifted bubble
// with its arrow still pointing at what it explains is how every tooltip of this kind
// behaves, and moving the arrow instead would point it at nothing.
const GUTTER = 8;

function fit(host: HTMLElement): void {
  host.style.removeProperty('--tip-shift');
  // The width is the REAL one only while the bubble is open — at rest the cap is 0 — which
  // is why this runs a frame after the pointer arrives rather than at the event itself.
  const width = parseFloat(getComputedStyle(host, '::after').width) || 0;
  if (!width) return;
  const box = host.getBoundingClientRect();
  const centre = box.left + box.width / 2;
  const roomRight = document.documentElement.clientWidth - GUTTER - (centre + width / 2);
  const roomLeft = centre - width / 2 - GUTTER;
  // Floor and ceil AWAY from zero on purpose: rounding the other way leaves the fraction
  // of a pixel that `scrollWidth` rounds back up, and the page scrolls by one.
  const shift = roomRight < 0 ? Math.floor(roomRight) : roomLeft < 0 ? Math.ceil(-roomLeft) : 0;
  if (shift) host.style.setProperty('--tip-shift', `${shift}px`);
}

export function useTipFit(): void {
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    let frame = 0;
    // One delegated listener in the capture phase, so a hint inside a row menu or a table
    // cell is reached without every page wiring anything. `focusin` as well as the pointer,
    // because a tap on a touch screen opens the bubble through focus (see narrow.ts).
    const opening = (e: Event) => {
      const host = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (!host) return;
      if (mq.matches) { host.style.removeProperty('--tip-shift'); return; }
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = 0; fit(host); });
    };
    document.addEventListener('pointerover', opening, true);
    document.addEventListener('focusin', opening, true);
    return () => {
      document.removeEventListener('pointerover', opening, true);
      document.removeEventListener('focusin', opening, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}
