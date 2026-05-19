/**
 * Anonymous usage analytics (PostHog EU Cloud), wrapped so the rest of
 * the app only ever sees `track(name, props)` and the opt-out API.
 *
 * Hard guarantees enforced here, NOT at call sites:
 *   - Disabled entirely unless a key is configured AND it's a prod
 *     build (dev / local clones send nothing — `posthog-js` is never
 *     even imported).
 *   - `navigator.doNotTrack` and a persisted user opt-out both hard-
 *     disable capture.
 *   - autocapture + pageview + session recording are OFF: only the
 *     explicit events in `events.ts` are sent. No DOM/text/input
 *     capture, no profiles (`identified_only`, we never `identify()`).
 *   - localStorage persistence only — no cookies, so no consent
 *     banner — while still allowing anonymous returning-user signal.
 *
 * See `events.ts` for the content-exclusion invariant.
 */
import type { EventName, EventProps, LiveSource } from './events'

const OPT_OUT_KEY = 'nf:analytics-optout'

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
  'https://eu.i.posthog.com'

type PostHog = (typeof import('posthog-js'))['default']
let ph: PostHog | null = null
let initStarted = false

function dntEnabled(): boolean {
  if (typeof navigator === 'undefined') return false
  const v =
    navigator.doNotTrack ||
    // Legacy vendor-prefixed flags still set by some privacy tools.
    (window as unknown as { doNotTrack?: string }).doNotTrack ||
    (navigator as unknown as { msDoNotTrack?: string }).msDoNotTrack
  return v === '1' || v === 'yes'
}

export function isAnalyticsOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === '1'
  } catch {
    return false
  }
}

export function setAnalyticsOptOut(optOut: boolean): void {
  try {
    localStorage.setItem(OPT_OUT_KEY, optOut ? '1' : '0')
  } catch {
    /* storage blocked — opt-out can't persist; treat as best-effort */
  }
  if (ph) {
    if (optOut) ph.opt_out_capturing()
    else ph.opt_in_capturing()
  }
}

/**
 * Single source of truth for "are we allowed to send anything". Every
 * `track` / `init` path gates on this, so flipping DNT or the opt-out
 * mid-session takes effect immediately without a reload.
 */
export function analyticsEnabled(): boolean {
  return (
    !!KEY &&
    import.meta.env.PROD &&
    !dntEnabled() &&
    !isAnalyticsOptedOut()
  )
}

export async function initAnalytics(): Promise<void> {
  if (initStarted || !analyticsEnabled()) return
  initStarted = true
  try {
    const mod = await import('posthog-js')
    mod.default.init(KEY as string, {
      api_host: HOST,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: true,
      disable_session_recording: true,
      disable_surveys: true,
      person_profiles: 'identified_only',
      respect_dnt: true,
      // localStorage (not cookies) → first-party anonymous id, no
      // consent banner, retention/returning-user signal still works.
      persistence: 'localStorage',
      mask_all_text: true,
      mask_all_element_attributes: true,
    })
    ph = mod.default
  } catch {
    // Network blocked / script failed — analytics silently degrades to
    // a no-op, exactly like the dev/no-key path.
    ph = null
  }
}

export function track(name: EventName, props?: EventProps): void {
  if (!ph || !analyticsEnabled()) return
  try {
    ph.capture(name, props)
  } catch {
    /* never let analytics throw into app code */
  }
}

// Live performance fires hundreds of note events; we only want ONE
// `live_play_session` per input type per session (not per keystroke).
const liveSeen = new Set<LiveSource>()

export function markLivePlay(source: LiveSource): void {
  if (liveSeen.has(source)) return
  liveSeen.add(source)
  track('live_play_session', { input: source })
}
