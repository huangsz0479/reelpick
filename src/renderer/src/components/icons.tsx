import type { ReactNode } from 'react'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const CloseIcon = () => (
  <Icon>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
)
export const FolderIcon = () => (
  <Icon>
    <path d="M1.75 4.25v7.5a1 1 0 0 0 1 1h10.5a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8L6.5 3.25H2.75a1 1 0 0 0-1 1z" />
  </Icon>
)
export const StopIcon = () => (
  <Icon>
    <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" />
  </Icon>
)
export const ChevronLeftIcon = () => (
  <Icon>
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </Icon>
)
export const ChevronRightIcon = () => (
  <Icon>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Icon>
)
export const DownloadIcon = () => (
  <Icon>
    <path d="M8 2.5v7.5M4.75 7L8 10.25 11.25 7M3 13.25h10" />
  </Icon>
)
export const RetryIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.6-3.67M13 2.75v2.5h-2.5" />
  </Icon>
)
export const LinkIcon = () => (
  <Icon>
    <path d="M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71L7.84 3.46" />
    <path d="M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14" />
  </Icon>
)
export const ProgressIcon = () => (
  <Icon>
    <path d="M8 2.25A5.75 5.75 0 1 1 2.25 8" />
  </Icon>
)
export const CheckCircleIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M5.5 8.25l1.75 1.75 3.25-3.5" />
  </Icon>
)
export const AlertCircleIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5.25v3.25M8 10.75v.01" />
  </Icon>
)
export const SlidersIcon = () => (
  <Icon>
    <path d="M2.5 5h5.25M11.25 5h2.25M2.5 11h2.25M8.25 11h5.25" />
    <circle cx="9.5" cy="5" r="1.75" />
    <circle cx="6.5" cy="11" r="1.75" />
  </Icon>
)
export const GlobeIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M2.25 8h11.5M8 2.25c1.6 1.55 2.4 3.47 2.4 5.75S9.6 12.2 8 13.75C6.4 12.2 5.6 10.28 5.6 8S6.4 3.8 8 2.25z" />
  </Icon>
)
export const PanelRightIcon = () => (
  <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M10 2.75v10.5" />
  </Icon>
)
