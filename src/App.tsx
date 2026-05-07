import { useEffect, useState } from 'react'
import { Layout } from './ui/Layout'
import { UnsupportedScreen } from './ui/UnsupportedScreen'
import { WebGLUnavailableScreen } from './ui/WebGLUnavailableScreen'
import { PageLoader } from './ui/PageLoader'

// Below this width the full UI (viewport + inspector + transport overlay)
// does not fit, so a fallback is shown. Matches Tailwind's `lg` breakpoint.
const MIN_WIDTH_PX = 1024

// Splash hold time before fading out. Long enough for the Viewport's
// ResizeObserver to fire and the Three.js Canvas to mount, so by the time
// the splash fades the centred indicators are already in their final spot.
const SPLASH_HOLD_MS = 500

/**
 * Probe whether the browser can give us a WebGL context. Mirrors what
 * three.js will request internally on Canvas mount; if this returns
 * `false` the 3D scene would mount to a black surface (the user's
 * "screen goes black when hardware acceleration is off" symptom).
 *
 * Tries WebGL2 then WebGL1 — three.js prefers WebGL2 but falls back,
 * and we want the most permissive check possible.
 */
function detectWebGLAvailable(): boolean {
  if (typeof document === 'undefined') return true
  try {
    const probe = document.createElement('canvas')
    const ctx =
      (probe.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (probe.getContext('webgl') as WebGLRenderingContext | null) ??
      (probe.getContext('experimental-webgl') as WebGLRenderingContext | null)
    return ctx !== null
  } catch {
    return false
  }
}

export function App() {
  const [supported, setSupported] = useState(
    typeof window !== 'undefined' ? window.innerWidth >= MIN_WIDTH_PX : true,
  )
  // Detected once at startup. Hardware-acceleration / WebGL availability
  // can in principle change (extension toggles, GPU process restarts) but
  // requiring a reload is the typical browser flow anyway, and the
  // fallback screen exposes a Reload button.
  const [webglAvailable] = useState(detectWebGLAvailable)
  const [appReady, setAppReady] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${MIN_WIDTH_PX}px)`)
    const onChange = (e: MediaQueryListEvent) => setSupported(e.matches)
    mql.addEventListener('change', onChange)
    setSupported(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => setAppReady(true), SPLASH_HOLD_MS)
    return () => clearTimeout(t)
  }, [])

  // Render only one tree so the 3D Canvas / audio engine never initialise
  // on small screens or systems without WebGL. The PageLoader sits on
  // top of any tree and fades out independently — that way the Layout
  // warms up underneath the splash. WebGL check takes precedence over
  // viewport-size: if WebGL is broken, even the desktop UI is useless.
  let body: React.ReactNode
  if (!webglAvailable) body = <WebGLUnavailableScreen />
  else if (!supported) body = <UnsupportedScreen />
  else body = <Layout />

  return (
    <>
      {body}
      <PageLoader visible={!appReady} />
    </>
  )
}
