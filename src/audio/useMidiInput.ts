import { useEffect, useState } from 'react'
import { midiInput } from './midiInput'

/**
 * React hook around the MidiInputManager singleton. Returns the device list,
 * the connected device id, and stable handles for triggering access /
 * connecting / disconnecting. Re-renders the calling component whenever
 * the manager's state changes (device added/removed, connection toggled).
 */
export function useMidiInput() {
  // Bump a counter to force re-render when the manager notifies.
  const [, setTick] = useState(0)
  useEffect(() => {
    return midiInput.addListener(() => setTick((n) => n + 1))
  }, [])

  return {
    supported: midiInput.isSupported(),
    hasAccess: midiInput.hasAccess(),
    devices: midiInput.getDevices(),
    activeDeviceId: midiInput.getActiveDeviceId(),
    requestAccess: () => midiInput.requestAccess(),
    connect: (deviceId: string | null) => midiInput.connect(deviceId),
  }
}
