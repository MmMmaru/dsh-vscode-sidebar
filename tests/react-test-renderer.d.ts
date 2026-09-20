declare module 'react-test-renderer' {
  interface TestProps {
    readonly value?: string
    readonly type?: string
    readonly placeholder?: string
    readonly title?: string
    readonly disabled?: boolean
    readonly className?: string
    readonly style?: Record<string, unknown>
    readonly onClick: (...args: never[]) => unknown
    readonly onChange: (event: unknown) => unknown
    readonly onKeyDown: (event: unknown) => unknown
    readonly children?: unknown
  }

  interface ReactTestInstance {
    readonly props: TestProps
    findByProps(props: Record<string, unknown>): ReactTestInstance
    findAllByProps(props: Record<string, unknown>): ReactTestInstance[]
    findAllByType(type: unknown): ReactTestInstance[]
  }

  interface ReactTestRenderer {
    readonly root: ReactTestInstance
    toJSON(): unknown
    unmount(): void
  }

  export function create(element: import('react').ReactElement): ReactTestRenderer
  export function act(callback: () => void | Promise<void>): Promise<void>
}
