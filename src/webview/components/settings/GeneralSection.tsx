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

interface OptionRowProps<K extends keyof UiPrefs> {
  label: string
  description?: string
  prefKey: K
  options: Array<{ value: UiPrefs[K]; label: string }>
}

/** One preference row: label + segmented options, writing on selection. */
function OptionRow<K extends keyof UiPrefs>({ label, description, prefKey, options }: OptionRowProps<K>): JSX.Element {
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
      {failure !== null && <p className="settings-error">{`保存失败：${failure}`}</p>}
    </div>
  )
}

export function GeneralSection(): JSX.Element {
  return (
    <div className="settings-section" data-region="GeneralSection">
      <h2 className="settings-section-title">通用</h2>
      <OptionRow
        label="语言"
        prefKey="language"
        options={[
          { value: 'zh', label: '中文' },
          { value: 'en', label: 'English' },
        ]}
      />
      <OptionRow
        label="外观"
        prefKey="appearance"
        options={[
          { value: 'vscode', label: '跟随 VSCode' },
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
        ]}
      />
      <OptionRow
        label="繁忙时 Enter 键行为"
        description="仅在智能体运行时生效"
        prefKey="busyEnter"
        options={[
          { value: 'queue', label: '排队发送' },
          { value: 'steer', label: '立即插话' },
        ]}
      />
      <OptionRow
        label="新会话默认权限模式"
        prefKey="permissionMode"
        options={[
          { value: 'read-only', label: 'Read Only' },
          { value: 'workspace-write', label: 'Workspace Write' },
          { value: 'full-access', label: 'Full access' },
        ]}
      />
    </div>
  )
}
