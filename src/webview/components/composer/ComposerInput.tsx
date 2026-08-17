/**
 * ComposerInput (owned by W4): the auto-growing multiline textarea of the
 * composer card. Keyboard contract (PRD 3.3, aligned with the dsh web
 * InputBar): Enter sends, Shift+Enter breaks the line, IME-composition Enter
 * never sends, held-down Enter does not machine-gun sends, Escape dismisses
 * the suggestion popup first and otherwise interrupts the running turn
 * (same action as the stop button). Typing `/` at the head of the draft opens
 * slash suggestions — the host slash commands (/goal, /compact, /plan, which
 * the host executes instead of sending to the model) followed by the session's
 * skill catalog (skill.list RPC) — and `@` opens file reference suggestions
 * (static mock list). Pasted image files are handed to the owning card
 * through onPasteFiles.
 * Contract: ARCHITECTURE.md section 5.3 ({ value, onChange, onSend, running }).
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SkillEntry } from '../../../extension/protocol/views'
import type { SessionId } from '../../../extension/protocol/brand'
import { rpc } from '../../bridge'

/** Minimum visible rows (the textarea also starts with rows=2). */
const MIN_ROWS = 2
/** Cap on visible rows; beyond this the textarea scrolls internally. */
const MAX_ROWS = 14

/** Static mock file list for `@` reference suggestions (session-file RPC does not exist yet). */
const MOCK_FILES: readonly string[] = [
  'src/webview/App.tsx',
  'src/webview/store/composer.ts',
  'src/webview/store/conversation.ts',
  'src/webview/components/composer/ComposerCard.tsx',
  'docs/PRD.md',
  'docs/ARCHITECTURE.md',
  'package.json',
  'README.md',
]

/**
 * Host slash commands: sending a prompt whose content is exactly one text
 * block starting with `/` makes the HOST execute the command through its
 * command registry (it never reaches the model). Names/descriptions mirror
 * the harness command packages (goal: command-goal, compact: command-compact,
 * plan: plan-mode). The sidebar lists them so the `/` popup can prompt them.
 */
export interface SlashCommand {
  name: string
  description: string
  /** Usage hint (the host command's input hint), appended after the description. */
  hint?: string
}

export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'goal',
    description: '设置或查看长期任务目标',
    hint: '<目标>|clear|edit|pause|resume',
  },
  { name: 'compact', description: '压缩较早的对话历史' },
  { name: 'plan', description: '进入或退出计划模式', hint: 'off|消息' },
]

/** One suggestion popup state: what trigger opened it and where the token starts. */
export interface SuggestionState {
  kind: 'command' | 'mention'
  /** Index in the draft where the trigger char (`/` or `@`) sits. */
  start: number
  /** Text typed after the trigger char, used to filter. */
  query: string
}

/**
 * Detect a live suggestion trigger from the draft and caret position.
 * Slash commands: draft starts with `/` and the caret sits inside the first
 * token. Mentions: an `@` directly before the caret starts a token without spaces.
 * @param value - current draft text.
 * @param caret - selection start (collapsed caret) in the draft.
 * @returns the trigger description, or null when no suggestion applies.
 */
export function detectSuggestion(value: string, caret: number): SuggestionState | null {
  const before = value.slice(0, caret)
  if (value.startsWith('/')) {
    const head = /^\/([\w-]*)$/.exec(before)
    if (head !== null) return { kind: 'command', start: 0, query: head[1] ?? '' }
  }
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (mention !== null) {
    const query = mention[1] ?? ''
    return { kind: 'mention', start: caret - query.length - 1, query }
  }
  return null
}

/** Case-insensitive prefix/substring filter for built-in slash commands. */
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase()
  if (q === '') return [...commands]
  return commands.filter(
    (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
  )
}

/** Case-insensitive prefix/substring filter for skill suggestions. */
export function filterSkills(skills: readonly SkillEntry[], query: string): SkillEntry[] {
  const q = query.toLowerCase()
  if (q === '') return [...skills]
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  )
}

/** Case-insensitive substring filter for `@` file suggestions. */
export function filterFiles(files: readonly string[], query: string): string[] {
  const q = query.toLowerCase()
  if (q === '') return [...files]
  return files.filter((f) => f.toLowerCase().includes(q))
}

/**
 * Escape-key arbitration, extracted pure for verification: the suggestion
 * popup owns Escape first; with no popup a running turn is interrupted.
 * @returns 'close-popup' | 'cancel' | 'ignore'.
 */
export function resolveEscape(popupOpen: boolean, running: boolean): 'close-popup' | 'cancel' | 'ignore' {
  if (popupOpen) return 'close-popup'
  if (running) return 'cancel'
  return 'ignore'
}

/**
 * Enter-key arbitration, extracted pure for verification.
 * @param e - the relevant key facts (shift / repeat / IME composition).
 * @param suggestionOpen - whether a suggestion popup currently owns Enter.
 * @returns 'send' | 'newline' | 'pick' | 'ignore'.
 */
export function resolveEnter(
  e: { shiftKey: boolean; repeat: boolean; composing: boolean },
  suggestionOpen: boolean,
): 'send' | 'newline' | 'pick' | 'ignore' {
  if (e.shiftKey) return 'newline' // unconditional, even closing an IME composition
  if (e.composing) return 'ignore' // composition Enter picks a candidate
  if (suggestionOpen) return 'pick' // the popup owns Enter while open
  if (e.repeat) return 'ignore' // held-down Enter must not machine-gun sends
  return 'send'
}

/** Apply a picked suggestion to the draft; returns the new draft + caret. */
export function applySuggestion(
  value: string,
  caret: number,
  suggestion: SuggestionState,
  picked: string,
): { value: string; caret: number } {
  const insert = suggestion.kind === 'command' ? `/${picked} ` : `@${picked} `
  const next = value.slice(0, suggestion.start) + insert + value.slice(caret)
  return { value: next, caret: suggestion.start + insert.length }
}

/** One row of the suggestion popup, regardless of trigger kind. */
export interface SuggestItem {
  kind: 'command' | 'skill' | 'file'
  key: string
  /** Bare name/path; the trigger prefix (`/` or `@`) is added at render time. */
  label: string
  description?: string
}

export interface ComposerInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  /** Interrupt the running turn (Escape, same action as the stop button). */
  onStop: () => void
  running: boolean
  /** No active session: the box stays visible but read-only. */
  disabled: boolean
  sessionId: SessionId | null
  /** Pasted image files, forwarded to the card's intake pre-check. */
  onPasteFiles: (files: File[]) => void
}

export function ComposerInput({
  value, onChange, onSend, onStop, running, disabled, sessionId, onPasteFiles,
}: ComposerInputProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  /** IME guard ref: outlives renders; cleared one tick late for Safari's ordering. */
  const composingRef = useRef(false)
  const [suggestion, setSuggestion] = useState<SuggestionState | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const skillsLoadedFor = useRef<SessionId | null>(null)

  // Lazy skill catalog load, once per session.
  useEffect(() => {
    if (sessionId === null || skillsLoadedFor.current === sessionId) return
    skillsLoadedFor.current = sessionId
    let stale = false
    void rpc<{ skills: SkillEntry[] }>('skill.list', { sessionId })
      .then((res) => { if (!stale) setSkills(res.skills) })
      .catch(() => { skillsLoadedFor.current = null })
    return () => { stale = true }
  }, [sessionId])

  // Slash popup rows: built-in host commands first, then the session's skill
  // catalog (both filtered by the token query), then mention files.
  const items = useMemo<readonly SuggestItem[]>(() => {
    if (suggestion === null) return []
    if (suggestion.kind === 'mention') {
      return filterFiles(MOCK_FILES, suggestion.query)
        .slice(0, 8)
        .map((f) => ({ kind: 'file' as const, key: f, label: f }))
    }
    const commands = filterCommands(BUILTIN_COMMANDS, suggestion.query).map((c) => ({
      kind: 'command' as const,
      key: c.name,
      label: c.name,
      description: c.hint === undefined ? c.description : `${c.description} · ${c.hint}`,
    }))
    const skillItems = filterSkills(skills, suggestion.query).map((s) => ({
      kind: 'skill' as const,
      key: s.name,
      label: s.name,
      description: s.description,
    }))
    return [...commands, ...skillItems].slice(0, 8)
  }, [suggestion, skills])
  const popupOpen = suggestion !== null && items.length > 0

  // Auto-grow: shrink to the content height, capped at MAX_ROWS of line-height.
  useEffect(() => {
    const el = textareaRef.current
    if (el === null) return
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20
    el.style.height = 'auto'
    const max = lineHeight * MAX_ROWS
    const min = lineHeight * MIN_ROWS
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [value])

  const closePopup = (): void => {
    setSuggestion(null)
    setHighlight(0)
  }

  const pick = (item: SuggestItem): void => {
    if (suggestion === null) return
    const el = textareaRef.current
    const caret = el?.selectionStart ?? value.length
    const next = applySuggestion(value, caret, suggestion, item.label)
    onChange(next.value)
    closePopup()
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(next.caret, next.caret)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // oxlint/keyCode: 229 is the legacy IME-composition signal.
    const composing =
      composingRef.current || e.nativeEvent.isComposing || (e.nativeEvent as { keyCode?: number }).keyCode === 229
    if (popupOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !composing)) {
        e.preventDefault()
        const item = items[Math.min(highlight, items.length - 1)]
        if (item !== undefined) pick(item)
        return
      }
    } else if (e.key === 'Escape') {
      // Esc interrupt: with no popup to dismiss, Escape stops the running turn.
      e.preventDefault()
      if (resolveEscape(false, running) === 'cancel') onStop()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closePopup()
      return
    }
    if (e.key !== 'Enter') return
    switch (resolveEnter({ shiftKey: e.shiftKey, repeat: e.repeat, composing }, false)) {
      case 'send':
        e.preventDefault()
        onSend()
        return
      case 'ignore':
        e.preventDefault()
        return
      default:
        return // newline: native behavior
    }
  }

  const onChangeInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = e.target.value
    onChange(next)
    const caret = e.target.selectionStart ?? next.length
    const next2 = detectSuggestion(next, caret)
    setSuggestion(next2)
    setHighlight(0)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length > 0) {
      onPasteFiles(files)
      if (e.clipboardData.getData('text/plain') === '') e.preventDefault()
    }
  }

  return (
    <div className="composer-input-wrap">
      {popupOpen && (
        <ul className="composer-suggest" role="listbox" data-suggest={suggestion?.kind}>
          {items.map((item, i) => (
            <li key={item.key} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                className={`composer-suggest-item${i === highlight ? ' active' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(item)}
              >
                <span className="composer-suggest-label">
                  {suggestion?.kind === 'mention' ? `@${item.label}` : `/${item.label}`}
                </span>
                {item.description !== undefined && (
                  <span className="composer-suggest-desc">{item.description}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={textareaRef}
        className="composer-input"
        value={value}
        rows={MIN_ROWS}
        disabled={disabled}
        placeholder={running ? 'Do anything（运行中，发送将进入队列）' : 'Do anything'}
        aria-label="消息输入"
        onChange={onChangeInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => {
          setTimeout(() => { composingRef.current = false }, 10)
        }}
      />
    </div>
  )
}
