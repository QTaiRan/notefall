import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
} from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import i18n, { SUPPORTED_LANGUAGES, type LanguageCode } from '../i18n'

// Shared item className, mirroring the File / Help menu rows in
// Toolbar.tsx so the language picker reads as part of the same menu
// system. Kept local rather than imported to honour file ownership.
const itemClass =
  'flex cursor-pointer items-center justify-between gap-6 rounded px-2 py-1.5 text-xs text-neutral-200 outline-none data-[focused]:bg-neutral-800 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50'

/**
 * Compact language picker. A small globe button opens a PURE react-aria
 * <Menu> (no non-Menu sibling inside the Popover — mixing a Switch into
 * a Menu leaves hover stuck, a known bug). Each item shows the
 * language's OWN label (never translated); the active language is
 * marked with a check. Selecting calls `i18n.changeLanguage`, which the
 * detector auto-persists to localStorage.
 */
export function LanguageSwitcher() {
  const { t, i18n: i18nInstance } = useTranslation('toolbar')
  // Collapse 'ja-JP' → 'ja' so the active marker still matches.
  const active = i18nInstance.language?.split('-')[0]

  return (
    <MenuTrigger>
      <Button
        aria-label={t('language.aria')}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-neutral-800 text-neutral-400 outline-none hover:border-neutral-600 hover:text-neutral-200 focus-visible:border-sky-500 data-[pressed]:bg-neutral-800"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
        </svg>
      </Button>
      <Popover
        placement="bottom end"
        className="rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-xl outline-none data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150"
      >
        <Menu
          aria-label={t('language.label')}
          className="flex w-40 flex-col gap-0.5 outline-none"
        >
          {SUPPORTED_LANGUAGES.map((lang) => {
            const isActive = lang.code === active
            return (
              <MenuItem
                key={lang.code}
                onAction={() => void i18n.changeLanguage(lang.code as LanguageCode)}
                textValue={lang.label}
                className={itemClass}
              >
                <span>{lang.label}</span>
                {isActive && <span className="text-sky-400">✓</span>}
              </MenuItem>
            )
          })}
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}
