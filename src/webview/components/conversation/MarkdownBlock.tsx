/**
 * MarkdownBlock (W3): assistant text rendering with two-phase behavior —
 * while `streaming` is true the text renders as plain pre-wrapped text (code
 * fences and math stay unparsed, matching the dsh web client's incremental
 * strategy); once settled it renders full GitHub-flavored Markdown with
 * copyable code blocks.
 */

import { useState, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

/** Assistant markdown block; plain-text fast path while streaming. */
export function MarkdownBlock(props: { text: string; streaming: boolean }): JSX.Element {
  if (props.streaming) {
    return <div className="md-plain">{props.text}</div>
  }
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: (p) => <>{p.children}</>,
          code: (p) => {
            // Inline code keeps the default; fenced blocks are upgraded.
            const isBlock = typeof p.className === 'string' || String(p.children ?? '').includes('\n')
            return isBlock ? (
              <CodeBlock className={p.className}>{p.children}</CodeBlock>
            ) : (
              <code className="md-inline-code">{p.children}</code>
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
