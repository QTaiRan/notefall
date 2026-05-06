/**
 * Imperative confirm / alert dialog API. Replaces `window.confirm` and
 * `window.alert` so we can render styled, a11y-correct prompts (focus
 * trap, Escape to dismiss) matching the rest of the app's overlays —
 * and so non-React modules (`projects/actions.ts`, the global shortcut
 * handler, the window-level drop handler) can `await` a user response
 * without holding any React refs.
 *
 * Two flavours share one mounted `<ConfirmModal />`:
 *   - `showConfirm({...})`: two buttons (confirm + cancel). Returns
 *     `Promise<boolean>` (true = confirm, false = cancel/dismiss).
 *   - `showAlert({...})`: single button (acknowledge). Returns
 *     `Promise<void>`. Used for "an action failed" prompts where the
 *     user has nothing to decide — just to read and dismiss.
 *
 * If a dialog is already open when a new one is requested, the prior
 * one is settled (confirm → false, alert → resolve) before the new one
 * takes its place. Keeps overlapping callers from deadlocking on a
 * forgotten promise.
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

/** Visual accent for an alert. Errors get a rose border, info stays neutral. */
export type AlertTone = 'info' | 'error'

export type AlertOptions = {
  title: string
  message: string
  /** Defaults to "OK". */
  okLabel?: string
  /** Defaults to 'info'. */
  tone?: AlertTone
}

export type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (b: boolean) => void }
  | { kind: 'alert'; options: AlertOptions; resolve: () => void }

let pending: Pending | null = null
const listeners = new Set<() => void>()

function settle(p: Pending): void {
  if (p.kind === 'confirm') p.resolve(false)
  else p.resolve()
}

export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (pending) settle(pending)
    pending = { kind: 'confirm', options, resolve }
    notify()
  })
}

export function showAlert(options: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    if (pending) settle(pending)
    pending = { kind: 'alert', options, resolve }
    notify()
  })
}

/** Called by `<ConfirmModal />` when the user picks an option. */
export function resolveConfirm(value: boolean): void {
  if (!pending || pending.kind !== 'confirm') return
  const p = pending
  pending = null
  notify()
  p.resolve(value)
}

/** Called by `<ConfirmModal />` when the user dismisses an alert. */
export function resolveAlert(): void {
  if (!pending || pending.kind !== 'alert') return
  const p = pending
  pending = null
  notify()
  p.resolve()
}

/** Called by `<ConfirmModal />` on backdrop click / Escape. */
export function dismissPending(): void {
  if (!pending) return
  const p = pending
  pending = null
  notify()
  settle(p)
}

export function getPending(): Pending | null {
  return pending
}

export function subscribePending(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function notify(): void {
  listeners.forEach((l) => l())
}
