import { audioEngine } from '../audio/engine'
import { parseMidi } from '../midi/parse'
import { serializeMidi } from '../midi/serialize'
import { useCustomTexture } from '../notes/customTexture'
import { useStore } from '../store'
import { showConfirm } from '../ui/confirm'
import {
  ensureExtension,
  openFromHandle,
  pack,
  saveTo,
  showOpen,
  showSaveAs,
  stripExtension,
  unpack,
} from './io'
import { addRecent, removeRecent, type RecentEntry } from './recent'
import type { FileRef, Project } from './types'
import { defaultSettings, type Settings } from '../store'

/**
 * Lenient merge of saved partial settings on top of current defaults.
 * Missing keys fill from `defaultSettings`; unknown keys drop silently
 * — that's what makes adding/removing a settings key a free change.
 * Inlined here (rather than living in a separate module) since the
 * project is pre-1.0 with no users, so we don't need a versioned
 * migration system; if a saved key is renamed in the future we'll add
 * one back at that point.
 */
function loadSettings(saved: Partial<Settings> | undefined): Settings {
  return { ...defaultSettings, ...(saved ?? {}) }
}

/**
 * Top-level project actions used by the Toolbar buttons and global
 * shortcuts (Cmd+S). They orchestrate file I/O, MIDI parse/serialize,
 * the zustand store, and the audio engine in one place so call sites
 * can stay one-liners.
 *
 * Each action returns a `Result` describing what happened — `'ok'` /
 * `'cancelled'` (user dismissed picker) / `'error'` (raised toast). The
 * Toolbar surfaces errors as inline status; the cancel case is silent.
 */

export type ActionResult =
  | { kind: 'ok' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  return 'Something went wrong'
}

function suggestedFilename(): string {
  const s = useStore.getState()
  if (s.currentFile) return s.currentFile.name
  // Prefer the loaded MIDI's filename (without .mid) as the seed; otherwise
  // a generic name. The user can rename in the Save As dialog anyway.
  if (s.song?.name) {
    const base = s.song.name.replace(/\.midi?$/i, '')
    return ensureExtension(base || 'Untitled')
  }
  return ensureExtension('Untitled')
}

function buildProjectFromState(name: string): Project {
  const s = useStore.getState()
  const tex = useCustomTexture.getState()
  const now = Date.now()
  return {
    name: stripExtension(name),
    createdAt: now,
    updatedAt: now,
    settings: s.settings,
    songMidi: s.song ? serializeMidi(s.song) : null,
    // Capture the custom texture even if `noteTexture !== 'custom'` —
    // the user may have switched presets temporarily and we don't want
    // to drop their image on save. The noteTexture setting is what
    // controls *display*; the bytes are kept available either way.
    customTexture:
      tex.fileBytes && tex.fileMime && tex.fileName
        ? { bytes: tex.fileBytes, mime: tex.fileMime, fileName: tex.fileName }
        : null,
  }
}

// ───────── Open ─────────

async function confirmDiscardIfDirty(messagePrefix: string, confirmLabel: string): Promise<boolean> {
  if (!useStore.getState().dirty) return true
  return showConfirm({
    title: 'Discard unsaved changes?',
    message: `${messagePrefix} Unsaved edits will be lost.`,
    confirmLabel,
    cancelLabel: 'Cancel',
    destructive: true,
  })
}

/**
 * Shared "I have a project's bytes + a FileRef, apply it to the
 * session" path. Used by both `openProject` (file picker) and
 * `openRecent` (handle from the recents list) so the unpack / migrate /
 * audio sync / recent-list update logic stays in one place.
 */
async function applyOpenedProject(buf: ArrayBuffer, ref: FileRef): Promise<ActionResult> {
  let project: Project
  try {
    project = await unpack(buf)
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }

  const settings = loadSettings(project.settings)

  let song = null
  if (project.songMidi) {
    try {
      song = await parseMidi(project.songMidi, project.name)
    } catch (e) {
      return { kind: 'error', message: `MIDI parse failed: ${describeError(e)}` }
    }
  }

  useStore.getState().loadProject(settings, song, ref)
  if (song) audioEngine.loadSong(song)
  else audioEngine.unloadSong()
  useStore.getState().setTransport('stopped')

  // Restore (or clear) the custom texture image. Goes through the
  // dedicated `setFromBytes` / `clearFromLoad` paths so it doesn't
  // re-mark the just-loaded project as dirty.
  if (project.customTexture) {
    void useCustomTexture
      .getState()
      .setFromBytes(project.customTexture.bytes, project.customTexture.mime, project.customTexture.fileName)
  } else {
    useCustomTexture.getState().clearFromLoad()
  }

  // Move-to-top in the recents list. No-op on browsers without FSA
  // (ref.handle === null), see `recent.ts`.
  void addRecent(ref)

  return { kind: 'ok' }
}

/**
 * Show the file picker, load the chosen .nfz, and apply it to the
 * session. Replaces settings + song + currentFile atomically and marks
 * the session clean.
 *
 * Gates on the `dirty` flag via the in-app confirm modal — opening a
 * project is destructive (it discards everything in the current session)
 * so we don't proceed silently when there's unsaved work. Single source
 * of truth so Toolbar + Cmd+O behave identically.
 */
export async function openProject(): Promise<ActionResult> {
  const proceed = await confirmDiscardIfDirty(
    'Opening a project will replace the current session.',
    'Discard & Open',
  )
  if (!proceed) return { kind: 'cancelled' }

  let opened: Awaited<ReturnType<typeof showOpen>>
  try {
    opened = await showOpen()
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }
  if (!opened) return { kind: 'cancelled' }

  return applyOpenedProject(opened.buf, opened.ref)
}

/**
 * Apply a `.nfz` file that the caller already has in hand (e.g. from a
 * drag-and-drop into the canvas). Same dirty-confirm + apply pipeline
 * as `openProject`, but skips the picker. `handle` ends up null since
 * dropped files don't carry an FSA write handle — `Save` therefore
 * falls through to `Save As` until the user picks a destination.
 */
export async function openProjectFromFile(file: File): Promise<ActionResult> {
  const proceed = await confirmDiscardIfDirty(
    `Opening "${file.name}" will replace the current session.`,
    'Discard & Open',
  )
  if (!proceed) return { kind: 'cancelled' }

  let buf: ArrayBuffer
  try {
    buf = await file.arrayBuffer()
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }
  return applyOpenedProject(buf, { name: file.name, handle: null })
}

/**
 * Reopen a project from a Recent Files entry. Same flow as `openProject`
 * but skips the picker and the dirty-confirm uses a slightly different
 * label. If the handle is stale (file moved / deleted / permission
 * denied), the entry is dropped from the recents list so the menu
 * doesn't keep showing dead items.
 */
export async function openRecent(entry: RecentEntry): Promise<ActionResult> {
  const proceed = await confirmDiscardIfDirty(
    `Opening "${entry.name}" will replace the current session.`,
    'Discard & Open',
  )
  if (!proceed) return { kind: 'cancelled' }

  const opened = await openFromHandle(entry.handle)
  if (!opened) {
    removeRecent(entry.id)
    return {
      kind: 'error',
      message: `Could not open "${entry.name}". The file may have been moved, deleted, or permission denied.`,
    }
  }

  return applyOpenedProject(opened.buf, opened.ref)
}

// ───────── Save / Save As ─────────

/**
 * Save to the current file. On FSA browsers this overwrites without a
 * prompt; if there's no `currentFile` (or its handle isn't usable) we
 * fall through to Save As. On non-FSA browsers Save and Save As are the
 * same operation (a fresh download).
 */
export async function saveProject(): Promise<ActionResult> {
  const s = useStore.getState()
  if (s.currentFile?.handle) {
    const project = buildProjectFromState(s.currentFile.name)
    const blob = pack(project)
    const ok = await saveTo(s.currentFile.handle, blob)
    if (ok) {
      useStore.getState().markClean()
      // Bump the recents entry so this just-saved file moves to the top.
      void addRecent(s.currentFile)
      return { kind: 'ok' }
    }
    // Handle stale (file moved, permission denied, etc.) — fall through.
  }
  return saveProjectAs()
}

/**
 * Always show the Save As picker. On FSA browsers this captures a fresh
 * handle for subsequent Save calls; on the fallback path it's a download.
 */
export async function saveProjectAs(): Promise<ActionResult> {
  const suggested = suggestedFilename()
  const project = buildProjectFromState(suggested)
  const blob = pack(project)
  let ref: Awaited<ReturnType<typeof showSaveAs>>
  try {
    ref = await showSaveAs(suggested, blob)
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }
  if (!ref) return { kind: 'cancelled' }
  useStore.getState().setCurrentFile(ref)
  useStore.getState().markClean()
  void addRecent(ref)
  return { kind: 'ok' }
}

// ───────── New ─────────

/**
 * Reset to a blank session — defaults settings, no song, no associated
 * file. Same dirty-confirm contract as `openProject`: prompts before
 * discarding unsaved work so call sites (menu / future shortcut) don't
 * each have to reimplement the gate.
 */
export async function newProject(): Promise<ActionResult> {
  if (useStore.getState().dirty) {
    const ok = await showConfirm({
      title: 'Discard unsaved changes?',
      message: 'Starting a new project will discard the current session. Unsaved edits will be lost.',
      confirmLabel: 'Discard & New',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return { kind: 'cancelled' }
  }
  useStore.getState().newProject()
  audioEngine.unloadSong()
  useStore.getState().setTransport('stopped')
  // Drop any image carried over from the previous session — a fresh
  // project shouldn't inherit the previous look's texture.
  useCustomTexture.getState().clearFromLoad()
  return { kind: 'ok' }
}
