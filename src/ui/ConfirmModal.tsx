import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import {
  dismissPending,
  getPending,
  resolveAlert,
  resolveConfirm,
  subscribePending,
} from './confirm'

/**
 * Single mounted instance (in `Layout.tsx`) that listens for pending
 * `showConfirm` / `showAlert` calls and renders them as a styled modal.
 * Visual language matches `LoadingOverlay` (centered card, blurred
 * backdrop) so dialogs feel native to the rest of the UI.
 *
 * Two layouts on the same chrome:
 *   - **confirm**: two buttons (cancel + confirm). Cancel is `autoFocus`
 *     so pressing Enter on a destructive prompt preserves work. Confirm
 *     button is rose-tinted when `destructive`, sky-tinted otherwise.
 *   - **alert**: single OK button. Border accents rose for `tone:
 *     'error'` so a failed-load surface reads as "something went wrong"
 *     rather than informational.
 *
 * a11y: `react-aria-components` Modal handles focus trap, Escape, and
 * backdrop-click dismiss. `role="alertdialog"` tells screen readers
 * this requires a response.
 */
export function ConfirmModal() {
  const { t } = useTranslation('dialogs')
  const pending = useSyncExternalStore(subscribePending, getPending, getPending)

  const isError = pending?.kind === 'alert' && pending.options.tone === 'error'

  return (
    <ModalOverlay
      isOpen={pending !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) dismissPending()
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150 data-[exiting]:animate-out data-[exiting]:fade-out data-[exiting]:duration-100"
    >
      <Modal className="outline-none data-[entering]:animate-in data-[entering]:zoom-in-95 data-[entering]:duration-150">
        <Dialog
          role="alertdialog"
          className={
            // Base card matches LoadingOverlay (translucent + blur).
            // Error alerts swap the neutral ring for a rose border so
            // the surface visually flags "something went wrong".
            isError
              ? 'flex w-80 flex-col gap-4 rounded-md border border-rose-500/40 bg-black/55 p-4 shadow-lg backdrop-blur-md outline-none'
              : 'flex w-80 flex-col gap-4 rounded-md bg-black/55 p-4 shadow-lg ring-1 ring-white/10 backdrop-blur-md outline-none'
          }
        >
          {pending?.kind === 'confirm' && (
            <>
              <div className="flex flex-col gap-1.5">
                <Heading slot="title" className="text-sm font-medium text-neutral-100">
                  {pending.options.title}
                </Heading>
                <p className="text-[11px] leading-relaxed text-neutral-400">
                  {pending.options.message}
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  autoFocus
                  onPress={() => resolveConfirm(false)}
                  className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500"
                >
                  {pending.options.cancelLabel ?? t('confirm.defaultCancel')}
                </Button>
                <Button
                  onPress={() => resolveConfirm(true)}
                  className={
                    pending.options.destructive
                      ? 'rounded border border-rose-500/60 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200 outline-none hover:bg-rose-500/25 focus-visible:border-rose-300'
                      : 'rounded border border-sky-500/60 bg-sky-500/15 px-3 py-1.5 text-xs text-sky-200 outline-none hover:bg-sky-500/25 focus-visible:border-sky-300'
                  }
                >
                  {pending.options.confirmLabel ?? t('confirm.defaultConfirm')}
                </Button>
              </div>
            </>
          )}
          {pending?.kind === 'alert' && (
            <>
              <div className="flex flex-col gap-1.5">
                <Heading
                  slot="title"
                  className={
                    isError
                      ? 'text-sm font-medium text-rose-200'
                      : 'text-sm font-medium text-neutral-100'
                  }
                >
                  {pending.options.title}
                </Heading>
                <p className="whitespace-pre-line text-[11px] leading-relaxed text-neutral-400">
                  {pending.options.message}
                </p>
              </div>
              <div className="flex justify-end">
                <Button
                  autoFocus
                  onPress={() => resolveAlert()}
                  className={
                    isError
                      ? 'rounded border border-rose-500/60 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200 outline-none hover:bg-rose-500/25 focus-visible:border-rose-300'
                      : 'rounded border border-sky-500/60 bg-sky-500/15 px-3 py-1.5 text-xs text-sky-200 outline-none hover:bg-sky-500/25 focus-visible:border-sky-300'
                  }
                >
                  {pending.options.okLabel ?? t('alert.acknowledge')}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
