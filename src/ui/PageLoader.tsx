/**
 * Full-screen splash shown over the app while the Layout settles. Without
 * this, the PausedIndicator and other absolutely-positioned overlays flash
 * briefly in the wrong spot before the Viewport's ResizeObserver fires and
 * the 16:9 letterbox is computed.
 *
 * The Layout mounts underneath at the same time, so the ResizeObserver and
 * the Three.js Canvas warm up while the splash is still visible. When the
 * splash fades out, everything is in its final position.
 *
 * Indeterminate animation only — there's no quantifiable signal to show
 * real progress against. JS modules are already resolved by the time React
 * renders, and the heavy 60 MB sampler load is deferred to first interaction
 * (where LoadingOverlay shows its real progress).
 */
import { useTranslation } from 'react-i18next'

export function PageLoader({ visible }: { visible: boolean }) {
  const { t } = useTranslation('screens')
  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-neutral-950 transition-opacity duration-500 ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
      aria-hidden={!visible}
    >
      <div className="flex flex-col items-center gap-4">
        <div className="text-[10px] font-medium uppercase tracking-[0.4em] text-neutral-600">
          {t('pageLoader.loading')}
        </div>
        {/* Indeterminate progress bar: a short pill slides across the track
            on a loop. The eased curve gives it a slight pause at the edges
            which reads as more deliberate than a linear loop. */}
        <div className="relative h-0.5 w-44 overflow-hidden rounded-full bg-neutral-800">
          <div className="page-loader-bar absolute inset-y-0 w-1/3 rounded-full bg-sky-400" />
        </div>
      </div>
      <style>{`
        @keyframes page-loader-slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(330%); }
        }
        .page-loader-bar {
          animation: page-loader-slide 1.3s cubic-bezier(0.65, 0.05, 0.36, 1) infinite;
        }
      `}</style>
    </div>
  )
}
