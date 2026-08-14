/**
 * SettingsPanel placeholder (owned by W6). Contract props per ARCHITECTURE.md
 * section 5.3: `{ onClose }`. Reads the settings slice; this placeholder lists
 * the loaded namespaces and providers so the read path is exercisable.
 */

import type { JSX } from 'react'
import { useAppStore } from '../../store'

export interface SettingsPanelProps {
  /** Close the modal (settings slice: closeSettings). */
  onClose: () => void
}

export function SettingsPanel({ onClose }: SettingsPanelProps): JSX.Element {
  const namespaces = useAppStore((s) => s.namespaces)
  const providers = useAppStore((s) => s.providers)
  const settingsWritable = useAppStore((s) => s.settingsWritable)

  return (
    <div className="settings-modal" data-region="SettingsPanel" role="dialog" aria-label="Settings">
      <div className="settings-card">
        <header className="region-header">
          <span>Settings {settingsWritable ? '' : '(read-only)'}</span>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <section>
          <h3>Namespaces ({namespaces.length})</h3>
          <ul>
            {namespaces.map((n) => (
              <li key={n.ns}>{n.ns} · rev {n.revision} · secrets: {n.secrets.length}</li>
            ))}
          </ul>
          <h3>Providers ({providers.length})</h3>
          <ul>
            {providers.map((p) => (
              <li key={p.provider}>{p.displayName} ({p.provider}) {p.active ? 'active' : 'inactive'}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
