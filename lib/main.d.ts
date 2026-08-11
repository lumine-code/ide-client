import type { Disposable, TextEditor } from "lumine";

export type ServerTransport = "stdio" | "ipc" | "socket";
export interface ServerLaunch {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  transport?: ServerTransport;
  host?: string;
  port?: number;
  version?: string;
  /** Absolute directory for a file-based vscode-jsonrpc cancellation channel. */
  fileCancellationFolder?: string;
}
export interface ServerResolutionContext {
  rootPath: string;
  projectPaths: string[];
  configDirPath: string;
  managedStoragePath: string;
  /** The copy the editor installed for this adapter, or null when there is none. */
  managedServer: ManagedServerInstall | null;
}
export interface ManagedServerInstall {
  version: string;
  source: "github-release" | "npm";
  installedAt: string;
  directory: string;
  /** Absolute path of the executable, for a github-release source. */
  binaryPath: string | null;
  /** Absolute path of the entry module, for an npm source. */
  modulePath: string | null;
}
/**
 * Where an adapter's server can be fetched from, so the editor can install,
 * update and remove it. Optional: an adapter without one is never offered in
 * the Manage Servers list.
 */
export type ManagedServerDescriptor =
  | {
      source: "github-release";
      /** Shown wherever the server is named; defaults to the adapter's displayName. */
      displayName?: string;
      /** `owner/name` of the GitHub repository publishing the releases. */
      repository: string;
      /** Exact asset file name for this platform, or null when none is published. */
      assetFor(context: { platform: string; arch: string; version: string }): string | null;
      /** Stated, never inferred — `none` records a source that publishes no checksums. */
      checksum: "sha256-sidecar" | "none";
      /** Base name of the executable inside the archive; located wherever it sits. */
      binary: string;
      /** Leading path components to drop while extracting. Defaults to 0. */
      strip?: number;
    }
  | {
      source: "npm";
      displayName?: string;
      /** Registry packages to extract side by side; the first decides the version. */
      packages: string[];
      /** Entry module, relative to the install directory. */
      module: string;
      /** True when the adapter package also ships the server, so uninstall falls back. */
      bundled?: boolean;
    };
export interface DocumentTextContext {
  editor: TextEditor;
  uri: string;
}
/** A capability an adapter can switch off for its own server. */
export type LanguageServerFeature =
  | "diagnostics"
  | "autocomplete"
  | "hover"
  | "signature"
  | "definition"
  | "references"
  | "callHierarchy"
  | "typeHierarchy"
  | "symbols"
  | "outline"
  | "format"
  | "rename"
  | "codeActions"
  | "inlayHints"
  | "codeLens"
  | "semanticTokens";
export interface LanguageServerAdapter {
  id: string;
  displayName: string;
  /** Blanket LSP languageId fallback; prefer languageIdForScope or the built-in scope table. */
  languageId?: string;
  /** Per-grammar languageId override, consulted before the built-in scope table. */
  languageIdForScope?(scopeName: string): string | undefined;
  grammarScopes: string[];
  documentSelector?: Array<{ language?: string; scheme?: string; pattern?: string }>;
  sessionScope?: "project-root" | "workspace";
  resolveServer(context: ServerResolutionContext): Promise<ServerLaunch | null>;
  /** Opt in to the editor installing, updating and removing this server. */
  managedServer?: ManagedServerDescriptor;
  getInitializationOptions?(context: {
    rootPath: string;
    rootUri: string;
  }): unknown | Promise<unknown>;
  /** Settings pushed via workspace/didChangeConfiguration after initialize. */
  getSettings?(): unknown | Promise<unknown>;
  /** Config key paths whose changes re-push getSettings() to running sessions. */
  settingsKeyPaths?: string[];
  getWorkspaceConfiguration?(section?: string, resource?: string): unknown;
  /** Handle a server-specific JSON-RPC request not implemented by the LSP core. */
  handleServerRequest?(
    method: string,
    params: unknown,
    context: { session: LanguageServerSession },
  ): unknown | Promise<unknown>;
  /** Observe a server-specific notification while it is also emitted by the session. */
  handleServerNotification?(
    method: string,
    params: unknown,
    context: { session: LanguageServerSession },
  ): void | Promise<void>;
  /**
   * Fallback feature switches, for an adapter with no config namespace to hold
   * them. A package declares them under `features` in its `package.json`
   * instead, where the user can change them; those win over these.
   */
  features?: Partial<Record<LanguageServerFeature, boolean>>;
  /** Reversibly adapt editor text before synchronizing it to the server. */
  transformDocumentText?(text: string, context: DocumentTextContext): string;
  /** Restore transformed text in formatting and workspace edits from the server. */
  restoreDocumentText?(text: string, context: DocumentTextContext): string;
  transformServerCapabilities?(capabilities: Record<string, unknown>): Record<string, unknown>;
}
export interface RequestOptions {
  /** Aborting settles the request locally, whatever the server does next. */
  signal?: AbortSignal;
  /**
   * Send `$/cancelRequest` when the signal aborts. Defaults to `true`; pass
   * `false` to abandon the request without telling the server about it.
   */
  cancelOnServer?: boolean;
}
export interface LanguageServerSession {
  adapter: LanguageServerAdapter;
  rootPath: string;
  state: "starting" | "running" | "failed" | "stopping" | "stopped";
  capabilities: Record<string, any>;
  /**
   * True when the session serves the request method for the editor, honoring
   * dynamic registrations and the adapter's feature switches. `feature` names
   * the switch for the requests that serve more than one consumer; it is
   * derived from the method otherwise.
   */
  supports(method: string, editor?: TextEditor, feature?: LanguageServerFeature): boolean;
  request(method: string, params?: unknown, options?: RequestOptions): Promise<any>;
  notify(method: string, params?: unknown): void;
}
export interface LanguageServerService {
  registerAdapter(adapter: LanguageServerAdapter): Disposable;
  sessionForEditor(editor: TextEditor): LanguageServerSession | null;
  /** Resolves once the session finished starting; null when absent, failed, or not running. */
  activeSessionForEditor(editor: TextEditor): Promise<LanguageServerSession | null>;
  getSessions(): LanguageServerSession[];
  onDidChangeSession(
    callback: (event: { session: LanguageServerSession; state: string; error?: Error }) => void,
  ): Disposable;
  onDidPublishDiagnostics(callback: (event: object) => void): Disposable;
  /** Fires when one of an adapter's feature switches changes. */
  onDidChangeFeatures(callback: (event: { adapter: LanguageServerAdapter }) => void): Disposable;
  /** Whether `feature` is switched on for that adapter, in that editor's scope. */
  featureEnabled(
    adapter: LanguageServerAdapter,
    feature: LanguageServerFeature,
    editor?: TextEditor,
  ): boolean;
  request(
    editor: TextEditor,
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<any> | undefined;
  restart(session: LanguageServerSession): Promise<LanguageServerSession>;
  stop(session: LanguageServerSession): Promise<void>;
  getLog(adapterId: string): string;
  /** Fetch and install this adapter's server; reports progress and failure itself. */
  installServer(adapterId: string, options?: { version?: string }): Promise<object>;
  /** Install the newest release, or resolve unchanged when already current. */
  updateServer(adapterId: string): Promise<object>;
  /** Remove only the managed copy; a PATH or bundled server is left alone. */
  uninstallServer(adapterId: string): Promise<void>;
  managedServer(adapterId: string): ManagedServerInstall | null;
  applyWorkspaceEdit(edit: object, label?: string): Promise<boolean>;
  openNotebook(session: LanguageServerSession, notebook: object, cells?: object[]): void;
  changeNotebook(session: LanguageServerSession, notebook: object, change: object): void;
  saveNotebook(session: LanguageServerSession, notebook: object): void;
  closeNotebook(session: LanguageServerSession, notebook: object, cells?: object[]): void;
}
