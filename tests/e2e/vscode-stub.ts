/**
 * Runtime stub for the `vscode` module (E2E only). Bundled in place of the
 * real vscode module via esbuild `alias`, so the REAL extension host code
 * (Bridge / DshClient / HostManager / OverlayRetention) runs under the
 * Playwright harness without the VSCode runtime. Only the surface the
 * bundled code touches is implemented; anything else stays undefined and a
 * touch would throw loudly. Programmatic accessors let tests control the
 * active editor (IDE insertion) and record error notifications.
 */

/** Minimal editor shape the bridge's `handleIdeRequest` reads. */
export interface StubTextEditor {
  document: {
    getText(selection?: unknown): string
    uri: { fsPath: string }
  }
  selection: { isEmpty: boolean }
}

const errorMessages: string[] = []
const warningMessages: string[] = []

export const window = {
  /** Programmable active editor; tests set it to exercise IDE insertion. */
  activeTextEditor: undefined as StubTextEditor | undefined,
  showErrorMessage: (message: string): Promise<void> => {
    errorMessages.push(message)
    return Promise.resolve()
  },
  showWarningMessage: (message: string): Promise<void> => {
    warningMessages.push(message)
    return Promise.resolve()
  },
  createOutputChannel: () => ({ appendLine: (): void => undefined, append: (): void => undefined }),
}

export const workspace = {
  /** Programmable workspace root (session ownership anchor of the bridge). */
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  getConfiguration: () => ({ get: (): undefined => undefined }),
}

export class Disposable {
  static from(...disposables: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => {
      for (const disposable of disposables) disposable.dispose()
    })
  }
  constructor(private readonly onDispose?: () => void) {}
  dispose(): void {
    this.onDispose?.()
  }
}

export const Uri = {
  joinPath: (base: unknown, ...parts: string[]): unknown => ({ base, parts }),
}

/** Test control: point the stub at an editor (or clear it — mirrors the real
 * vscode API, where the active editor is `undefined` when none is open). */
export function setActiveEditor(editor: StubTextEditor | null): void {
  window.activeTextEditor = editor ?? undefined
}

/** Test control: notifications the extension host raised via the stub. */
export function errorNotifications(): string[] {
  return [...errorMessages]
}
