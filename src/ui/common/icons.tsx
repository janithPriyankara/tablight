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
export const ListIcon = (p: IconProps) => (
  <Svg {...p}><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" /></Svg>
);
export const InboxIcon = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 9.5h3l1 1.5h3l1-1.5h3" /><path d="M4.2 3.5h7.6l1.7 6v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-3z" /></Svg>
);
export const ClockIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="8" r="5.75" /><path d="M8 5v3l2 1.5" /></Svg>
);
export const GearIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="8" r="2" /><path d="M8 1.75v1.5M8 12.75v1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M1.75 8h1.5M12.75 8h1.5M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" /></Svg>
);
export const MoveIcon = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" /><path d="M6.5 9h4M9 7l1.5 2L9 11" /></Svg>
);
export const SparkIcon = (p: IconProps) => (
  <Svg {...p}><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M4 12l1.8-1.8M10.2 5.8 12 4" /></Svg>
);
export const TrashIcon = (p: IconProps) => (
  <Svg {...p}><path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.6 8.6a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.6" /></Svg>
);
export const PencilIcon = (p: IconProps) => (
  <Svg {...p}><path d="M10.5 2.75 13.25 5.5 6 12.75H3.25V10z" /></Svg>
);
export const MergeIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 2.5v3.5a3 3 0 0 0 3 3h5.5M12 2.5v4" /><path d="m10.5 7.5 2 1.5-2 1.5" /><path d="M4 13.5V9" /></Svg>
);
export const PlusIcon = (p: IconProps) => (
  <Svg {...p}><path d="M8 3v10M3 8h10" /></Svg>
);
export const CheckIcon = (p: IconProps) => (
  <Svg {...p}><path d="m3.5 8.5 3 3 6-7" /></Svg>
);
export const DownloadIcon = (p: IconProps) => (
  <Svg {...p}><path d="M8 2.5v8M4.75 7.5 8 10.75l3.25-3.25M2.75 13.25h10.5" /></Svg>
);
export const UploadIcon = (p: IconProps) => (
  <Svg {...p}><path d="M8 10.75v-8M4.75 5.75 8 2.5l3.25 3.25M2.75 13.25h10.5" /></Svg>
);
export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}><path d="M8 1.75 13 3.5v4c0 3.1-2.1 5.6-5 6.75-2.9-1.15-5-3.65-5-6.75v-4z" /></Svg>
);
export const PanelIcon = (p: IconProps) => (
  <Svg {...p}><rect x="2" y="2.75" width="12" height="10.5" rx="1.5" /><path d="M10 2.75v10.5" /></Svg>
);
export const PauseIcon = (p: IconProps) => (
  <Svg {...p}><rect x="4" y="3" width="2.75" height="10" rx="0.75" /><rect x="9.25" y="3" width="2.75" height="10" rx="0.75" /></Svg>
);
