/**
 * TodoPanel (owned by W4): the agent todo checklist docked above the composer
 * card while store.todos is non-empty. Status glyphs: completed ✓ /
 * in_progress ◌ / pending ○.
 * Contract: ARCHITECTURE.md section 5.3 ({ todos }).
 */

import type { JSX } from 'react'
import type { TodoItem } from '../../types'

const STATUS_GLYPH: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '◌',
  pending: '○',
}

const STATUS_LABEL: Record<TodoItem['status'], string> = {
  completed: '已完成',
  in_progress: '进行中',
  pending: '待办',
}

export interface TodoPanelProps {
  todos: TodoItem[]
}

export function TodoPanel({ todos }: TodoPanelProps): JSX.Element | null {
  if (todos.length === 0) return null
  return (
    <ul className="todo-panel" aria-label="任务清单">
      {todos.map((todo, i) => (
        <li key={`${i}-${todo.content}`} className={`todo-item todo-${todo.status}`}>
          <span className="todo-glyph" aria-hidden>{STATUS_GLYPH[todo.status]}</span>
          <span className="todo-content">{todo.content}</span>
          <span className="todo-status">{STATUS_LABEL[todo.status]}</span>
        </li>
      ))}
    </ul>
  )
}
