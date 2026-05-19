import { useTranslation } from 'react-i18next'
import { Button, Dialog, Heading, Modal, ModalOverlay, ProgressBar } from 'react-aria-components'
import type { TFunction } from 'i18next'

export type ExportProgressState = {
  /** Modal title — e.g. "Exporting audio", "Exporting video". */
  title: string
  /** Phase label shown above the progress bar — e.g. "Rendering audio". */
  phaseLabel: string
  /** 0..1, current progress within the active phase. */
  progress: number
  /**
   * Estimated remaining time in seconds. `null` until enough progress
   * has accumulated to compute a stable estimate (the very first
   * progress sample produces wildly noisy ETAs).
   */
  etaSeconds: number | null
} | null

/** Format an ETA in seconds as either `"12 sec"` or `"2 min 14 sec"`. */
function formatEta(seconds: number, t: TFunction<'dialogs'>): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return t('progress.etaSeconds', { count: total })
  const min = Math.floor(total / 60)
  const sec = total % 60
  return t('progress.etaMinutes', { min, sec })
}

/**
 * Shared progress modal used by every offline-export operation in the
 * app (audio WAV today, silent MP4 next, A/V MP4 once muxing lands).
 *
 * Non-dismissable — no Escape, no backdrop close. The user must press
 * Cancel. `onCancel` aborts the caller's `AbortController`; the
 * actual render usually can't be stopped mid-flight, but the
 * resulting Blob is discarded so nothing lands on disk.
 *
 * Visual language matches `ConfirmModal` (translucent black card +
 * blurred backdrop) so it feels native to the rest of the UI.
 */
export function ExportProgressModal({
  state,
  onCancel,
}: {
  state: ExportProgressState
  onCancel: () => void
}) {
  const { t } = useTranslation('dialogs')
  // Display percent floored, not rounded — a 99% display followed by
  // the modal vanishing reads better than "100% then disappear".
  const pct = state ? Math.max(0, Math.min(100, Math.floor(state.progress * 100))) : 0

  return (
    <ModalOverlay
      isOpen={state !== null}
      isDismissable={false}
      isKeyboardDismissDisabled
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150 data-[exiting]:animate-out data-[exiting]:fade-out data-[exiting]:duration-100"
    >
      <Modal className="outline-none data-[entering]:animate-in data-[entering]:zoom-in-95 data-[entering]:duration-150">
        <Dialog
          role="alertdialog"
          className="flex w-80 flex-col gap-4 rounded-md bg-black/55 p-4 shadow-lg ring-1 ring-white/10 backdrop-blur-md outline-none"
        >
          <div className="flex flex-col gap-1.5">
            <Heading slot="title" className="text-sm font-medium text-neutral-100">
              {state?.title ?? ''}
            </Heading>
            <p className="text-[11px] leading-relaxed text-neutral-400">
              {t('progress.note')}
            </p>
          </div>
          <ProgressBar
            value={pct}
            minValue={0}
            maxValue={100}
            aria-label={state?.phaseLabel ?? ''}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-neutral-300">{state?.phaseLabel ?? ''}</span>
              <span className="font-mono text-[11px] tabular-nums text-neutral-400">
                {pct}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full bg-sky-500 transition-[width] duration-100"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-baseline justify-end text-[10px] tabular-nums text-neutral-500">
              {state?.etaSeconds != null
                ? t('progress.eta', { eta: formatEta(state.etaSeconds, t) })
                : ' '}
            </div>
          </ProgressBar>
          <div className="flex justify-end">
            <Button
              autoFocus
              onPress={onCancel}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500"
            >
              {t('progress.cancel')}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
