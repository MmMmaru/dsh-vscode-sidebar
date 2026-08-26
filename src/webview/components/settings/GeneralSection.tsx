/**
 * GeneralSection (W6): language, appearance, busy-Enter behavior and the
 * default permission mode for new sessions. Each preference persists through a
 * writable settings namespace when the host exposes one (locale / ui-theme /
 * ui-conversation / permission), else a localStorage fallback — see the
 * settings slice's uiPrefSources.
 */

import { useState, type JSX } from 'react'
import { useAppStore } from '../../store'
import type { UiPrefs } from '../../store/settings'
import { useI18n } from '../../i18n'

interface OptionRowProps<K extends keyof UiPrefs> {
  label: string
  description?: string
  prefKey: K
  options: Array<{ value: UiPrefs[K]; label: string }>
}

/** One preference row: label + segmented options, writing on selection. */
function OptionRow<K extends keyof UiPrefs>({ label, description, prefKey, options }: OptionRowProps<K>): JSX.Element {
  const { t } = useI18n()
  const value = useAppStore((s) => s.uiPrefs[prefKey])
  const source = useAppStore((s) => s.uiPrefSources[prefKey])
  const setUiPref = useAppStore((s) => s.setUiPref)
  const [failure, setFailure] = useState<string | null>(null)

  const select = (next: UiPrefs[K]): void => {
    if (next === value) return
    setFailure(null)
    void setUiPref(prefKey, next).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
    })
  }

  return (
    <div className="settings-field" data-pref={prefKey} data-source={source}>
      <div className="settings-field-label">{label}</div>
      {description !== undefined && <div className="settings-field-desc">{description}</div>}
      <div className="settings-segment" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className={`settings-segment-item${option.value === value ? ' settings-segment-item-active' : ''}`}
            aria-pressed={option.value === value}
            onClick={() => { select(option.value) }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {failure !== null && <p className="settings-error">{t('saveFailed', { error: failure })}</p>}
    </div>
  )
}

export function GeneralSection(): JSX.Element {
  const { t } = useI18n()

  return (
    <div className="settings-section" data-region="GeneralSection">
      <h2 className="settings-section-title">{t('generalTitle')}</h2>
      <OptionRow
        label={t('generalLanguage')}
        prefKey="language"
        options={[
          { value: 'zh', label: '中文' },
          { value: 'en', label: 'English' },
        ]}
      />
      <OptionRow
        label={t('generalAppearance')}
        prefKey="appearance"
        options={[
          { value: 'vscode', label: t('generalMatchVscode') },
          { value: 'light', label: t('generalLight') },
          { value: 'dark', label: t('generalDark') },
        ]}
      />
      <OptionRow
        label={t('generalBusyEnter')}
        description={t('generalBusyEnterDesc')}
        prefKey="busyEnter"
        options={[
          { value: 'queue', label: t('generalBusyEnterQueue') },
          { value: 'steer', label: t('generalBusyEnterSteer') },
        ]}
      />
      <OptionRow
        label={t('generalDefaultPerm')}
        prefKey="permissionMode"
        options={[
          { value: 'read-only', label: t('permReadOnly') },
          { value: 'workspace-write', label: t('permWorkspaceWrite') },
          { value: 'full-access', label: t('permFullAccess') },
        ]}
      />
    </div>
  )
}
