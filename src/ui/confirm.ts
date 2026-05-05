/**
 * Imperative confirm-dialog API. Replaces `window.confirm()` so we can
 * render a styled, a11y-correct prompt (focus trap, Escape to dismiss)
 * matching the rest of the app's overlays — and so non-React modules
 * like `src/projects/actions.ts` can `await` a user decision without
 * holding any React refs.
 *
 * The mounted `<ConfirmModal />` (one instance, in `Layout.tsx`)
 * subscribes via `subscribeConfirm`, reads the pending options via
 * `getPendingConfirm`, and dispatches the user's choice through
 * `resolveConfirm`.
 *
 * If a confirm is already open when `showConfirm` is called, the prior
 * one resolves as `false` (cancelled) before the new one takes its
 * place. This keeps overlapping calls from deadlocking on a forgotten
 * promise.
 */

export type ConfirmOptions = {
  title: string
  message: string
  /** Defaults to "OK" if not provided. */
  confirmLabel?: string
  /** Defaults to "Cancel" if not provided. */
  cancelLabel?: string
  /** Styles the confirm button red so users notice it's a discard / delete. */
  destructive?: boolean
}

type Pending = {
  options: ConfirmOptions
  resolve: (b: boolean) => void
}

let pending: Pending | null = null
const listeners = new Set<() => void>()

export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (pending) pending.resolve(false)
    pending = { options, resolve }
    notify()
  })
}

/** Called by `<ConfirmModal />` when the user picks an option (or dismisses). */
export function resolveConfirm(value: boolean): void {
  if (!pending) return
  const p = pending
  pending = null
  notify()
  p.resolve(value)
}

export function getPendingConfirm(): ConfirmOptions | null {
  return pending?.options ?? null
}

export function subscribeConfirm(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function notify(): void {
  listeners.forEach((l) => l())
}
