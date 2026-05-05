import { useEffect } from 'react'
import { togglePlayback } from '../audio/playback'
import { toggleRecord } from '../audio/recordControl'

/**
 * Window-level keyboard shortcuts for the app's most common actions.
 * Mounted once from Layout so the listeners exist for the whole session.
 *
 * Shortcuts:
 *   Shift+R — toggle recording (start / stop)
 *   Space   — toggle song playback (play / pause)
 *
 * Why Shift+R rather than plain R: 'R' is bound in PC_KEY_NOTES to F4 for
 * playing notes via the laptop keyboard. The Shift prefix turns it into a
 * dedicated shortcut without breaking the piano keymap; Keyboard.tsx
 * skips on shiftKey so there's no double-fire.
 *
 * Skipped when:
 *   - focus is on an editable element (input, textarea, contenteditable),
 *     so the user can type freely in name fields without triggering them
 *   - any non-Shift modifier is held — the user is mid-system-shortcut,
 *     don't hijack
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false
      const tag = el.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el.isContentEditable
      )
    }

    const onKey = async (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditable(e.target)) return

      if (e.code === 'KeyR' && e.shiftKey) {
        e.preventDefault()
        void toggleRecord()
      } else if (e.code === 'Space' && !e.shiftKey) {
        // Space defaults to scroll / button-activate; we want it as a
        // playback toggle even when nothing is focused.
        e.preventDefault()
        void togglePlayback()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
