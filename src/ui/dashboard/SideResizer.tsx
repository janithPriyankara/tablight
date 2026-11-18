// The handle on the sidebar's right edge: drag it (or use ←/→ when it has focus) to resize the sidebar;
// double-click puts the default width back. The width is a per-browser convenience kept in localStorage.
import { useRef } from 'preact/hooks';

export const SIDE_DEFAULT = 252;
export const SIDE_MIN = 200;
export const SIDE_MAX = 480;
const KEY = 'dashboard.sideWidth';
const STEP = 16;

const clamp = (w: number) => Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)));

/** The remembered sidebar width, or the default (storage blocked, nothing saved, or a bad value). */
export function loadSideWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    if (Number.isFinite(n) && n > 0) return clamp(n);
  } catch {
    /* storage blocked: default */
  }
  return SIDE_DEFAULT;
}
function saveSideWidth(w: number | null): void {
  try {
    if (w === null || w === SIDE_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(w));
  } catch {
    /* storage blocked: the width just isn't remembered */
  }
}

export function SideResizer(props: { width: number; onWidth: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number; id: number } | null>(null);
  const set = (w: number, save: boolean) => {
    const next = clamp(w);
    props.onWidth(next);
    if (save) saveSideWidth(next);
  };
  return (
    <div
      class="side-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0}
      aria-valuenow={props.width} aria-valuemin={SIDE_MIN} aria-valuemax={SIDE_MAX}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        drag.current = { x: e.clientX, w: props.width, id: e.pointerId };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && e.pointerId === d.id) set(d.w + e.clientX - d.x, false);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || e.pointerId !== d.id) return;
        drag.current = null;
        set(d.w + e.clientX - d.x, true);
      }}
      onPointerCancel={() => {
        drag.current = null;
        saveSideWidth(props.width);
      }}
      onKeyDown={(e) => {
        const delta = e.key === 'ArrowRight' ? STEP : e.key === 'ArrowLeft' ? -STEP : 0;
        const to = e.key === 'Home' ? SIDE_MIN : e.key === 'End' ? SIDE_MAX : props.width + delta;
        if (!delta && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        set(to, true);
      }}
      onDblClick={() => {
        props.onWidth(SIDE_DEFAULT);
        saveSideWidth(null);
      }}
    />
  );
}
