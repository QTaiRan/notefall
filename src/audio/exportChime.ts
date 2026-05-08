/**
 * "Task complete" chime played when an export finishes successfully.
 *
 * Voice — each note stacks the fundamental + an octave overtone + an
 * inharmonic bell partial at the empirical 2.756× ratio (the third
 * partial of a real cathedral bell). The inharmonic partial is what
 * gives the chime its bell character; with only the harmonic series
 * the result is pleasant but generic, with the bell partial it has
 * bite.
 *
 * Form — three-note ascending arpeggio that outlines the resolution
 * chord, landing flush into the held triad so the chord reads as the
 * "filled in" version of the lead-in rather than a separate event.
 *
 *   C6 → E6 → G6  (16ths)  →  C-E-G triad held + shimmer
 *
 *   Total length: ~1.2 s.
 *
 * Each pickup note is louder than the last so the line has direction
 * (it climbs *into* the chord instead of just getting there). The
 * chord's own G6 retriggers a few milliseconds after the final
 * pickup G6 lands — the brief overlap reads as a natural "arrival"
 * rather than a doubled hit.
 *
 * Uses a fresh `AudioContext` rather than the engine's Tone.js
 * context so the chime works even when no song is loaded / piano
 * isn't initialised, can't collide with a piano voice still tailing
 * off, and gets closed right after so it doesn't keep the audio
 * device awake. Fails silently — autoplay policy / context
 * creation errors aren't worth surfacing from a notification chime.
 */
export function playExportCompleteChime(): void {
  try {
    const ctx = new AudioContext()

    // Soft compression to keep stacked partials + resolution chord +
    // shimmer from clipping when they overlap.
    const out = ctx.createDynamicsCompressor()
    out.threshold.value = -10
    out.ratio.value = 4
    out.attack.value = 0.001
    out.release.value = 0.08
    out.connect(ctx.destination)

    const playBell = (
      freqHz: number,
      startSec: number,
      durSec: number,
      peak: number,
      sparkle: number,
    ) => {
      const t0 = ctx.currentTime + startSec
      const stopAt = t0 + durSec + 0.05

      const env = ctx.createGain()
      // Fast linear attack so each strike is percussive. Exponential
      // decay matches real bells.
      env.gain.setValueAtTime(0, t0)
      env.gain.linearRampToValueAtTime(peak, t0 + 0.005)
      env.gain.exponentialRampToValueAtTime(0.001, t0 + durSec)
      env.connect(out)

      const addPartial = (freq: number, gain: number) => {
        if (gain <= 0) return
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = freq
        const g = ctx.createGain()
        g.gain.value = gain
        osc.connect(g).connect(env)
        osc.start(t0)
        osc.stop(stopAt)
      }
      addPartial(freqHz, 1)
      addPartial(freqHz * 2, sparkle * 0.6)
      addPartial(freqHz * 2.756, sparkle * 0.35)
    }

    // 16th-note grid at ~175 BPM.
    const TICK = 0.085

    const A5 = 880.0
    const C6 = 1046.5
    const E6 = 1318.51
    const G6 = 1567.98
    const C7 = 2093.0
    const E7 = 2637.02

    // Pickup arpeggio — outlines the resolution chord. Each note
    // slightly louder than the last so the line climbs into the
    // chord instead of just getting there.
    playBell(C6, 0 * TICK, 0.1, 0.1, 0.22)
    playBell(E6, 1 * TICK, 0.1, 0.12, 0.25)
    playBell(G6, 2 * TICK, 0.12, 0.14, 0.3)

    // Resolution — C major triad held + octave-up shimmer. Stagger
    // the chord notes by a single sample-tick (5 ms) so the strike
    // has a tiny "rolled" feel instead of a robotic flat hit.
    const RES = 3 * TICK
    playBell(C6, RES + 0.0, 0.95, 0.16, 0.4)
    playBell(E6, RES + 0.005, 0.95, 0.14, 0.35)
    playBell(G6, RES + 0.01, 0.95, 0.13, 0.3)
    // Shimmer — pure sines, no extra partials. Stagger their attacks
    // so they read as sparkle layered over the chord rather than as
    // additional chord tones.
    playBell(E7, RES + 0.05, 0.75, 0.08, 0)
    playBell(C7, RES + 0.1, 0.55, 0.05, 0)
    // Final ping at the very top — a single "✨" stroke that arrives
    // after the chord settles, like a closing punctuation.
    playBell(A5 * 4 /* ≈ A7 */, RES + 0.25, 0.4, 0.04, 0)

    // Auto-close once the resolution chord (RES + 0.95 ≈ 1.21 s) has
    // fully decayed. 200 ms margin.
    setTimeout(() => {
      void ctx.close().catch(() => undefined)
    }, 1400)
  } catch {
    /* graceful no-op */
  }
}
