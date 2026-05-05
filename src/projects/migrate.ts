import { defaultSettings, type Settings } from '../store'
import { CURRENT_SCHEMA_VERSION, type ProjectManifest } from './types'

/**
 * Thrown when a project file's `schemaVersion` is greater than what this
 * build of the app understands — typically because the user has an old
 * tab open while a newer tab saved a file. Caller should surface this as
 * a user-friendly toast ("Update notefall to open this project") rather
 * than a raw error.
 */
export class NewerVersionError extends Error {
  constructor(public fileVersion: number) {
    super(`Project saved in a newer version (v${fileVersion}). Please update notefall.`)
    this.name = 'NewerVersionError'
  }
}

/**
 * One rewrite per breaking schema bump. Each entry maps an oldVersion to
 * the function that produces the (oldVersion + 1) shape. Walked in
 * sequence by `migrateManifest`.
 *
 * Empty for now — schema v1 is the initial release.
 *
 * Example for the future:
 *   1: (d) => ({
 *     ...d,
 *     schemaVersion: 2,
 *     settings: { ...d.settings, newKey: deriveFromOld(d.settings) },
 *   }),
 */
const migrations: Record<number, (data: any) => any> = {}

export function migrateManifest(raw: unknown): ProjectManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid project file (manifest.json is not an object)')
  }
  const fileVersion = Number((raw as { schemaVersion?: unknown }).schemaVersion)
  if (!Number.isFinite(fileVersion) || fileVersion < 1) {
    throw new Error('Invalid project file (missing or invalid schemaVersion)')
  }
  if (fileVersion > CURRENT_SCHEMA_VERSION) {
    throw new NewerVersionError(fileVersion)
  }
  let cur: any = raw
  while (cur.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const fn = migrations[cur.schemaVersion]
    if (!fn) throw new Error(`No migration registered for schema v${cur.schemaVersion}`)
    cur = fn(cur)
  }
  return cur as ProjectManifest
}

/**
 * Lenient merge of saved partial settings on top of the current defaults.
 * Missing keys fill with `defaultSettings`; unknown keys drop silently.
 * This is what makes adding/removing settings keys a free operation —
 * only renames / type changes need a migration step (above).
 */
export function loadSettings(saved: Partial<Settings> | undefined): Settings {
  return { ...defaultSettings, ...(saved ?? {}) }
}
