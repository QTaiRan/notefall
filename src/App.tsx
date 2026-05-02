import { useEffect, useState } from 'react'
import { Layout } from './ui/Layout'
import { UnsupportedScreen } from './ui/UnsupportedScreen'

// Below this width the full UI (viewport + inspector + transport overlay)
// does not fit, so a fallback is shown. Matches Tailwind's `lg` breakpoint.
const MIN_WIDTH_PX = 1024

export function App() {
  const [supported, setSupported] = useState(
    typeof window !== 'undefined' ? window.innerWidth >= MIN_WIDTH_PX : true,
  )

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${MIN_WIDTH_PX}px)`)
    const onChange = (e: MediaQueryListEvent) => setSupported(e.matches)
    mql.addEventListener('change', onChange)
    setSupported(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // Render only one tree so the 3D Canvas / audio engine never initialise
  // on small screens.
  return supported ? <Layout /> : <UnsupportedScreen />
}
