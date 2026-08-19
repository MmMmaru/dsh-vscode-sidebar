/**
 * MarkdownBlock (W3): assistant text rendering with two-phase behavior —
 * while `streaming` is true the text renders as plain pre-wrapped text (code
 * fences and math stay unparsed, matching the dsh web client's incremental
 * strategy); once settled it renders full GitHub-flavored Markdown with
 * copyable code blocks.
 *
 * Code jump (TODO 5): text nodes are scanned for `path:line` references
 * (src/shared/file-refs.ts) and each match renders as a clickable chip that
 * asks the extension host to open the file at that range. The streaming fast
 * path renders the same chips on plain text; a failed jump flips the chip to
 * an error state with the host's reason in the tooltip.
 */

import { Children, cloneElement, isValidElement, useState, type JSX, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitFileRefs, type FileRef } from '../../../shared/file-refs'
import { openFileInIde } from '../../bridge'
import { useAppStore } from '../../store'

/** Pre/code renderer that adds a hover copy button to fenced blocks. */
function CodeBlock(props: { className?: string; children?: React.ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const text = String(props.children ?? '').replace(/\n$/, '')
  const lang = /language-(\w+)/.exec(props.className ?? '')?.[1]

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-header">
        <span>{lang ?? 'text'}</span>
        <button type="button" className="md-copy-btn" onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code className={props.className}>{text}</code>
      </pre>
    </div>
  )
}

/**
 * Clickable chip for one `path:line` reference: opens the file in the IDE via
 * the extension host, resolving the path against the active session's cwd.
 * A failed jump (unresolvable path, vscode open error, timeout) flips the
 * chip to a brief error state — the extension's receipt carries the reason,
 * so the failure is visible where the user clicked.
 */
function FileRefChip(props: { ref: FileRef }): JSX.Element {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const workspaceCwd = useAppStore((s) => s.cwd)
  const [error, setError] = useState<string | null>(null)

  const jump = (): void => {
    const session = sessions.find((s) => s.sessionId === activeSessionId)
    openFileInIde({
      path: props.ref.path,
      line: props.ref.line,
      ...(props.ref.endLine === undefined ? {} : { endLine: props.ref.endLine }),
      ...(props.ref.col === undefined ? {} : { col: props.ref.col }),
      ...(session?.cwd === undefined ? {} : { cwd: session.cwd }),
    }).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err)
      setError(reason)
      setTimeout(() => setError(null), 3000)
    })
    void workspaceCwd // resolution base lives in the store; kept for future use
  }

  return (
    <button
      type="button"
      className={error === null ? 'file-ref' : 'file-ref file-ref-failed'}
      title={error ?? `在编辑器中打开 ${props.ref.path}:${props.ref.line}`}
      onClick={jump}
    >
      {props.ref.path}:{props.ref.line}
      {props.ref.endLine !== undefined ? `-${props.ref.endLine}` : ''}
      {props.ref.col !== undefined ? `:${props.ref.col}` : ''}
      {error !== null ? ' ✗' : ''}
    </button>
  )
}

/**
 * Split one text fragment into plain segments and file-ref chips.
 * @param text - the fragment to split.
 * @param keyBase - stable key prefix for the produced nodes.
 */
function renderRefs(text: string, keyBase: string): ReactNode[] {
  return splitFileRefs(text).map((part, i) => {
    if (typeof part === 'string') return part
    return <FileRefChip key={`${keyBase}-${i}`} ref={part} />
  })
}

/**
 * Recursively replace text leaves with ref-split content, so references render
 * clickable even inside inline code / emphasis / links. Elements without text
 * children (e.g. images) are left untouched.
 */
function withFileRefs(children: ReactNode, keyBase: string): ReactNode[] {
  return Children.toArray(children).flatMap((child, i) => {
    if (typeof child === 'string') return renderRefs(child, `${keyBase}-${i}`)
    if (isValidElement(child)) {
      const el = child as React.ReactElement<{ children?: ReactNode }>
      const kid = el.props.children
      if (kid !== undefined) {
        const kids = Children.toArray(kid)
        if (kids.some((k) => typeof k === 'string')) {
          return cloneElement(el, { children: withFileRefs(kids, `${keyBase}-${i}`) })
        }
      }
    }
    return child
  })
}

/** Assistant markdown block; plain-text fast path while streaming. */
export function MarkdownBlock(props: { text: string; streaming: boolean }): JSX.Element {
  if (props.streaming) {
    // Fast path stays plain text, but refs still render as chips so a jump is
    // clickable before the message settles (long turns stream for a while).
    return <div className="md-plain">{renderRefs(props.text, 's')}</div>
  }
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: (p) => <>{p.children}</>,
          p: (p) => <p>{withFileRefs(p.children, 'p')}</p>,
          code: (p) => {
            // Inline code keeps the default (with ref splitting); fenced blocks
            // are upgraded to the copyable CodeBlock and never split.
            const isBlock = typeof p.className === 'string' || String(p.children ?? '').includes('\n')
            return isBlock ? (
              <CodeBlock className={p.className}>{p.children}</CodeBlock>
            ) : (
              <code className="md-inline-code">{withFileRefs(p.children, 'c')}</code>
            )
          },
          a: (p) => (
            <a href={p.href} target="_blank" rel="noreferrer">
              {p.children}
            </a>
          ),
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  )
}
