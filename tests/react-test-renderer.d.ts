declare module 'react-test-renderer' {
  interface TestProps {
    readonly value?: string
    readonly disabled?: boolean
    readonly onClick: (...args: never[]) => unknown
    readonly onChange: (event: unknown) => unknown
    readonly onKeyDown: (event: unknown) => unknown
  }

  interface ReactTestInstance {
    readonly props: TestProps
    findByProps(props: Record<string, unknown>): ReactTestInstance
  }

  interface ReactTestRenderer {
    readonly root: ReactTestInstance
    unmount(): void
  }

  export function create(element: import('react').ReactElement): ReactTestRenderer
  export function act(callback: () => void | Promise<void>): Promise<void>
}
