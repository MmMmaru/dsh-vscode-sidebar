/**
 * AttachmentRail (owned by W4): the thumbnail strip of not-yet-sent image
 * attachments at the top of the composer card. Intake (file picker, drag &
 * drop, paste) lives in ComposerCard; this row renders the accepted images
 * and their remove buttons.
 * Contract: ARCHITECTURE.md section 5.3 ({ items, onRemove }).
 */

import type { JSX } from 'react'
import type { Attachment } from '../../types'

export interface AttachmentRailProps {
  items: Attachment[]
  onRemove: (id: string) => void
}

export function AttachmentRail({ items, onRemove }: AttachmentRailProps): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <ul className="attachment-rail" aria-label="附件列表">
      {items.map((item) => (
        <li key={item.id} className="attachment-thumb">
          {item.previewUrl !== undefined ? (
            <img src={item.previewUrl} alt={item.name ?? '图片附件'} />
          ) : (
            <span className="attachment-fallback">{item.name ?? '图片'}</span>
          )}
          <button
            type="button"
            className="attachment-remove"
            aria-label={`移除附件 ${item.name ?? ''}`}
            onClick={() => onRemove(item.id)}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  )
}
