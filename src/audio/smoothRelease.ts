/**
 * Runtime patch that converts smplr's hard-coded linear release ramp
 * into an exponential decay (Web Audio `setTargetAtTime`).
 *
 * Why this exists:
 *
 *   smplr's `Voice.stop` runs this exact sequence to fade a voice:
 *
 *     envelope.gain.cancelScheduledValues(t)
 *     envelope.gain.setValueAtTime(1, t)
 *     envelope.gain.linearRampToValueAtTime(0, stopAt)
 *
 *   The linear ramp from 1 → 0 in dB-domain looks abrupt: a linear
 *   amplitude curve drops 6 dB only after half the duration, then
 *   crashes through −∞ near the end. Real piano releases decay
 *   exponentially, so users perceive smplr's release as "snipped".
 *   smplr exposes no hook to change the ramp shape (one hardcoded
 *   call site), and the Voice class is private, so we can't subclass
 *   or wrap it cleanly.
 *
 *   This module patches `AudioParam.prototype.linearRampToValueAtTime`
 *   so that **only when the target is exactly 0 and a non-zero
 *   `setValueAtTime` happened earlier on the same param**, the call
 *   is rerouted to `setTargetAtTime(0, startTime, duration/5)` — an
 *   exponential approach that hits ~0.7 % gain (effectively silent)
 *   by `endTime` and trails off naturally past that.
 *
 *   The guard "target === 0 AND last setValueAtTime > 0" is specific
 *   enough to match smplr's release pattern without breaking other
 *   `linearRampToValueAtTime(0, …)` users (we don't have any
 *   ourselves — `exportChime` ramps to a non-zero peak then uses
 *   `exponentialRampToValueAtTime` for its decay).
 *
 *   The patch is global and idempotent — calling the module multiple
 *   times reuses the same wrapped methods.
 */

type SetValueAtTime = AudioParam['setValueAtTime']
type LinearRamp = AudioParam['linearRampToValueAtTime']

// Marker so a second import of this module doesn't double-wrap.
const PATCHED_FLAG = Symbol.for('notefall.smoothRelease.patched')

type PatchedProto = AudioParam & { [PATCHED_FLAG]?: boolean }

function install(): void {
  const proto = AudioParam.prototype as PatchedProto
  if (proto[PATCHED_FLAG]) return

  const lastSetValue = new WeakMap<AudioParam, { value: number; time: number }>()
  const origSetValueAtTime: SetValueAtTime = proto.setValueAtTime
  const origLinearRamp: LinearRamp = proto.linearRampToValueAtTime

  proto.setValueAtTime = function (this: AudioParam, value: number, time: number) {
    lastSetValue.set(this, { value, time })
    return origSetValueAtTime.call(this, value, time)
  }

  proto.linearRampToValueAtTime = function (
    this: AudioParam,
    value: number,
    endTime: number,
  ) {
    if (value === 0) {
      const last = lastSetValue.get(this)
      if (last && last.value > 0 && endTime > last.time) {
        const duration = endTime - last.time
        // tc = duration / 5 → after `duration` seconds, gain ≈ e^-5 ≈
        // 0.0067 (≈ −43 dB), which the listener perceives as silent
        // while preserving the original "release length" envelope.
        const tc = duration / 5
        return this.setTargetAtTime(0, last.time, tc)
      }
    }
    return origLinearRamp.call(this, value, endTime)
  }

  proto[PATCHED_FLAG] = true
}

install()
