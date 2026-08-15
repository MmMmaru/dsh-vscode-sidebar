/**
 * SettingsPanel (W6): modal container with a narrow left nav rail (通用 / 模型 /
 * 插件 / Agent 预设) and a top-right close button, adapted to the ~360px
 * sidebar. Close paths: the close button, the mask click, and Escape.
 * Contract props per ARCHITECTURE.md section 5.3: `{ onClose }`.
 */

import { useEffect, useId, useState, type JSX } from 'react'
import { GeneralSection } from './GeneralSection'
import { ModelsSection } from './ModelsSection'
import { PluginsSection } from './PluginsSection'
import { PresetsSection } from './PresetsSection'
import './settings.css'

export interface SettingsPanelProps {
  /** Close the modal (settings slice: closeSettings). */
  onClose: () => void
}

type SectionId = 'general' | 'models' | 'plugins' | 'presets'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'models', label: '模型' },
  { id: 'plugins', label: '插件' },
  { id: 'presets', label: '预设' },
]

/** Nav glyph by section id (16px outline icons, currentColor). */
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

export function SettingsPanel({ onClose }: SettingsPanelProps): JSX.Element {
  const [active, setActive] = useState<SectionId>('general')
  const titleId = useId()

  // Escape closes; the listener lifetime is the panel's.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={onClose} />
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className="settings-nav">
          <div className="settings-nav-title" id={titleId}>设置</div>
          <div className="settings-nav-list">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`settings-nav-cell${section.id === active ? ' settings-nav-cell-active' : ''}`}
                aria-current={section.id === active ? 'true' : undefined}
                onClick={() => { setActive(section.id) }}
              >
                <NavIcon id={section.id} />
                <span>{section.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="settings-content">
          <div className="settings-content-header">
            <button type="button" className="settings-close" aria-label="关闭" onClick={onClose}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="settings-body" data-section={active}>
            {active === 'general' && <GeneralSection />}
            {active === 'models' && <ModelsSection />}
            {active === 'plugins' && <PluginsSection />}
            {active === 'presets' && <PresetsSection />}
          </div>
        </div>
      </div>
    </div>
  )
}
