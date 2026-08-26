/**
 * TodoPanel (owned by W4): the agent todo checklist docked above the composer
 * card while store.todos is non-empty. Supports collapsing to a single summary
 * header row.
 * Status glyphs: completed ✓ / in_progress ◌ / pending ○.
 * Contract: ARCHITECTURE.md section 5.3 ({ todos }).
 */

import { useState, type JSX } from 'react'
import type { TodoItem } from '../../types'
import { useI18n } from '../../i18n'

const STATUS_GLYPH: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '◌',
  pending: '○',
}

export interface TodoPanelProps {
  todos: TodoItem[]
}

export function TodoPanel({ todos }: TodoPanelProps): JSX.Element | null {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  if (todos.length === 0) return null

  const completedCount = todos.filter((t) => t.status === 'completed').length

  const statusLabel: Record<TodoItem['status'], string> = {
    completed: t('todoCompleted'),
    in_progress: t('todoInProgress'),
    pending: t('todoPending'),
  }

  return (
    <div className="todo-panel">
      <div
        className="todo-header"
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setCollapsed((v) => !v)
          }
        }}
      >
        <span className="todo-header-icon" aria-hidden>📋</span>
        <span className="todo-header-title">{t('todoTitle')}</span>
        <span className="todo-header-count">({completedCount}/{todos.length})</span>
        <span className="todo-header-toggle">{collapsed ? `${t('expand')} ▾` : `${t('collapse')} ▴`}</span>
      </div>
      {!collapsed && (
        <ul className="todo-list" aria-label={t('todoTitle')}>
          {todos.map((todo, i) => (
            <li key={`${i}-${todo.content}`} className={`todo-item todo-${todo.status}`}>
              <span className="todo-glyph" aria-hidden>{STATUS_GLYPH[todo.status]}</span>
              <span className="todo-content">{todo.content}</span>
              <span className="todo-status">{statusLabel[todo.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
