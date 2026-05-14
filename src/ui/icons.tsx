import type { SVGProps } from "react";

/**
 * Icon registry. Every SVG icon used across the UI lives here so call sites
 * can stay clean and we can swap visual styles in one place.
 *
 * # Adding a new icon from Iconify (Solar set)
 *
 * 1. Open the icon page on https://icon-sets.iconify.design/solar/
 * 2. Click the "SVG" button → "Copy SVG" — you'll get markup like:
 *
 *      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
 *        <path fill="currentColor" d="…"/>
 *      </svg>
 *
 * 3. Paste it as the body of a new exported function below, following the
 *    pattern of the existing icons:
 *
 *      export function MyNewIcon(props: IconProps) {
 *        return (
 *          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" {...props}>
 *            <path fill="currentColor" d="…" />
 *          </svg>
 *        )
 *      }
 *
 *    Drop the hardcoded `width` / `height` from the pasted SVG — sizing comes
 *    from the call site via Tailwind classes (e.g. `className="h-5 w-5"`).
 *    Keep `viewBox` and `xmlns`.
 *
 * 4. Use it: `<MyNewIcon className="h-5 w-5" />`.
 *
 * Icons should be pure presentation: no internal state, no defaults beyond
 * the SVG attributes that come from Iconify.
 */

export type IconProps = SVGProps<SVGSVGElement>;

// ────────── Transport ──────────

export function PlayIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path fill="currentColor" d="M8 5.14v14l11-7z" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path fill="currentColor" d="M14 19h4V5h-4M6 19h4V5H6z" />
    </svg>
  );
}

export function RewindToStartIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path fill="currentColor" d="M20 5v14l-7-7M6 5v14H4V5m9 0v14l-7-7" />
    </svg>
  );
}

export function Replay10Icon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path
        fill="currentColor"
        d="M12.5 3c4.65 0 8.58 3.03 9.97 7.22L20.1 11c-1.05-3.19-4.06-5.5-7.6-5.5c-1.96 0-3.73.72-5.12 1.88L10 10H3V3l2.6 2.6C7.45 4 9.85 3 12.5 3M10 12v10H8v-8H6v-2zm8 2v6c0 1.11-.89 2-2 2h-2a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-4 0v6h2v-6z"
      />
    </svg>
  );
}

export function Forward10Icon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path
        fill="currentColor"
        d="M10 12v10H8v-8H6v-2zm8 2v6c0 1.11-.89 2-2 2h-2a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-4 0v6h2v-6zM11.5 3c2.65 0 5.05 1 6.9 2.6L21 3v7h-7l2.62-2.62C15.23 6.22 13.46 5.5 11.5 5.5c-3.54 0-6.55 2.31-7.6 5.5l-2.37-.78C2.92 6.03 6.85 3 11.5 3"
      />
    </svg>
  );
}

export function LoopIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path
        fill="currentColor"
        d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 0 0-8 8a8 8 0 0 0 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18a6 6 0 0 1-6-6a6 6 0 0 1 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"
      />
    </svg>
  );
}

export function FastForwardIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path fill="currentColor" d="M13 6v12l8.5-6M4 18l8.5-6L4 6z" />
    </svg>
  );
}

// ────────── Recording ──────────

export function RecordIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z" />
    </svg>
  );
}

export function MetronomeIcon(props: IconProps) {
  // Triangular metronome body with a swinging arm — reads as a metronome
  // even at small sizes.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
      {...props}
    >
      <path d="M9 3 L7 21 L17 21 L15 3 Z" fill="currentColor" fillOpacity="0.18" />
      <line x1="12" y1="18" x2="14.5" y2="6" />
      <circle cx="14.5" cy="6" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function PlaylistIcon(props: IconProps) {
  // List of items with a music note — reads as "list of recordings".
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M9 3v1H4v2h1v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h1V4h-5V3zm0 4h2v11H9zm4 0h2v11h-2z" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z" />
    </svg>
  );
}

// ────────── Volume ──────────

export function VolumeMuteIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path
        fill="currentColor"
        d="M3 9h4l5-5v16l-5-5H3zm13.59 3L14 9.41L15.41 8L18 10.59L20.59 8L22 9.41L19.41 12L22 14.59L20.59 16L18 13.41L15.41 16L14 14.59z"
      />
    </svg>
  );
}

export function VolumeLowIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path
        fill="currentColor"
        d="M5 9v6h4l5 5V4L9 9m9.5 3c0-1.77-1-3.29-2.5-4.03V16c1.5-.71 2.5-2.24 2.5-4"
      />
    </svg>
  );
}

export function VolumeHighIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path
        fill="currentColor"
        d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.84-5 6.7v2.07c4-.91 7-4.49 7-8.77s-3-7.86-7-8.77M16.5 12c0-1.77-1-3.29-2.5-4.03V16c1.5-.71 2.5-2.24 2.5-4M3 9v6h4l5 5V4L7 9z"
      />
    </svg>
  );
}

// ────────── Window / chrome ──────────

export function ResetViewIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path d="M0 0h24v24H0z" fill="none" />
      <g fill="none" fillRule="evenodd">
        <path d="m12.594 23.258l-.012.002l-.071.035l-.02.004l-.014-.004l-.071-.036q-.016-.004-.024.006l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.016-.018m.264-.113l-.014.002l-.184.093l-.01.01l-.003.011l.018.43l.005.012l.008.008l.201.092q.019.005.029-.008l.004-.014l-.034-.614q-.005-.019-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.003-.011l.018-.43l-.003-.012l-.01-.01z" />
        <path
          fill="currentColor"
          d="M11.5 2.134a1 1 0 0 1 1 0l2 1.155a1 1 0 0 1-1 1.732l-.5-.289V6a1 1 0 0 1-2 0V4.732l-.5.289a1 1 0 0 1-1-1.732zM7.072 5.845a1 1 0 0 1-.366 1.366l-.5.289l1.098.634a1 1 0 1 1-1 1.732l-1.098-.634v.577a1 1 0 0 1-2 0V7.5a1 1 0 0 1 .5-.865l2-1.155a1 1 0 0 1 1.366.366Zm9.856 0a1 1 0 0 1 1.366-.366l2 1.155a1 1 0 0 1 .5.866v2.31a1 1 0 0 1-2 0v-.578l-1.098.634a1 1 0 0 1-1-1.732l1.098-.634l-.5-.289a1 1 0 0 1-.366-1.366M8.536 10a1 1 0 0 1 1.366-.366L12 10.845l2.098-1.211a1 1 0 0 1 1 1.732L13 12.577V15a1 1 0 1 1-2 0v-2.423l-2.098-1.211A1 1 0 0 1 8.536 10m-4.33 3.19a1 1 0 0 1 1 1v.578l1.098-.634a1 1 0 0 1 1 1.732l-1.098.634l.5.289a1 1 0 1 1-1 1.732l-2-1.155a1 1 0 0 1-.5-.866v-2.31a1 1 0 0 1 1-1m15.588 0a1 1 0 0 1 1 1v2.31a1 1 0 0 1-.5.866l-2 1.155a1 1 0 1 1-1-1.732l.5-.289l-1.098-.634a1 1 0 1 1 1-1.732l1.098.634v-.577a1 1 0 0 1 1-1ZM12 17a1 1 0 0 1 1 1v1.268l.5-.289a1 1 0 1 1 1 1.732l-2 1.155a1 1 0 0 1-1 0l-2-1.155a1 1 0 1 1 1-1.732l.5.289V18a1 1 0 0 1 1-1"
        />
      </g>
    </svg>
  );
}

export function FullscreenIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path
        fill="currentColor"
        d="M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zm3 9h2v5h-5v-2h3zm-7 3v2H5v-5h2v3z"
      />
    </svg>
  );
}

export function FullscreenExitIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path
        fill="currentColor"
        d="M14 14h5v2h-3v3h-2zm-9 0h5v5H8v-3H5zm3-9h2v5H5V8h3zm11 3v2h-5V5h2v3z"
      />
    </svg>
  );
}

export function EllipsisVerticalIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <circle cx="12" cy="6" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="18" r="1.6" />
    </svg>
  );
}

export function CrosshairIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

export function MonitorIcon(props: IconProps) {
  // Outline-style, used by UnsupportedScreen as a "needs a bigger screen" cue.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      {...props}
    >
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M2 20h20" />
    </svg>
  );
}
