/**
 * ProviderEditorCard (W6): one provider's inline editor — a write-only API key
 * field (credentials.set under the conventional `<ROUTE>_API_KEY` ref) and a
 * baseURL field (settings.mutate path op against the provider profile). Saving
 * announces through the parent (`onClose(true)`).
 */

import { useState, type JSX } from 'react'
import { useAppStore } from '../../store'
import { deriveKeyRef, type ProviderTarget } from '../../store/settings'

export interface ProviderEditorCardProps {
  target: ProviderTarget
  /** Close the editor; `changed` reports whether a save committed. */
  onClose: (changed: boolean) => void
}

/** Read the value at a path inside a plain object (redacted namespace value). */
function valueAt(source: unknown, path: string[]): unknown {
  let node = source
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

export function ProviderEditorCard({ target, onClose }: ProviderEditorCardProps): JSX.Element {
  const namespace = useAppStore((s) => s.namespaces.find((n) => n.ns === target.settingsNs))
  const credential = useAppStore((s) => s.credentials[target.credentialRef ?? deriveKeyRef(target.provider)])
  const mutateSettings = useAppStore((s) => s.mutateSettings)
  const setCredential = useAppStore((s) => s.setCredential)

  const keyRef = target.credentialRef ?? deriveKeyRef(target.provider)
  const currentBaseURL = (() => {
    const value = valueAt(namespace?.value, target.settingsPath)
    const baseURL = typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)['baseURL']
      : undefined
    return typeof baseURL === 'string' ? baseURL : ''
  })()

  const [keyDraft, setKeyDraft] = useState('')
  const [baseURLDraft, setBaseURLDraft] = useState(currentBaseURL)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const keyValue = keyDraft.trim()
  const baseURLChanged = baseURLDraft.trim() !== currentBaseURL
  const dirty = keyValue.length > 0 || baseURLChanged

  const save = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      if (baseURLChanged) {
        const path = [...target.settingsPath, 'baseURL']
        const next = baseURLDraft.trim()
        await mutateSettings(
          target.settingsNs,
          [next.length > 0 ? { op: 'set', path, value: next } : { op: 'unset', path }],
          namespace?.revision,
        )
      }
      if (keyValue.length > 0) await setCredential(keyRef, keyValue)
      onClose(true)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-editor" data-region="ProviderEditorCard">
      <div className="settings-field">
        <div className="settings-field-label">API 密钥</div>
        <input
          className="settings-input"
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={credential?.configured === true ? '已配置（输入以更换）' : '输入 API 密钥'}
          aria-label="API 密钥"
          disabled={busy}
          onChange={(e) => { setKeyDraft(e.target.value) }}
        />
      </div>
      <div className="settings-field">
        <div className="settings-field-label">Base URL</div>
        <input
          className="settings-input"
          type="text"
          value={baseURLDraft}
          placeholder="https://api.deepseek.com"
          aria-label="Base URL"
          disabled={busy}
          onChange={(e) => { setBaseURLDraft(e.target.value) }}
        />
      </div>
      {failure !== null && <p className="settings-error">{`保存失败：${failure}`}</p>}
      <div className="settings-editor-actions">
        <button type="button" className="settings-btn" disabled={busy} onClick={() => { onClose(false) }}>
          取消
        </button>
        <button
          type="button"
          className="settings-btn settings-btn-primary"
          disabled={busy || !dirty}
          onClick={() => { void save() }}
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
