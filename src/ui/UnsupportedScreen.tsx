import { useTranslation } from 'react-i18next'

import { MonitorIcon } from './icons'

/**
 * Shown on screens narrower than the supported breakpoint. The full UI
 * (3D viewport + inspector + transport bar) needs at least ~1024px to be
 * usable, so smaller devices see this page instead of a broken layout.
 */
export function UnsupportedScreen() {
  const { t } = useTranslation('screens')
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-neutral-200">
      <span className="flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tracking-wide">notefall</span>
        <span className="font-mono text-[10px] text-neutral-500">v{__APP_VERSION__}</span>
      </span>

      <MonitorIcon className="h-10 w-10 text-neutral-600" />

      <h1 className="text-base font-medium">{t('unsupported.title')}</h1>
      <p className="max-w-xs text-xs leading-relaxed text-neutral-400">
        {t('unsupported.body')}
      </p>
    </div>
  )
}
