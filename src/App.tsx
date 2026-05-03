import { useEffect, useState } from 'react'
import { Layout } from './ui/Layout'
import { UnsupportedScreen } from './ui/UnsupportedScreen'
import { PageLoader } from './ui/PageLoader'

// Below this width the full UI (viewport + inspector + transport overlay)
// does not fit, so a fallback is shown. Matches Tailwind's `lg` breakpoint.
const MIN_WIDTH_PX = 1024

// Splash hold time before fading out. Long enough for the Viewport's
// ResizeObserver to fire and the Three.js Canvas to mount, so by the time
// the splash fades the centred indicators are already in their final spot.
const SPLASH_HOLD_MS = 500

export function App() {
  const [supported, setSupported] = useState(
    typeof window !== 'undefined' ? window.innerWidth >= MIN_WIDTH_PX : true,
  )
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
  // on small screens. The PageLoader sits on top of either tree and fades
  // out independently — that way the Layout warms up underneath the splash.
  return (
    <>
      {supported ? <Layout /> : <UnsupportedScreen />}
      <PageLoader visible={!appReady} />
    </>
  )
}
