declare module 'vscode' {
  export type Thenable<T> = PromiseLike<T>;

  export interface Disposable {
    dispose(): void;
  }

  export const enum ProgressLocation {
    Window = 10,
    Notification = 15,
  }

  export interface SecretStorage {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
  }

  export interface Uri {
    fsPath: string;
  }

  export namespace Uri {
    function parse(value: string): Uri;
  }

  export interface Position {
    line: number;
    character: number;
  }

  export interface Range {
    start: Position;
    end: Position;
  }

  export interface Selection {
    active: Position;
  }

  export interface TextDocument {
    uri: Uri;
    languageId: string;
    getText(range?: Selection): string;
  }

  export interface DocumentSymbol {
    name: string;
    kind: number;
    range: Range;
    selectionRange: Range;
    children?: DocumentSymbol[];
  }

  export interface TextEditor {
    document: TextDocument;
    selection: Selection;
  }

  export interface OutputChannel {
    appendLine(value: string): void;
    clear(): void;
    show(preserveFocus?: boolean): void;
  }

  export interface ExtensionContext {
    subscriptions: Disposable[];
    secrets: SecretStorage;
  }

  export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue: T): T;
  }

  export interface InputBoxOptions {
    title?: string;
    prompt?: string;
    password?: boolean;
    ignoreFocusOut?: boolean;
    validateInput?(value: string): string | undefined | Thenable<string | undefined>;
  }

  export interface CancellationToken {
    readonly isCancellationRequested: boolean;
  }

  export const enum InlineCompletionTriggerKind {
    Automatic = 0,
    Invoke = 1,
  }

  export interface InlineCompletionContext {
    triggerKind: InlineCompletionTriggerKind;
    selectedCompletionInfo?: SelectedCompletionInfo;
  }

  export interface SelectedCompletionInfo {
    range: Range;
    text: string;
  }

  export interface InlineCompletionItem {
    insertText: string;
    range?: Range;
    filterText?: string;
    command?: Command;
  }

  export interface InlineCompletionList {
    items: InlineCompletionItem[];
  }

  export interface InlineCompletionItemProvider {
    provideInlineCompletionItems(
      document: TextDocument,
      position: Position,
      context: InlineCompletionContext,
      token: CancellationToken,
    ): InlineCompletionList | InlineCompletionItem[] | Thenable<InlineCompletionList | InlineCompletionItem[]>;
  }

  export interface DocumentSelector {
    language?: string;
    scheme?: string;
    pattern?: string;
  }

  export interface Command {
    title: string;
    command: string;
    arguments?: unknown[];
  }

  export namespace commands {
    function registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
    function executeCommand<T>(command: string, ...rest: unknown[]): Thenable<T | undefined>;
  }

  export namespace languages {
    function registerInlineCompletionItemProvider(
      selector: DocumentSelector,
      provider: InlineCompletionItemProvider,
    ): Disposable;
  }

  export namespace window {
    function showInformationMessage(message: string): Thenable<string | undefined>;
    function showInputBox(options: InputBoxOptions): Thenable<string | undefined>;
    function showErrorMessage(message: string): Thenable<string | undefined>;
    function showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function setStatusBarMessage(text: string, hideAfterTimeout?: number): Disposable;
    function withProgress<R>(
      options: { location: ProgressLocation; title?: string; cancellable?: boolean },
      task: () => Thenable<R> | R,
    ): Thenable<R>;
    function createOutputChannel(name: string): OutputChannel;
    const activeTextEditor: TextEditor | undefined;
  }

  export namespace env {
    function openExternal(target: Uri): Thenable<boolean>;
  }
}


declare module 'vscode' {
  export namespace workspace {
    const workspaceFolders: { uri: Uri }[] | undefined;
    function getConfiguration(section?: string): WorkspaceConfiguration;
  }
}
