import { MonitorIcon } from './icons'

/**
 * Shown when the browser can't provide a WebGL context — typically
 * because the user has "Use hardware acceleration when available"
 * disabled and their browser also refuses the software fallback (or
 * has WebGL itself blocked). Without this fallback the canvas mounts
 * but renders to a black surface and the rest of the UI feels broken
 * for no obvious reason.
 *
 * Pairs with `UnsupportedScreen` (small viewport): both are pre-mount
 * gates so the 3D scene + audio engine never initialise on systems
 * that can't show the result.
 */
export function WebGLUnavailableScreen() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-neutral-200">
      <span className="flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tracking-wide">notefall</span>
        <span className="font-mono text-[10px] text-neutral-500">v{__APP_VERSION__}</span>
      </span>

      <MonitorIcon className="h-10 w-10 text-amber-400/80" />

      <h1 className="text-base font-medium">Hardware acceleration is required</h1>
      <p className="max-w-sm text-xs leading-relaxed text-neutral-400">
        notefall renders the falling notes with WebGL, which needs your
        browser's hardware acceleration to be on.
      </p>

      <div className="mt-2 flex max-w-sm flex-col gap-1 rounded-md border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-left text-[11px] leading-relaxed text-neutral-300">
        <p className="font-medium text-neutral-100">How to enable it</p>
        <p className="text-neutral-400">
          <span className="text-neutral-200">Chrome / Edge:</span> Settings →
          System → enable{' '}
          <span className="font-mono text-neutral-200">
            Use graphics acceleration when available
          </span>
          , then restart the browser.
        </p>
        <p className="text-neutral-400">
          <span className="text-neutral-200">Firefox:</span> Settings →
          General → Performance → enable{' '}
          <span className="font-mono text-neutral-200">
            Use recommended performance settings
          </span>
          .
        </p>
        <p className="text-neutral-400">
          <span className="text-neutral-200">Safari:</span> Develop menu →
          enable{' '}
          <span className="font-mono text-neutral-200">WebGL</span> (if shown).
        </p>
      </div>

      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-1 rounded border border-sky-500/60 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-200 outline-none hover:bg-sky-500/20 focus-visible:border-sky-300"
      >
        Reload page
      </button>
    </div>
  )
}
