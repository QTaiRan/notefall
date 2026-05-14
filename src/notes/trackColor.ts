/**
 * Look up the colour hex string for a given track index.
 *
 * `trackColors` is the sparse `Record<trackIdx → hex>` from settings;
 * unset keys fall back to `fallback` (typically the global `noteColor`
 * for falling notes, `particleColor` for the particle system, etc.).
 *
 * `trackIdx === undefined` happens for live input (touch / PC keyboard
 * / Web-MIDI) and for previews — those have no source track and always
 * use the fallback colour.
 */
export function resolveTrackColorHex(
  trackIdx: number | undefined,
  trackColors: Record<string, string>,
  fallback: string,
): string {
  if (trackIdx == null) return fallback
  return trackColors[String(trackIdx)] ?? fallback
}
