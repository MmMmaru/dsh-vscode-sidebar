/**
 * ModelSelect (owned by W4): the two-level model menu at the composer
 * toolbar's right, aligned with the dsh web ModelSelect. The root pane shows
 * the Model / Effort row pair (label + current value + right chevron), each
 * drilling into its own list: models grouped by provider, and the reasoning
 * effort levels of the current model. The trigger shows `模型名 · effort`.
 * Contract: ARCHITECTURE.md section 5.3 ({ models, selected, onSelect }).
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ModelSelection } from '../../../extension/protocol/sessions'
import type { ModelInfo } from '../../types'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

export interface ModelSelectProps {
  /** Flattened selectable models across provider groups (store.models). */
  models: ModelInfo[]
  /** Current selection of the active session (store.selectedModel). */
  selected: ModelSelection | null
  /** store.selectModel; absence of effort preserves the provider default. */
  onSelect: (provider: string, model: string, reasoningEffort?: string) => Promise<void>
}

/** One effort row; undefined effort means "preserve the provider default". */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

export function ModelSelect({ models, selected, onSelect }: ModelSelectProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const current = useMemo(
    () => models.find((m) => m.provider === selected?.provider && m.id === selected.model) ?? null,
    [models, selected],
  )
  const reasoning = current?.reasoning
  const effectiveEffort = selected?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? 'Provider default'
      : reasoning.efforts.find((e) => e.id === effectiveEffort)?.name ?? effectiveEffort

  const effortChoices = useMemo<readonly EffortChoice[]>(() => {
    if (reasoning === undefined) return []
    return [
      ...(reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: 'Provider default' }]
        : []),
      ...reasoning.efforts.map((e) => ({
        key: `effort:${e.id}`,
        effort: e.id as string | undefined,
        label: e.name,
        ...(e.description === undefined ? {} : { description: e.description }),
      })),
    ]
  }, [reasoning])

  /** Provider-grouped view of the flat model list, first-seen order. */
  const groups = useMemo(() => {
    const out: Array<{ provider: string; providerName: string; models: ModelInfo[] }> = []
    for (const m of models) {
      let group = out.find((g) => g.provider === m.provider)
      if (group === undefined) {
        group = { provider: m.provider, providerName: m.providerName, models: [] }
        out.push(group)
      }
      group.models.push(m)
    }
    return out
  }, [models])

  // Outside click closes; Escape backs out of a drilled pane first, then closes.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return
      setOpen(false)
      setPane('root')
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (pane !== 'root') setPane('root')
      else setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, pane])

  const submit = (provider: string, model: string, effort: string | undefined): void => {
    setBusy(true)
    setError(null)
    void onSelect(provider, model, effort)
      .then(() => {
        setOpen(false)
        setPane('root')
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const chooseModel = (m: ModelInfo): void => {
    if (selected !== null && m.provider === selected.provider && m.id === selected.model) {
      setOpen(false)
      setPane('root')
      return
    }
    submit(m.provider, m.id, m.reasoning?.defaultEffort)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (selected === null || effort === effectiveEffort) {
      setOpen(false)
      setPane('root')
      return
    }
    submit(selected.provider, selected.model, effort)
  }

  const modelLabel = current?.name ?? '选择模型'
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`

  return (
    <div ref={rootRef} className="model-select">
      <button
        type="button"
        className="composer-chip"
        aria-label={`选择模型，当前 ${triggerLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerLabel}
        disabled={models.length === 0}
        onClick={() => {
          if (open) setOpen(false)
          else {
            setPane('root')
            setOpen(true)
          }
        }}
      >
        <span className="composer-chip-label">{modelLabel}</span>
        {effortLabel !== undefined && <span className="composer-chip-effort">{effortLabel}</span>}
      </button>
      {open && (
        <div className="composer-menu model-menu" role="menu" aria-label="模型选择" aria-busy={busy}>
          {error !== null && <div className="composer-menu-error">{error}</div>}
          {pane === 'root' && (
            <>
              <button type="button" role="menuitem" className="composer-menu-cell" onClick={() => setPane('model')}>
                <span className="composer-menu-cell-label">Model</span>
                <span className="composer-menu-cell-value">{modelLabel}</span>
                <span className="composer-menu-cell-chevron" aria-hidden>›</span>
              </button>
              {reasoning !== undefined && (
                <button type="button" role="menuitem" className="composer-menu-cell" onClick={() => setPane('effort')}>
                  <span className="composer-menu-cell-label">Effort</span>
                  <span className="composer-menu-cell-value">{effortLabel}</span>
                  <span className="composer-menu-cell-chevron" aria-hidden>›</span>
                </button>
              )}
            </>
          )}
          {pane === 'model' && (
            <div className="composer-menu-groups">
              {groups.map((group) => (
                <section key={group.provider} className="composer-menu-group" role="group" aria-label={group.providerName}>
                  <div className="composer-menu-group-title">{group.providerName}</div>
                  {group.models.map((m) => {
                    const isSelected = selected?.provider === m.provider && selected.model === m.id
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        className={`composer-menu-item${isSelected ? ' selected' : ''}`}
                        disabled={busy}
                        onClick={() => chooseModel(m)}
                      >
                        <span className="composer-menu-item-copy">
                          <span className="composer-menu-item-label">{m.name}</span>
                          {m.description !== undefined && (
                            <span className="composer-menu-item-desc">{m.description}</span>
                          )}
                        </span>
                        <span className="composer-menu-check">{isSelected ? '✓' : ''}</span>
                      </button>
                    )
                  })}
                </section>
              ))}
              {groups.length === 0 && <div className="composer-menu-empty">暂无可用模型</div>}
            </div>
          )}
          {pane === 'effort' && (
            <div className="composer-menu-groups">
              {effortChoices.length === 0 && <div className="composer-menu-empty">该模型无可选 effort</div>}
              {effortChoices.map((choice) => {
                const isSelected = effectiveEffort === choice.effort
                return (
                  <button
                    key={choice.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className={`composer-menu-item${isSelected ? ' selected' : ''}`}
                    disabled={busy}
                    onClick={() => chooseEffort(choice.effort)}
                  >
                    <span className="composer-menu-item-copy">
                      <span className="composer-menu-item-label">{choice.label}</span>
                      {choice.description !== undefined && (
                        <span className="composer-menu-item-desc">{choice.description}</span>
                      )}
                    </span>
                    <span className="composer-menu-check">{isSelected ? '✓' : ''}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
