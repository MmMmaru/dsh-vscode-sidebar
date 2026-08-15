/**
 * PresetsSection (W6): the agent preset roster (agentPreset.list) with the
 * default-for-new-sessions selection (settings.update ns `agent-presets`,
 * field `default`). Broken presets render disabled with their reason.
 */

import { useState, type JSX } from 'react'
import { useAppStore } from '../../store'

export function PresetsSection(): JSX.Element {
  const presets = useAppStore((s) => s.presets)
  const defaultPresetId = useAppStore((s) => s.defaultPresetId)
  const settingsWritable = useAppStore((s) => s.settingsWritable)
  const selectDefaultPreset = useAppStore((s) => s.selectDefaultPreset)

  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const select = (id: string): void => {
    if (saving || id === defaultPresetId || !settingsWritable) return
    setSaving(true)
    setFailure(null)
    void selectDefaultPreset(id)
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => { setSaving(false) })
  }

  return (
    <div className="settings-section" data-region="PresetsSection">
      <h2 className="settings-section-title">Agent 预设</h2>
      <p className="settings-section-intro">选择此后新建会话的默认预设。运行中的会话保持它开始时的预设。</p>
      {failure !== null && <p className="settings-error">{`保存失败：${failure}`}</p>}
      {presets.length === 0 ? (
        <p className="settings-empty">当前部署没有可用的预设。</p>
      ) : (
        <ul className="settings-preset-list" role="radiogroup" aria-label="默认预设">
          {presets.map((preset) => {
            const selected = preset.id === defaultPresetId
            const broken = preset.broken !== undefined
            return (
              <li key={preset.id} className="settings-preset-card">
                <button
                  type="button"
                  className={`settings-preset-row${selected ? ' settings-preset-row-active' : ''}`}
                  role="radio"
                  aria-checked={selected}
                  disabled={broken || saving || !settingsWritable}
                  title={preset.broken}
                  onClick={() => { select(preset.id) }}
                >
                  <span className={`settings-radio${selected ? ' settings-radio-on' : ''}`} aria-hidden="true" />
                  <span className="settings-preset-identity">
                    <span className="settings-preset-name">
                      {preset.name ?? preset.id}
                      {preset.name !== undefined && preset.name !== preset.id && (
                        <span className="settings-preset-id">{` ${preset.id}`}</span>
                      )}
                    </span>
                    {preset.description !== undefined && (
                      <span className="settings-preset-desc">{preset.description}</span>
                    )}
                    {broken && <span className="settings-error">{`不可用：${preset.broken ?? ''}`}</span>}
                  </span>
                  <span className={`settings-tag${preset.trust === 'user' ? ' settings-tag-user' : ''}`}>
                    {preset.trust === 'user' ? '本地' : '内置'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
