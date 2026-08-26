/**
 * ModelsSection (W6): the provider list with configured dots and custom tags,
 * one inline editor card at a time (API key + baseURL), the add-provider and
 * add-custom-provider entries, and a confirmed removal flow (credential unset
 * first, then the settings path).
 * Reference: dsh web ui-settings-models ModelsSection.
 */

import { useState, type JSX } from 'react'
import type { ConfigurableProviderView } from '../../../extension/protocol/settings'
import { useAppStore } from '../../store'
import { deriveKeyRef, type ProviderTarget } from '../../store/settings'
import { ConfirmModal } from '../common/ConfirmModal'
import { CustomProviderCard } from './CustomProviderCard'
import { ProviderEditorCard } from './ProviderEditorCard'
import { useI18n } from '../../i18n'

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
  const { t } = useI18n()
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

  /** The credential ref one provider's profile resolves keys through. */
  const refOf = (provider: ConfigurableProviderView): string => {
    const ns = namespaces.find((n) => n.ns === provider.settingsNs)
    const profile = valueAt(ns?.value, provider.settingsPath)
    const named = typeof profile === 'object' && profile !== null
      ? (profile as Record<string, unknown>)['apiKeyEnv']
      : undefined
    return typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(provider.provider)
  }

  const isConfigured = (p: ConfigurableProviderView): boolean => {
    if (p.declared === true) return true
    if (credentials[refOf(p)]?.configured === true) return true
    const ns = namespaces.find((n) => n.ns === p.settingsNs)
    if (ns !== undefined && p.settingsPath.length > 0 && valueAt(ns.value, p.settingsPath) !== undefined) {
      return true
    }
    return false
  }

  const configured = providers.filter(isConfigured)
  const addable = providers.filter((p) => !isConfigured(p) && p.settingsNs !== '')

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
      <h2 className="settings-section-title">{t('modelsTitle')}</h2>
      <p className="settings-section-intro">{t('modelsIntro')}</p>
      {!settingsWritable && <p className="settings-notice">{t('modelsReadOnlyNotice')}</p>}
      {savedName !== null && (
        <p className="settings-saved" role="status" aria-live="polite">{t('modelsSaved', { name: savedName })}</p>
      )}
      <ul className="settings-provider-list">
        {configured.map((provider) => {
          const target = targetOf(provider)
          const ref = refOf(provider)
          const isCredConfigured = credentials[ref]?.configured === true
          const open = !adding && !declaring && editingId === provider.provider
          return (
            <li key={provider.provider} className="settings-provider-card">
              <div className="settings-provider-head">
                <span className="settings-provider-identity">
                  <span
                    className={`settings-dot ${isCredConfigured ? 'settings-dot-ok' : 'settings-dot-missing'}`}
                    role="img"
                    aria-label={isCredConfigured ? t('modelsDotOk') : t('modelsDotMissing')}
                    title={isCredConfigured ? t('modelsDotOk') : t('modelsDotMissing')}
                  />
                  <span className="settings-provider-name">{provider.displayName}</span>
                  {provider.declared === true && <span className="settings-tag">{t('modelsTagCustom')}</span>}
                </span>
                <span className="settings-provider-actions">
                  <button
                    type="button"
                    className="settings-btn settings-btn-small"
                    aria-label={`${t('edit')} ${providerLabel(target)}`}
                    onClick={() => { startEdit(provider) }}
                  >
                    {t('edit')}
                  </button>
                  {provider.declared === true && (
                    <button
                      type="button"
                      className="settings-btn settings-btn-small settings-btn-danger"
                      aria-label={`${t('delete')} ${providerLabel(target)}`}
                      disabled={!settingsWritable}
                      onClick={() => {
                        setSavedName(null)
                        setDeleteFailure(null)
                        setDeleteTarget(target)
                      }}
                    >
                      {t('delete')}
                    </button>
                  )}
                </span>
              </div>
              {open && <ProviderEditorCard target={target} onClose={(changed) => { closeEditor(changed, target) }} />}
            </li>
          )
        })}
        {configured.length === 0 && <li className="settings-empty">{t('modelsNoConfigured')}</li>}
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
              <div className="settings-field-label">{t('modelsProviderLabel')}</div>
              <select
                className="settings-input"
                value={addTarget.provider}
                aria-label={t('modelsProviderLabel')}
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
              {t('modelsAddProvider')}
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
              {t('modelsAddCustomProvider')}
            </button>
          </div>
        )}
      </div>
      {deleteTarget !== null && (
        <ConfirmModal
          title={t('modelsDeleteTitle', { name: providerLabel(deleteTarget) })}
          description={deleteTarget.credentialRef === undefined
            ? t('modelsDeleteDesc')
            : t('modelsDeleteWithKeyDesc')}
          confirmLabel={`${t('delete')} ${deleteTarget.displayName}`}
          busy={deleting}
          failure={deleteFailure}
          onConfirm={confirmDelete}
          onCancel={() => { if (!deleting) { setDeleteTarget(null); setDeleteFailure(null) } }}
        />
      )}
    </div>
  )
}
