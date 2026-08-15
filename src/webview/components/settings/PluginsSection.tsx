/**
 * PluginsSection (W6): read-only inventory of configurable plugins — every
 * settings namespace with a non-empty schema/applies that is not surfaced by
 * another section (llm providers, UI preferences, permission, agent presets)
 * renders as a card with its name and schema description. Editing plugin
 * settings is a leftover (see the W6 report).
 */

import type { JSX } from 'react'
import type { SettingsNamespaceView } from '../../../extension/protocol/settings'
import { useAppStore } from '../../store'

/** Namespaces owned by other settings sections, excluded from the plugin list. */
const NON_PLUGIN_NS = /^(llm-|ui-theme$|locale$|ui-conversation$|permission$|agent-presets$|ui-onboarding$)/

/** Whether a namespace describes a configurable plugin section. */
function isPluginNamespace(ns: SettingsNamespaceView): boolean {
  if (NON_PLUGIN_NS.test(ns.ns)) return false
  const hasSchema = typeof ns.schema === 'object' && ns.schema !== null && Object.keys(ns.schema).length > 0
  return hasSchema || ns.applies === 'restart'
}

/** Best-effort description from the serialized schema envelope's meta. */
function descriptionOf(ns: SettingsNamespaceView): string | null {
  const meta = (ns.schema as { meta?: { description?: unknown } } | null)?.meta
  return typeof meta?.description === 'string' && meta.description.length > 0 ? meta.description : null
}

export function PluginsSection(): JSX.Element {
  const namespaces = useAppStore((s) => s.namespaces)
  const plugins = namespaces.filter(isPluginNamespace)

  return (
    <div className="settings-section" data-region="PluginsSection">
      <h2 className="settings-section-title">插件</h2>
      <p className="settings-section-intro">可配置插件清单。插件设置的编辑能力暂未提供。</p>
      {plugins.length === 0 ? (
        <p className="settings-empty">没有可配置的插件。</p>
      ) : (
        <ul className="settings-plugin-list">
          {plugins.map((ns) => (
            <li key={ns.ns} className="settings-plugin-card">
              <div className="settings-plugin-head">
                <span className="settings-plugin-name">{ns.ns}</span>
                {ns.applies === 'restart' && <span className="settings-tag">重启生效</span>}
              </div>
              {descriptionOf(ns) !== null && <p className="settings-plugin-desc">{descriptionOf(ns)}</p>}
              {ns.secrets.length > 0 && (
                <p className="settings-plugin-desc">
                  {`凭据：${ns.secrets.map((s) => `${s.path.join('.')}（${s.set ? '已配置' : '未配置'}）`).join('、')}`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
