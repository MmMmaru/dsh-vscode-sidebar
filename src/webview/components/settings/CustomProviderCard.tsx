/**
 * CustomProviderCard (W6): the 添加自定义提供方 card — declares an
 * OpenAI-compatible route in the `llm-pi-ai` settings namespace (settings.mutate
 * set at [routeId]) plus an optional initial API key (credentials.set).
 */

import { useState, type JSX } from 'react'
import { useAppStore } from '../../store'
import { deriveKeyRef } from '../../store/settings'
import { useI18n } from '../../i18n'

export interface CustomProviderCardProps {
  /** Route ids already taken (validation). */
  taken: string[]
  /** Close the card; `changed` reports whether a declaration committed. */
  onClose: (changed: boolean) => void
}

const PROTOCOLS = ['openai', 'anthropic'] as const

export function CustomProviderCard({ taken, onClose }: CustomProviderCardProps): JSX.Element {
  const { t, lang } = useI18n()
  const namespace = useAppStore((s) => s.namespaces.find((n) => n.ns === 'llm-pi-ai'))
  const mutateSettings = useAppStore((s) => s.mutateSettings)
  const setCredential = useAppStore((s) => s.setCredential)

  const [id, setId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [api, setApi] = useState<string>(PROTOCOLS[0])
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const routeId = id.trim()
  const idFailure = routeId.length === 0
    ? null
    : !/^[a-z0-9][a-z0-9-]*$/.test(routeId)
      ? (lang === 'zh' ? '标识只能包含小写字母、数字与连字符' : 'Identifier may only contain lowercase letters, numbers and hyphens')
      : taken.includes(routeId)
        ? (lang === 'zh' ? '该标识已被占用' : 'Identifier already in use')
        : null
  const canSubmit = routeId.length > 0 && idFailure === null && baseURL.trim().length > 0 && !busy

  const save = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      const profile: Record<string, unknown> = {
        displayName: displayName.trim().length > 0 ? displayName.trim() : routeId,
        baseURL: baseURL.trim(),
        api,
      }
      const keyValue = keyDraft.trim()
      if (keyValue.length > 0) {
        const ref = deriveKeyRef(routeId)
        profile['apiKeyEnv'] = ref
        await setCredential(ref, keyValue)
      }
      await mutateSettings('llm-pi-ai', [{ op: 'set', path: [routeId], value: profile }], namespace?.revision)
      onClose(true)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-editor" data-region="CustomProviderCard">
      <div className="settings-field">
        <div className="settings-field-label">{t('customId')}</div>
        <input
          className="settings-input"
          type="text"
          value={id}
          placeholder={lang === 'zh' ? '例如 my-lab' : 'e.g. my-lab'}
          aria-label={t('customId')}
          disabled={busy}
          onChange={(e) => { setId(e.target.value) }}
        />
        {idFailure !== null && <p className="settings-error">{idFailure}</p>}
      </div>
      <div className="settings-field">
        <div className="settings-field-label">{t('customDisplayName')}</div>
        <input
          className="settings-input"
          type="text"
          value={displayName}
          placeholder={routeId || (lang === 'zh' ? '同标识' : 'Same as ID')}
          aria-label={t('customDisplayName')}
          disabled={busy}
          onChange={(e) => { setDisplayName(e.target.value) }}
        />
      </div>
      <div className="settings-field">
        <div className="settings-field-label">{t('providerBaseUrl')}</div>
        <input
          className="settings-input"
          type="text"
          value={baseURL}
          placeholder="https://example.com/v1"
          aria-label={t('providerBaseUrl')}
          disabled={busy}
          onChange={(e) => { setBaseURL(e.target.value) }}
        />
      </div>
      <div className="settings-field">
        <div className="settings-field-label">{t('customProtocol')}</div>
        <select
          className="settings-input"
          value={api}
          aria-label={t('customProtocol')}
          disabled={busy}
          onChange={(e) => { setApi(e.target.value) }}
        >
          {PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div className="settings-field">
        <div className="settings-field-label">{lang === 'zh' ? 'API 密钥（可选）' : 'API Key (optional)'}</div>
        <input
          className="settings-input"
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={lang === 'zh' ? '可稍后再填' : 'Optional'}
          aria-label={t('providerKey')}
          disabled={busy}
          onChange={(e) => { setKeyDraft(e.target.value) }}
        />
      </div>
      {failure !== null && <p className="settings-error">{t('saveFailed', { error: failure })}</p>}
      <div className="settings-editor-actions">
        <button type="button" className="settings-btn" disabled={busy} onClick={() => { onClose(false) }}>
          {t('cancel')}
        </button>
        <button
          type="button"
          className="settings-btn settings-btn-primary"
          disabled={!canSubmit}
          onClick={() => { void save() }}
        >
          {busy ? (lang === 'zh' ? '保存中…' : 'Saving…') : (lang === 'zh' ? '添加' : 'Add')}
        </button>
      </div>
    </div>
  )
}
