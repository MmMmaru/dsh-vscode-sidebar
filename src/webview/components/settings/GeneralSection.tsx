/**
 * GeneralSection (W6): language, appearance, busy-Enter behavior and the
 * default permission mode for new sessions. Each preference persists through a
 * writable settings namespace when the host exposes one (locale / ui-theme /
 * ui-conversation / permission), else a localStorage fallback — see the
 * settings slice's uiPrefSources.
 */

import { useEffect, useState, type JSX } from 'react'
import { restartHost } from '../../bridge'
import { useAppStore } from '../../store'
import type { UiPrefs } from '../../store/settings'
import { useI18n } from '../../i18n'
import type { I18nKey } from '../../i18n'

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

/** Port configuration row: number input + save button. */
function PortRow(): JSX.Element {
  const { t } = useI18n()
  const port = useAppStore((s) => s.port)
  const setPort = useAppStore((s) => s.setPort)
  const [draft, setDraft] = useState(() => String(port || 3080))
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(String(port || 3080))
  }, [port])

  const save = async (): Promise<void> => {
    const num = Number.parseInt(draft, 10)
    if (Number.isNaN(num) || num < 1024 || num > 65535) {
      setFailure(t('portInvalid'))
      return
    }
    setFailure(null)
    setBusy(true)
    try {
      await setPort(num)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-field" data-pref="port">
      <div className="settings-field-label">{t('generalPort')}</div>
      <div className="settings-field-desc">{t('generalPortDesc')}</div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
        <input
          type="number"
          min={1024}
          max={65535}
          className="settings-input"
          style={{ width: '120px' }}
          value={draft}
          disabled={busy}
          onChange={(e) => {
            setDraft(e.target.value)
            setSaved(false)
            setFailure(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
        <button
          type="button"
          className="settings-btn settings-btn-primary"
          disabled={busy || draft === String(port)}
          onClick={() => void save()}
        >
          {busy ? t('loading') : t('save')}
        </button>
        {saved && <span style={{ fontSize: '0.85em', color: 'var(--vscode-testing-iconPassed, #73c991)' }}>{t('portSaved')}</span>}
      </div>
      {failure !== null && <p className="settings-error">{failure}</p>}
    </div>
  )
}

/** Restart DSH process row: button to restart the background dsh host. */
function RestartHostRow(): JSX.Element {
  const { t } = useI18n()
  const hostStatus = useAppStore((s) => s.hostStatus)
  const [restarting, setRestarting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const handleRestart = async (): Promise<void> => {
    setFailure(null)
    setRestarting(true)
    try {
      await restartHost()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setRestarting(false)
    }
  }

  const busy = restarting || hostStatus === 'starting'

  return (
    <div className="settings-field" data-pref="restart-host">
      <div className="settings-field-label">{t('restartDsh')}</div>
      <div className="settings-field-desc">{t('restartDshDesc')}</div>
      <div style={{ marginTop: '6px' }}>
        <button
          type="button"
          className="settings-btn settings-btn-secondary"
          disabled={busy}
          onClick={() => void handleRestart()}
        >
          {busy ? t('restartingDsh') : t('restartDsh')}
        </button>
      </div>
      {failure !== null && <p className="settings-error">{failure}</p>}
    </div>
  )
}

/** Environment variable names accepted by the host spawn (mirrors the extension's normalizeEnv). */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One edited row; `key` is the stable React identity, `originalName` the saved name. */
interface EnvDraftRow {
  key: string
  name: string
  value: string
  originalName?: string
  /** Masked by default: these values are usually API keys or tokens. */
  secret: boolean
}

let envRowSeq = 0

/** Fresh draft row from a saved entry (or an empty row for the add button). */
function envRow(name: string, value: string, secret: boolean): EnvDraftRow {
  envRowSeq++
  // A blank row is not yet a saved entry: leaving `originalName` undefined is
  // what lets the row start as an error-free placeholder.
  return { key: `env-${String(envRowSeq)}`, name, value, originalName: name === '' ? undefined : name, secret }
}

/** Draft rows for the saved environment, values masked when the name looks secret-ish. */
function toDraftEnv(env: Record<string, string>): EnvDraftRow[] {
  return Object.entries(env).map(([name, value]) => envRow(name, value, /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(name)))
}

/** Saved environment rebuilt from the draft (blank value half-typed for a brand-new row). */
function fromDraftEnv(rows: EnvDraftRow[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (name === '' || row.value === '') continue
    env[name] = row.value
  }
  return env
}

/** Draft equality against persisted truth: order-insensitive, excludes half-typed rows. */
function sameEnv(env: Record<string, string>, rows: EnvDraftRow[]): boolean {
  const draft = fromDraftEnv(rows)
  const names = Object.keys(env)
  return names.length === Object.keys(draft).length && names.every((name) => draft[name] === env[name])
}

/** First blocking error of one draft row, or null when the row is acceptable. */
function rowError(row: EnvDraftRow, rows: EnvDraftRow[], t: (key: I18nKey) => string, index: number): string | null {
  const name = row.name.trim()
  // A brand-new row is a placeholder, not an error, until the user types something.
  if (row.originalName === undefined && name === '' && row.value === '') return null
  if (row.originalName === undefined && name === '') return t('envNameMissing')
  if (name !== '' && !ENV_NAME_PATTERN.test(name)) return t('envInvalidName')
  // Duplicate before the empty-value check: reusing a saved name is the more
  // useful diagnosis for an added row whose value is still blank.
  const duplicate = rows.findIndex((other) => other.name.trim() !== '' && other.name.trim() === name)
  if (duplicate !== index && duplicate !== -1) return t('envDuplicateName')
  if (row.value === '') return t('envValueMissing')
  return null
}

/**
 * Environment-variable editor: the KEY -> value map injected into the dsh host
 * process this extension spawns (VS Code setting `dsh.env`). Values are masked
 * by default — they are typically API keys. Saving never restarts a running
 * host, so the row carries a restart hint instead of pretending to apply live.
 */
function EnvRow(): JSX.Element {
  const { t } = useI18n()
  const env = useAppStore((s) => s.env)
  const setEnv = useAppStore((s) => s.setEnv)
  const [rows, setRows] = useState<EnvDraftRow[]>(() => toDraftEnv(env))
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  // Adopt out-of-band updates (init payload after a hidden webview re-resolves,
  // or the extension's echo) unless the user is mid-edit.
  useEffect(() => {
    setRows((current) => (sameEnv(env, current) ? current : toDraftEnv(env)))
  }, [env])

  const patch = (key: string, next: Partial<EnvDraftRow>): void => {
    setSaved(false)
    setFailure(null)
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...next } : row)))
  }

  const save = async (): Promise<void> => {
    const errors = rows.map((row, index) => rowError(row, rows, t, index)).filter((error): error is string => error !== null)
    if (errors.length > 0) {
      setFailure(errors[0] ?? t('saveFailed', { error: '' }))
      return
    }
    setFailure(null)
    setBusy(true)
    try {
      await setEnv(fromDraftEnv(rows))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  // Rows that cannot be persisted (invalid name, empty value) are dropped by
  // `fromDraftEnv`, so Save arms only once the draft holds a real change. Those
  // rows already carry their own inline error, which is the diagnosis the user
  // reads while Save stays disabled.
  const dirty = !sameEnv(env, rows)

  return (
    <div className="settings-field" data-pref="env">
      <div className="settings-field-label">{t('generalEnv')}</div>
      <div className="settings-field-desc">{t('generalEnvDesc')}</div>
      {rows.length === 0 && <p className="settings-empty">{t('envEmpty')}</p>}
      {rows.map((row, index) => {
        const error = rowError(row, rows, t, index)
        return (
          <div className="settings-env-row" key={row.key} data-error={error !== null}>
            <input
              type="text"
              data-testid="env-name"
              className="settings-input settings-env-name"
              placeholder={t('envNamePlaceholder')}
              spellCheck={false}
              value={row.name}
              disabled={busy}
              onChange={(e) => patch(row.key, { name: e.target.value })}
            />
            <input
              type={row.secret ? 'password' : 'text'}
              data-testid="env-value"
              className="settings-input settings-env-value"
              placeholder={t('envValuePlaceholder')}
              spellCheck={false}
              value={row.value}
              disabled={busy}
              onChange={(e) => patch(row.key, { value: e.target.value })}
            />
            <button
              type="button"
              data-testid="env-reveal"
              className="settings-btn settings-btn-small"
              title={row.secret ? t('envShow') : t('envHide')}
              aria-label={row.secret ? t('envShow') : t('envHide')}
              onClick={() => patch(row.key, { secret: !row.secret })}
            >
              {row.secret ? '👁' : '🙈'}
            </button>
            <button
              type="button"
              data-testid="env-remove"
              className="settings-btn settings-btn-small settings-btn-danger"
              aria-label={t('remove')}
              onClick={() => {
                setSaved(false)
                setFailure(null)
                setRows((current) => current.filter((item) => item.key !== row.key))
              }}
            >
              ✕
            </button>
            {error !== null && <p className="settings-error settings-env-error">{error}</p>}
          </div>
        )
      })}
      <div className="settings-env-actions">
        <button
          type="button"
          data-testid="env-add"
          className="settings-btn settings-btn-small"
          onClick={() => setRows((current) => [...current, envRow('', '', false)])}
        >
          + {t('envAdd')}
        </button>
        <button
          type="button"
          data-testid="env-save"
          className="settings-btn settings-btn-primary"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {busy ? t('loading') : t('save')}
        </button>
        {saved && (
          <span className="settings-env-saved">
            {t('envSaved')} · {t('envRestartHint')}
          </span>
        )}
      </div>
      {failure !== null && <p className="settings-error">{failure}</p>}
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
      <PortRow />
      <RestartHostRow />
      <EnvRow />
    </div>
  )
}
