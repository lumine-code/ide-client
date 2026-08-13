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
export type ServerInstallationStatus = "checking" | "downloading" | "installing" | "failed" | null;
export type DownloadedFileType = "uncompressed" | "gzip" | "gzip-tar" | "zip";
export interface GithubRelease {
  version: string;
  tag: string;
  assets: Array<{ name: string; url: string; size: number }>;
}
/**
 * The capabilities an adapter uses to fetch its own server. Named after
 * `zed_extension_api`, and handed to `installServer` rather than imported.
 *
 * `downloadFile` cannot verify a checksum for you — an adapter using it owns
 * that, unlike the descriptor path where verification is mandatory.
 */
export interface InstallApi {
  latestGithubRelease(
    repository: string,
    options?: { preRelease?: boolean },
  ): Promise<GithubRelease>;
  githubReleaseByTag(repository: string, tag: string): Promise<GithubRelease>;
  npmPackageLatestVersion(name: string): Promise<string>;
  npmPackageInstalledVersion(name: string, directory: string): string | null;
  npmInstallPackage(name: string, version: string, directory: string): Promise<void>;
  downloadFile(
    url: string,
    destination: string,
    options?: { type?: DownloadedFileType },
  ): Promise<string>;
  makeFileExecutable(path: string): Promise<void>;
  setServerInstallationStatus(status: ServerInstallationStatus): void;
}
export interface ServerInstallContext {
  /** The staging directory to fill; it becomes the install directory. */
  storagePath: string;
  version: string | null;
  api: InstallApi;
  adapter: LanguageServerAdapter;
}
export interface AdapterInstallResult {
  version?: string;
  /** Executable to launch, relative to the install directory. */
  binary?: string;
  /** Entry module to launch, relative to the install directory. */
  module?: string;
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
      /** Whether the release asset is extracted or installed as the executable itself. */
      assetType?: "archive" | "binary";
      /** Base name of the installed executable; located inside an archive when applicable. */
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
  /**
   * Fetch the server yourself, for a shape no descriptor models — several
   * binaries, an unusual release layout. Mutually exclusive with
   * `managedServer`; declaring both is rejected at registration. Fill
   * `storagePath` and return where to launch from; the hub stages, swaps,
   * records and reports around you exactly as it does for a descriptor.
   */
  installServer?(context: ServerInstallContext): Promise<AdapterInstallResult>;
  /** The version the list should compare against, when you fetch your own. */
  latestServerVersion?(api: InstallApi): Promise<string | null>;
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
  /** Every running session serving that editor, in adapter registration order. */
  activeSessionsForEditor(editor: TextEditor): Promise<LanguageServerSession[]>;
  /**
   * The first running session that serves `method`, honouring dynamic
   * registrations and the adapter's feature switches. Prefer this over
   * `sessionForEditor` whenever more than one server can serve a grammar.
   */
  activeSessionForFeature(
    editor: TextEditor,
    method: string,
    feature?: LanguageServerFeature,
  ): Promise<LanguageServerSession | null>;
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
  /**
   * Sends a request through the FIRST session serving that editor, with no
   * capability check. Where several servers can serve a grammar, pick one with
   * `activeSessionForFeature` and call its own `request()` instead — a request
   * carrying an opaque `data` from an earlier reply is only meaningful to the
   * server that produced it.
   */
  request(
    editor: TextEditor,
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<any> | undefined;
  restart(session: LanguageServerSession): Promise<LanguageServerSession>;
  stop(session: LanguageServerSession): Promise<void>;
  getLog(adapterId: string): string;
  /**
   * Report, once per window, that this adapter could not find its server.
   * Silent when the package's own `notifyWhenMissing` setting is `false`, which
   * is what the notification's Never Ask Again button writes.
   */
  reportMissingServer(adapterId: string, options?: { description?: string }): object | null;
  /** Fetch and install this adapter's server; reports progress and failure itself. */
  installServer(adapterId: string, options?: { version?: string }): Promise<object>;
  /** Install the newest release, or resolve unchanged when already current. */
  updateServer(adapterId: string): Promise<object>;
  /** Remove only the managed copy; a PATH or bundled server is left alone. */
  uninstallServer(adapterId: string): Promise<void>;
  managedServer(adapterId: string): ManagedServerInstall | null;
  /** What is happening to that adapter's server right now, or null. */
  serverInstallationStatus(adapterId: string): ServerInstallationStatus;
  onDidChangeServerInstallation(
    fn: (event: { adapterId: string; status: ServerInstallationStatus }) => void,
  ): Disposable;
  applyWorkspaceEdit(edit: object, label?: string): Promise<boolean>;
  /**
   * Opens a notebook for language servers: each capable session receives LSP
   * notebook sync, the cell editors route through every provider, and cell
   * diagnostics land against the notebook path with 1-based cell numbers.
   * Resolves to null for a notebook without a path — open again on first save.
   * The bridge is path-immutable: dispose and reopen on a save-as.
   */
  openNotebookDocument(descriptor: NotebookDocumentDescriptor): NotebookBridge | null;
  /**
   * The adapters serving an open notebook, for a consumer deciding whether to
   * stand down. Empty when no bridge is open for the path. Sticky across a
   * server restart for the bridge's lifetime.
   */
  adaptersForNotebook(filePath: string): LanguageServerAdapter[];
  /** The `vscode-notebook-cell:` URI for a cell of a notebook. */
  cellUri(notebookPath: string, cellId: string): string;
  parseCellUri(uri: string): { notebookPath: string; cellId: string } | null;
  openNotebook(session: LanguageServerSession, notebook: object, cells?: object[]): void;
  changeNotebook(session: LanguageServerSession, notebook: object, change: object): void;
  saveNotebook(session: LanguageServerSession, notebook: object): void;
  closeNotebook(session: LanguageServerSession, notebook: object, cells?: object[]): void;
}
export interface NotebookCellDescriptor {
  /** Stable unique id; also the cell URI's fragment. */
  id: string;
  kind: "code" | "markup";
  /**
   * The live editors showing this cell, one per split view; the first drives
   * content sync and receives workspace edits. May be absent while a view is
   * still building — pass the cell again through `updateCells` when it lands.
   */
  editors?: TextEditor[];
  /** Single-editor shorthand for `editors`. */
  editor?: TextEditor;
  /** Grammar scope resolving the cell's LSP language id. */
  scopeName?: string;
  /** Fallback text for a cell whose editor has not been built yet. */
  text?: string;
}
export interface NotebookDocumentDescriptor {
  filePath: string;
  /** Defaults to "jupyter-notebook". */
  notebookType?: string;
  /** The notebook's FULL ordered cell list, markup cells included. */
  cells?: NotebookCellDescriptor[];
  metadata?: object;
  /** Reveals a cell for server-initiated navigation; range is cell-relative. */
  show?(target: { cellId: string; range?: [number, number][]; takeFocus?: boolean }): void;
}
export interface NotebookBridge {
  notebookUri: string;
  uriForCell(cellId: string): string;
  /** Resolves when the initial attach pass has finished. */
  attached: Promise<void>;
  /** Reconcile to a new full ordered cell list; deltas are computed here. */
  updateCells(cells: NotebookCellDescriptor[]): Promise<void> | void;
  /** Forwarded only to servers whose sync options declared save support. */
  didSave(): void;
  dispose(): void;
}
