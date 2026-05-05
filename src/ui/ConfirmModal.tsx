import { useSyncExternalStore } from 'react'
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { getPendingConfirm, resolveConfirm, subscribeConfirm } from './confirm'

/**
 * Single mounted instance (in `Layout.tsx`) that listens for pending
 * `showConfirm` calls and renders them as a styled modal. Visual
 * language matches `LoadingOverlay` (centered card, blurred backdrop)
 * but with an amber accent and action buttons instead of a progress
 * bar — a confirm is a decision point, not informational.
 *
 * a11y: `react-aria-components` Modal handles focus trap, Escape to
 * dismiss, and backdrop-click dismiss. Cancel is `autoFocus` so
 * pressing Enter on a destructive prompt preserves work by default.
 * `role="alertdialog"` (vs the default "dialog") tells screen readers
 * this requires a response — appropriate for confirm prompts.
 */
export function ConfirmModal() {
  const opts = useSyncExternalStore(subscribeConfirm, getPendingConfirm, getPendingConfirm)

  return (
    <ModalOverlay
      isOpen={opts !== null}
      onOpenChange={(isOpen) => {
        // Backdrop click / Escape both flow through here as `false`.
        if (!isOpen) resolveConfirm(false)
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150 data-[exiting]:animate-out data-[exiting]:fade-out data-[exiting]:duration-100"
    >
      <Modal className="outline-none data-[entering]:animate-in data-[entering]:zoom-in-95 data-[entering]:duration-150">
        <Dialog
          role="alertdialog"
          className="flex w-80 flex-col gap-4 rounded-md bg-black/55 p-4 shadow-lg ring-1 ring-white/10 backdrop-blur-md outline-none"
        >
          {opts && (
            <>
              <div className="flex flex-col gap-1.5">
                <Heading slot="title" className="text-sm font-medium text-neutral-100">
                  {opts.title}
                </Heading>
                <p className="text-[11px] leading-relaxed text-neutral-400">
                  {opts.message}
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  autoFocus
                  onPress={() => resolveConfirm(false)}
                  className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500"
                >
                  {opts.cancelLabel ?? 'Cancel'}
                </Button>
                <Button
                  onPress={() => resolveConfirm(true)}
                  className={
                    opts.destructive
                      ? 'rounded border border-rose-500/60 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200 outline-none hover:bg-rose-500/25 focus-visible:border-rose-300'
                      : 'rounded border border-sky-500/60 bg-sky-500/15 px-3 py-1.5 text-xs text-sky-200 outline-none hover:bg-sky-500/25 focus-visible:border-sky-300'
                  }
                >
                  {opts.confirmLabel ?? 'OK'}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
