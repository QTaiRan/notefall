import { useEffect } from 'react'
import { togglePlayback } from '../audio/playback'
import { toggleRecord } from '../audio/recordControl'
import { useStore } from '../store'
import { deleteNotes, moveNotes } from '../midi/edit'

/**
 * Window-level keyboard shortcuts for the app's most common actions.
 * Mounted once from Layout so the listeners exist for the whole session.
 *
 * Always-on shortcuts (any transport state):
 *   Shift+R         — toggle recording (start / stop)
 *   Space           — toggle song playback (play / pause).
 *                     Attached on the CAPTURE phase so it always wins
 *                     against react-aria buttons that swallow Space in
 *                     their own onPress handler (Tab+Space would
 *                     otherwise activate the focused button instead of
 *                     toggling playback). Use Enter to activate buttons.
 *
 * Edit-mode shortcuts (song loaded AND not playing):
 *   Escape                  — clear selection (or close the context menu
 *                             when one is open — that's handled inside
 *                             NoteContextMenu, and we skip clearing in
 *                             that case so a single Escape press doesn't
 *                             do two things at once)
 *   Cmd/Ctrl + Z            — undo last edit
 *   Cmd/Ctrl + Shift + Z    — redo
 *   Ctrl + Y                — redo (Windows convention)
 *
 * Selection-dependent (no-op when nothing is selected):
 *   Delete / Backspace      — delete selected notes
 *   ↑ / ↓                   — nudge pitch ±1 semitone
 *   ← / →                   — nudge time ±0.05 s
 *
 * Velocity is not on this list — it's edited via the double-click context
 * menu on a falling note (NoteContextMenu in Viewport.tsx).
 *
 * Why Shift+R rather than plain R: 'R' is bound in PC_KEY_NOTES to F4 for
 * playing notes via the laptop keyboard. The Shift prefix turns it into a
 * dedicated shortcut without breaking the piano keymap; Keyboard.tsx
 * skips on shiftKey so there's no double-fire.
 *
 * Skipped when:
 *   - focus is on an editable element (input, textarea, contenteditable),
 *     so the user can type freely in name fields without triggering them
 *   - for the always-on group, any non-Shift modifier is held (the user
 *     is mid-system-shortcut, don't hijack)
 */

const TIME_NUDGE_SEC = 0.05

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

    const inEditMode = (): boolean => {
      const s = useStore.getState()
      return s.song !== null && s.transport !== 'playing'
    }

    // Capture-phase Space handler. Lives on its own listener so the
    // edit-mode shortcuts below stay in the bubble phase (where they
    // don't interfere with focused widgets that legitimately consume
    // those keys — react-aria sliders use ArrowUp/Down for value
    // adjustment, for example).
    const onSpaceCapture = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (e.repeat || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditable(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void togglePlayback()
    }

    const onKey = async (e: KeyboardEvent) => {
      if (isEditable(e.target)) return

      // --- always-on record shortcut (Space is handled separately above) ---
      if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.code === 'KeyR' && e.shiftKey) {
          e.preventDefault()
          void toggleRecord()
          return
        }
      }

      // --- edit-mode shortcuts ---
      if (!inEditMode()) return
      const state = useStore.getState()

      // Escape: clear selection. When a note context menu is open, the
      // menu's own Escape handler closes it instead and we yield so a
      // single Escape press doesn't both close the menu AND clear the
      // selection in one go.
      if (e.code === 'Escape' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (state.contextMenu) return
        if (state.selection.size > 0) {
          e.preventDefault()
          state.clearSelection()
        }
        return
      }

      // Undo / redo. Cmd on Mac, Ctrl elsewhere — handle both so the
      // user's muscle memory works regardless of platform.
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) state.redoEdit()
        else state.undoEdit()
        return
      }
      if (mod && e.code === 'KeyY' && !e.shiftKey) {
        e.preventDefault()
        state.redoEdit()
        return
      }

      // Everything below operates on the current selection.
      if (state.selection.size === 0) return

      if (e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault()
        if (!state.song) return
        const next = deleteNotes(state.song, state.selection)
        if (next === state.song) return
        state.applySongEdit(next)
        // Drop the selection — its ids no longer exist in the song.
        state.replaceSelection([])
        return
      }

      // Pitch / time nudges. e.repeat is allowed so holding the key
      // continues to nudge — but only with no other modifier held so the
      // gesture doesn't collide with browser shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!state.song) return

      if (e.code === 'ArrowUp') {
        e.preventDefault()
        state.applySongEdit(moveNotes(state.song, state.selection, 0, +1))
        return
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault()
        state.applySongEdit(moveNotes(state.song, state.selection, 0, -1))
        return
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault()
        state.applySongEdit(moveNotes(state.song, state.selection, +TIME_NUDGE_SEC, 0))
        return
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault()
        state.applySongEdit(moveNotes(state.song, state.selection, -TIME_NUDGE_SEC, 0))
        return
      }
    }

    window.addEventListener('keydown', onSpaceCapture, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onSpaceCapture, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}
