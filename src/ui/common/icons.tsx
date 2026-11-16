import type { JSX } from 'preact';

/** Inline 16px stroke icons (currentColor). Decorative: aria-hidden, the control carries the label. */
type IconProps = { size?: number; class?: string };
function Svg({ size = 16, class: cls, children }: IconProps & { children: JSX.Element | JSX.Element[] }) {
  return (
    <svg
      class={cls ? `icon ${cls}` : 'icon'} width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false"
    >
      {children}
    </svg>
  );
}
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3 3" /></Svg>
);
export const GridIcon = (p: IconProps) => (
  <Svg {...p}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></Svg>
);
export const StashIcon = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 5.5h11v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" /><path d="M1.75 2.75h12.5v2.75H1.75z" /><path d="M6.5 8.5h3" /></Svg>
);
export const MoonIcon = (p: IconProps) => (
  <Svg {...p}><path d="M13.25 9.6A5.5 5.5 0 1 1 6.4 2.75a4.5 4.5 0 0 0 6.85 6.85z" /></Svg>
);
export const SwitchIcon = (p: IconProps) => (
  <Svg {...p}><path d="M6 3.5H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V10" /><path d="M9 2.5h4.5V7" /><path d="m13.5 2.5-6 6" /></Svg>
);
export const CloseIcon = (p: IconProps) => (
  <Svg {...p}><path d="m4 4 8 8M12 4l-8 8" /></Svg>
);
export const CopyIcon = (p: IconProps) => (
  <Svg {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></Svg>
);
/** Placeholder for pages without a web favicon (chrome://, file://, new tab…). */
export const PageIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 1.75h5.25L12.5 5v8.25a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z" /><path d="M9 1.75V5.25h3.5" /></Svg>
);
/** The product mark: three stacked tabs. */
export const LogoMark = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false" class="logo-mark">
    <rect x="2" y="3" width="16" height="14" rx="4" fill="var(--accent)" />
    <path d="M6 8h8M6 11h5.5" stroke="var(--accent-contrast)" stroke-width="1.6" stroke-linecap="round" />
  </svg>
);
