/**
 * ModelsSection (W6): the provider list with configured dots and custom tags,
 * one inline editor card at a time (API key + baseURL), the add-provider and
 * add-custom-provider entries, and a confirmed removal flow (credential unset
 * first, then the settings path). First-run posture: with no usable provider,
 * the first provider's editor card stays expanded. Reference: dsh web
 * ui-settings-models ModelsSection (narrowed for the ~360px sidebar).
 */

import { useState, type JSX } from 'react'
import type { ConfigurableProviderView } from '../../../extension/protocol/settings'
import { useAppStore } from '../../store'
import { deriveKeyRef, type ProviderTarget } from '../../store/settings'
import { ConfirmModal } from './ConfirmModal'
import { CustomProviderCard } from './CustomProviderCard'
import { ProviderEditorCard } from './ProviderEditorCard'

/** Read the value at a path inside a plain object (redacted namespace value). */
function valueAt(source: unknown, path: string[]): unknown {
  let node = source
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Stable visible identity for one provider (displayName + route id). */
function providerLabel(target: ProviderTarget): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

export function ModelsSection(): JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const namespaces = useAppStore((s) => s.namespaces)
  const credentials = useAppStore((s) => s.credentials)
  const settingsWritable = useAppStore((s) => s.settingsWritable)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const removeProvider = useAppStore((s) => s.removeProvider)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addTargetId, setAddTargetId] = useState<string | null>(null)
  const [declaring, setDeclaring] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProviderTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null)
  const [savedName, setSavedName] = useState<string | null>(null)
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(new Set())

  /** The credential ref one provider's profile resolves keys through. */
  const refOf = (provider: ConfigurableProviderView): string => {
    const ns = namespaces.find((n) => n.ns === provider.settingsNs)
    const profile = valueAt(ns?.value, provider.settingsPath)
    const named = typeof profile === 'object' && profile !== null
      ? (profile as Record<string, unknown>)['apiKeyEnv']
      : undefined
    return typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(provider.provider)
  }

  const targetOf = (provider: ConfigurableProviderView): ProviderTarget => {
    const ref = refOf(provider)
    const managed = credentials[ref]?.configured === true && credentials[ref]?.writable !== false
    return {
      provider: provider.provider,
      displayName: provider.displayName,
      settingsNs: provider.settingsNs,
      settingsPath: [...provider.settingsPath],
      ...(managed ? { credentialRef: ref } : {}),
    }
  }

  const announceSaved = (target: ProviderTarget): void => {
    void loadSettings().then(() => { setSavedName(providerLabel(target)) })
  }

  const closeEditor = (changed: boolean, target: ProviderTarget): void => {
    setEditingId(null)
    setAdding(false)
    setAddTargetId(null)
    setDeclaring(false)
    if (changed) announceSaved(target)
  }

  const closeSetup = (changed: boolean, target: ProviderTarget): void => {
    setDismissedSetup((prev) => new Set([...prev, target.provider]))
    if (changed) announceSaved(target)
  }

  const confirmDelete = (): void => {
    if (deleteTarget === null || deleting) return
    setDeleting(true)
    setDeleteFailure(null)
    void removeProvider(deleteTarget)
      .then(() => { setDeleteTarget(null) })
      .catch((error: unknown) => {
        setDeleteFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => { setDeleting(false) })
  }

  // First-run posture: nothing can serve requests yet -> the first provider's
  // editor card IS its presence on the page.
  const anyUsable = providers.some((p) => credentials[refOf(p)]?.configured === true)
  const addable = providers.filter((p) => credentials[refOf(p)]?.configured !== true)

  const startEdit = (provider: ConfigurableProviderView): void => {
    setSavedName(null)
    setAdding(false)
    setDeclaring(false)
    setEditingId((current) => (current === provider.provider ? null : provider.provider))
  }

  const startAdd = (): void => {
    const first = addable[0]
    if (first === undefined) return
    setSavedName(null)
    setDeclaring(false)
    setEditingId(null)
    setAdding(true)
    setAddTargetId(first.provider)
  }

  const addTarget = addable.find((p) => p.provider === addTargetId) ?? addable[0]

  return (
    <div className="settings-section" data-region="ModelsSection">
      <h2 className="settings-section-title">模型</h2>
      <p className="settings-section-intro">填入各提供方的 API 密钥即可使用其模型。</p>
      {!settingsWritable && <p className="settings-notice">设置为只读：当前环境不允许修改。</p>}
      {savedName !== null && (
        <p className="settings-saved" role="status" aria-live="polite">{`已保存 ${savedName}`}</p>
      )}
      <ul className="settings-provider-list">
        {providers.map((provider) => {
          const target = targetOf(provider)
          const ref = refOf(provider)
          const configured = credentials[ref]?.configured === true
          if (!anyUsable && provider === providers[0] && !dismissedSetup.has(provider.provider)) {
            return (
              <li key={provider.provider} className="settings-provider-card">
                <div className="settings-provider-head">
                  <span className="settings-provider-name">{provider.displayName}</span>
                </div>
                <ProviderEditorCard target={target} onClose={(changed) => { closeSetup(changed, target) }} />
              </li>
            )
          }
          const open = !adding && !declaring && editingId === provider.provider
          return (
            <li key={provider.provider} className="settings-provider-card">
              <div className="settings-provider-head">
                <span className="settings-provider-identity">
                  <span
                    className={`settings-dot ${configured ? 'settings-dot-ok' : 'settings-dot-missing'}`}
                    role="img"
                    aria-label={configured ? '已配置' : '未配置'}
                    title={configured ? '已配置' : '未配置'}
                  />
                  <span className="settings-provider-name">{provider.displayName}</span>
                  {provider.declared === true && <span className="settings-tag">自定义</span>}
                </span>
                <span className="settings-provider-actions">
                  <button
                    type="button"
                    className="settings-btn settings-btn-small"
                    aria-label={`编辑 ${providerLabel(target)}`}
                    onClick={() => { startEdit(provider) }}
                  >
                    编辑
                  </button>
                  {provider.declared === true && (
                    <button
                      type="button"
                      className="settings-btn settings-btn-small settings-btn-danger"
                      aria-label={`删除 ${providerLabel(target)}`}
                      disabled={!settingsWritable}
                      onClick={() => {
                        setSavedName(null)
                        setDeleteFailure(null)
                        setDeleteTarget(target)
                      }}
                    >
                      删除
                    </button>
                  )}
                </span>
              </div>
              {open && <ProviderEditorCard target={target} onClose={(changed) => { closeEditor(changed, target) }} />}
            </li>
          )
        })}
        {providers.length === 0 && <li className="settings-empty">没有可用的提供方。</li>}
      </ul>
      <div className="settings-add-block">
        {declaring ? (
          <CustomProviderCard
            taken={providers.map((p) => p.provider)}
            onClose={(changed) => {
              setDeclaring(false)
              if (changed) void loadSettings()
            }}
          />
        ) : adding && addTarget !== undefined ? (
          <div className="settings-editor">
            <div className="settings-field">
              <div className="settings-field-label">提供方</div>
              <select
                className="settings-input"
                value={addTarget.provider}
                aria-label="提供方"
                onChange={(e) => { setAddTargetId(e.target.value) }}
              >
                {addable.map((p) => (
                  <option key={p.provider} value={p.provider}>{p.displayName}</option>
                ))}
              </select>
            </div>
            <ProviderEditorCard
              key={addTarget.provider}
              target={targetOf(addTarget)}
              onClose={(changed) => { closeEditor(changed, targetOf(addTarget)) }}
            />
          </div>
        ) : (
          <div className="settings-add-actions">
            <button
              type="button"
              className="settings-btn"
              disabled={addable.length === 0 || !settingsWritable}
              onClick={startAdd}
            >
              添加提供方
            </button>
            <button
              type="button"
              className="settings-btn"
              disabled={!settingsWritable || namespaces.every((n) => n.ns !== 'llm-pi-ai')}
              onClick={() => {
                setSavedName(null)
                setAdding(false)
                setEditingId(null)
                setDeclaring(true)
              }}
            >
              添加自定义提供方
            </button>
          </div>
        )}
      </div>
      {deleteTarget !== null && (
        <ConfirmModal
          title={`删除 ${providerLabel(deleteTarget)}`}
          description={deleteTarget.credentialRef === undefined
            ? '将删除该提供方的配置。此操作不可撤销。'
            : '将删除该提供方的配置，并同时移除已保存的 API 密钥。此操作不可撤销。'}
          confirmLabel={`删除 ${deleteTarget.displayName}`}
          busy={deleting}
          failure={deleteFailure}
          onConfirm={confirmDelete}
          onCancel={() => { if (!deleting) { setDeleteTarget(null); setDeleteFailure(null) } }}
        />
      )}
    </div>
  )
}
