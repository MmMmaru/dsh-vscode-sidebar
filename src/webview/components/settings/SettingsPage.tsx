/**
 * SettingsPage: standalone full-screen settings page rendered in an expanded
 * VS Code editor tab webview.
 */

import { useEffect, useId, useState, type JSX } from 'react'
import { GeneralSection } from './GeneralSection'
import { ModelsSection } from './ModelsSection'
import { PluginsSection } from './PluginsSection'
import { PresetsSection } from './PresetsSection'
import { useAppStore } from '../../store'
import { useI18n } from '../../i18n'
import './settings.css'

type SectionId = 'general' | 'models' | 'plugins' | 'presets'

function NavIcon({ id }: { id: SectionId }): JSX.Element {
  switch (id) {
    case 'models':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <ellipse cx="8" cy="4" rx="5.5" ry="2.2" stroke="currentColor" />
          <path d="M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4" stroke="currentColor" />
          <path d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" stroke="currentColor" />
        </svg>
      )
    case 'plugins':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 3.2a1.8 1.8 0 1 1 3.6 0V4h2.4v2.4h.8a1.8 1.8 0 1 1 0 3.6H12v2.8H6.4v-.8a1.8 1.8 0 1 0-3.6 0v.8H2V6.4h2.4V4H6v-.8Z" stroke="currentColor" strokeLinejoin="round" />
        </svg>
      )
    case 'presets':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="5" r="2.4" stroke="currentColor" />
          <path d="M3 13.2c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" stroke="currentColor" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" />
          <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" stroke="currentColor" strokeLinecap="round" />
        </svg>
      )
  }
}

export function SettingsPage(): JSX.Element {
  const { t } = useI18n()
  const [active, setActive] = useState<SectionId>('general')
  const titleId = useId()
  const loadSettings = useAppStore((s) => s.loadSettings)

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const sections: Array<{ id: SectionId; label: string }> = [
    { id: 'general', label: t('navGeneral') },
    { id: 'models', label: t('navModels') },
    { id: 'plugins', label: t('navPlugins') },
    { id: 'presets', label: t('navPresets') },
  ]

  return (
    <div className="settings-page" role="region" aria-labelledby={titleId}>
      <nav className="settings-page-nav">
        <div className="settings-page-title" id={titleId}>{t('settingsTitle')}</div>
        <div className="settings-page-nav-list">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`settings-page-nav-cell${section.id === active ? ' settings-page-nav-cell-active' : ''}`}
              aria-current={section.id === active ? 'true' : undefined}
              onClick={() => setActive(section.id)}
            >
              <NavIcon id={section.id} />
              <span>{section.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <main className="settings-page-content">
        <div className="settings-page-body">
          {active === 'general' && <GeneralSection />}
          {active === 'models' && <ModelsSection />}
          {active === 'plugins' && <PluginsSection />}
          {active === 'presets' && <PresetsSection />}
        </div>
      </main>
    </div>
  )
}
