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

/** Position/Range/Selection/RevealType shapes for the code-jump opener. */
export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class Selection extends Range {}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

const errorMessages: string[] = []
const warningMessages: string[] = []
/** Documents the code-jump opener opened, in order (absolute fsPaths). */
const openedDocuments: string[] = []
/** Last revealRange call (range + reveal type), for jump assertions. */
let lastRevealCall: { range: Range; type: TextEditorRevealType } | null = null

/** Fake editor returned by showTextDocument for the code-jump opener. */
function fakeEditor(document: { uri: { fsPath: string }; lineCount: number }): unknown {
  return {
    document,
    revealRange: (range: Range, type: TextEditorRevealType): void => {
      lastRevealCall = { range, type }
    },
    selection: undefined as Selection | undefined,
  }
}

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
  showTextDocument: async (document: { uri: { fsPath: string }; lineCount: number }): Promise<unknown> =>
    fakeEditor(document),
}

/** Mirrors the real enum: only Global / Workspace / WorkspaceFolder exist. */
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
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

/**
 * In-memory configuration plane, enough for the real read/write paths the
 * extension uses (`dsh.port`, `dsh.env`): a nested store, `update` writing the
 * Global target, and change events so `onDidChangeConfiguration` subscribers
 * (the extension's live env/port refresh) behave like the real host.
 */
const configurationStore = new Map<string, unknown>()
const configurationListeners = new Set<(event: { affectsConfiguration(section: string): boolean }) => void>()

/** Test control: the stored configuration as a plain object (dotted keys). */
export function configuration(): Record<string, unknown> {
  return Object.fromEntries(configurationStore)
}

/** Test control: seed configuration before the extension reads it. */
export function setConfiguration(key: string, value: unknown): void {
  configurationStore.set(key, value)
}

export const workspace = {
  /** Programmable workspace root (session ownership anchor of the bridge). */
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  getConfiguration: (section: string) => ({
    get: <T>(key: string, fallback?: T): T => {
      const value = configurationStore.get(`${section}.${key}`)
      return value === undefined ? (fallback as T) : (value as T)
    },
    has: (key: string): boolean => configurationStore.has(`${section}.${key}`),
    update: async (key: string, value: unknown): Promise<void> => {
      const full = `${section}.${key}`
      if (value === undefined) configurationStore.delete(full)
      else configurationStore.set(full, value)
      for (const listener of configurationListeners) listener({ affectsConfiguration: (s) => s === full || s === section })
    },
  }),
  onDidChangeConfiguration: (cb: (event: { affectsConfiguration(section: string): boolean }) => void): Disposable => {
    configurationListeners.add(cb)
    return new Disposable(() => configurationListeners.delete(cb))
  },
  openTextDocument: async (
    file: string,
  ): Promise<{ uri: { fsPath: string }; lineCount: number; lineAt(line: number): { text: string } }> => {
    openedDocuments.push(file)
    // A stand-in document: the opener only reads lineCount and the last
    // line's text length to build the reveal range.
    return {
      uri: { fsPath: file },
      lineCount: 1000,
      lineAt: (line: number) => ({ text: `line ${line + 1} placeholder content` }),
    }
  },
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

/** Test control: files the code-jump opener asked to open (absolute paths). */
export function openedFiles(): string[] {
  return [...openedDocuments]
}

/** Test control: the last revealRange call of the code-jump opener. */
export function lastReveal(): { range: Range; type: TextEditorRevealType } | null {
  return lastRevealCall
}
