const ChildProcess = require("child_process");
const net = require("net");
const { Emitter, CompositeDisposable } = require("lumine");
const RpcConnection = require("./rpc-connection");
const C = require("./converters");
const { STATIC_CAPABILITIES } = require("./capabilities");
const { languageIdForEditor } = require("./language-ids");
const { METHOD_FEATURES, featureEnabled } = require("./features");

// How long a server gets to exit on its own after `exit` before it is killed.
const EXIT_GRACE_MS = 1000;

// How long a server gets to answer `shutdown` before it is told to leave
// anyway. The reply is a courtesy — it means "I have stopped working", and
// `exit` follows regardless — but the request is a promise like any other, and
// a server that accepts it and never answers would hold this open with nothing
// to time it out. `stop()` runs on the unload path, where that would have meant
// a window that never reloads.
const SHUTDOWN_TIMEOUT_MS = 2000;

// Pull-diagnostic servers are asked after a short quiet period while typing.
// Opening a document and an explicit server refresh remain immediate.
const DIAGNOSTIC_DEBOUNCE_MS = 200;

// Rejects if `promise` has not settled within `ms`. The timer is cleared either
// way: a pending one keeps the process alive, and every caller here is on a
// path that is trying to let something go.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Methods an aborted request abandons quietly, without `$/cancelRequest`.
// `$/cancelRequest` is advisory, and for these two it buys nothing: a server
// supersedes find-all-references on its own as soon as the replacement lands,
// and a command is a mutation that nobody gains from stopping half way.
//
// It also costs. Pyright answers both by first awaiting
// `window/workDoneProgress/create`; a cancellation arriving during that round
// trip leaves its `CancelAfter` holding a cancellation source it never read the
// token of, and the handler's next call to `cancel()` throws
// `this._token.cancel is not a function` — for every later request of that
// method, until the server is restarted. The policy lives here rather than at
// the call sites because every request but `initialize` and `shutdown` passes
// through, including the `request` this package hands to other packages.
const ABANDON_QUIETLY = new Set(["textDocument/references", "workspace/executeCommand"]);

module.exports = class ServerSession {
  constructor(manager, adapter, rootPath, launch) {
    this.manager = manager;
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.launch = launch;
    // Every project folder this session answers for. More than one only when
    // the server declared multi-root support and adopted the rest.
    this.folders = new Set([rootPath]);
    this.documents = new Map();
    this.progressTitles = new Map();
    this.diagnosticTimers = new Map();
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.state = "starting";
    this.capabilities = {};
    // How often this server has been restarted, and how many of those restarts
    // came one after another without it ever staying up in between. A restart
    // builds a new session, so the manager carries both onto the replacement —
    // see `LanguageServerManager#scheduleRestart`, which is what keeps a server
    // that dies on every start from being restarted for ever.
    this.restartCount = 0;
    this.failureCount = 0;
    // When the handshake finished, or null while it has not. A server that
    // never reached `running` has proved nothing about its own health, and one
    // that stayed up for a while has: that is the difference between a crash
    // loop and a server that had a bad afternoon.
    this.runningSince = null;
  }
  onDidChangeState(fn) {
    return this.emitter.on("did-change-state", fn);
  }
  // Notifications this client registers no handler of its own for. The ones it
  // does handle reach their consumers through the manager instead.
  onNotification(fn) {
    return this.emitter.on("notification", fn);
  }
  setState(state, error) {
    if (state === "running") this.runningSince = Date.now();
    this.state = state;
    this.emitter.emit("did-change-state", { session: this, state, error });
    this.manager.didChangeSession(this, error);
  }
  // Everything the connection has to say about itself — traffic traces, write
  // failures, handler faults — lands in this server's log buffer.
  logger() {
    const log = (message) => this.manager.log(this, message);
    return { error: log, warn: log, info: log, log };
  }
  applyTrace() {
    this.connection?.setTrace(lumine.config.get("ide-client.trace"));
  }
  async start() {
    const { command, args = [], cwd = this.rootPath, env = {}, transport = "stdio" } = this.launch;
    if (!command) throw new Error(`Adapter ${this.adapter.id} returned no server command`);
    const options = { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false };
    const rpc = {
      logger: this.logger(),
      fileCancellationFolder: this.launch.fileCancellationFolder,
    };
    if (transport === "ipc") {
      this.process = ChildProcess.fork(command, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      this.connection = RpcConnection.ipc(this.process, rpc);
    } else if (transport === "socket") {
      this.process = ChildProcess.spawn(command, args, options);
      const socket = net.connect({ host: this.launch.host || "127.0.0.1", port: this.launch.port });
      await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
      this.connection = RpcConnection.socket(socket, rpc);
    } else {
      this.process = ChildProcess.spawn(command, args, {
        ...options,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.connection = RpcConnection.stdio(this.process, rpc);
    }
    this.process.stderr?.on("data", (chunk) => this.manager.log(this, chunk.toString()));
    this.process.once("exit", (code, signal) => this.onExit(code, signal));
    this.installClientHandlers();
    this.applyTrace();
    this.connection.listen();
    const rootUri = C.pathToUri(this.rootPath);
    const result = await this.connection.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "Lumine", version: lumine.application.getVersion() },
      locale: navigator.language,
      rootUri,
      workspaceFolders: this.manager.workspaceFolders(),
      capabilities: this.manager.buildClientCapabilities(),
      initializationOptions: await this.adapter.getInitializationOptions?.({
        rootPath: this.rootPath,
        rootUri,
      }),
    });
    this.capabilities =
      this.adapter.transformServerCapabilities?.(result.capabilities) || result.capabilities || {};
    const encoding = this.capabilities.positionEncoding;
    if (encoding && encoding !== "utf-16")
      throw new Error(
        `${this.adapter.displayName} chose unsupported position encoding '${encoding}'`,
      );
    this.serverInfo = result.serverInfo;
    this.connection.notify("initialized", {});
    await this.pushSettings();
    this.setState("running");
  }
  async pushSettings() {
    const settings =
      (await this.adapter.getSettings?.()) ??
      (await this.adapter.getWorkspaceConfiguration?.(undefined)) ??
      {};
    if (!this.connection) return;
    this.connection.notify("workspace/didChangeConfiguration", { settings });
    if (this.state === "running") this.refreshDiagnostics();
  }
  transformDocumentText(text, editor, uri) {
    return this.adapter.transformDocumentText?.(text, { editor, uri }) ?? text;
  }
  restoreDocumentText(text, editor, uri) {
    return this.adapter.restoreDocumentText?.(text, { editor, uri }) ?? text;
  }
  // A document is only open while an editor holds it, so a report that outlives
  // one — or names a related document nobody opened — passes the editor as
  // undefined rather than skipping the hook.
  transformDiagnostics(diagnostics, uri, document) {
    return (
      this.adapter.transformDiagnostics?.(diagnostics, {
        editor: document?.editor,
        uri,
        session: this,
      }) ?? diagnostics
    );
  }
  // True when the session can serve the given request method for the editor.
  // A feature its adapter has switched off is refused before the capability is
  // consulted, so a disabled server is never asked. `feature` names it
  // explicitly for the requests that serve more than one — see METHOD_FEATURES.
  // Dynamic registrations take precedence over the static server capability.
  supports(method, editor, feature = METHOD_FEATURES[method]) {
    if (!featureEnabled(this.adapter, feature, editor)) return false;
    const dynamic = this.manager.dynamicSupport(this, method, editor);
    if (dynamic !== undefined) return dynamic;
    const field = STATIC_CAPABILITIES[method];
    return field ? !!this.capabilities[field] : true;
  }
  // The options a capability was declared with — a semantic-token legend, the
  // characters that trigger completion or signature help, whether a rename can
  // be prepared. `supports()` answers whether a method is served; this answers
  // how, and has to look in the same two places.
  //
  // A server that registers dynamically declares nothing statically, so reading
  // `capabilities` alone finds an empty object: Tinymist registers its semantic
  // tokens that way, and the legend was missed entirely, which left the feature
  // silently doing nothing for it.
  capabilityOptions(method, editor) {
    const dynamic = this.manager.dynamicOptions(this, method, editor);
    if (dynamic) return dynamic;
    const field = STATIC_CAPABILITIES[method];
    const declared = field ? this.capabilities[field] : undefined;
    // `true` is a valid way to say "served, with no options to speak of".
    return declared && typeof declared === "object" ? declared : undefined;
  }
  installClientHandlers() {
    this.connection.onError((error) => this.manager.log(this, error.stack || error.message));
    this.connection.onOtherNotification((method, params) => {
      try {
        const handled = this.adapter.handleServerNotification?.(method, params, { session: this });
        handled?.catch?.((error) => this.manager.log(this, error.stack || error.message));
      } catch (error) {
        this.manager.log(this, error.stack || error.message);
      }
      this.emitter.emit("notification", { session: this, method, params });
    });
    this.connection.onNotification("textDocument/publishDiagnostics", (params) =>
      this.manager.publishDiagnostics(this, params),
    );
    this.connection.onNotification("window/logMessage", ({ message }) =>
      this.manager.log(this, message),
    );
    this.connection.onNotification("window/showMessage", ({ type, message }) =>
      this.manager.showMessage(type, message, this),
    );
    this.connection.onNotification("$/progress", (params) =>
      this.manager.handleProgress(this, params),
    );
    this.connection.onRequest("workspace/configuration", (params) =>
      Promise.all(
        params.items.map(
          (item) =>
            this.adapter.getWorkspaceConfiguration?.(item.section, item.scopeUri) ??
            lumine.config.get(item.section),
        ),
      ),
    );
    this.connection.onRequest("workspace/applyEdit", async ({ edit, label }) => ({
      applied: await this.manager.applyWorkspaceEdit(edit, label, this),
    }));
    this.connection.onRequest("workspace/workspaceFolders", () => this.manager.workspaceFolders());
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("client/registerCapability", (params) => {
      this.manager.registerCapabilities(this, params.registrations);
      return null;
    });
    this.connection.onRequest("client/unregisterCapability", (params) => {
      this.manager.unregisterCapabilities(this, params.unregisterations || params.unregistrations);
      return null;
    });
    this.connection.onRequest("window/showMessageRequest", ({ type, message, actions = [] }) =>
      this.manager.showMessageRequest(type, message, actions, this),
    );
    this.connection.onRequest("window/showDocument", (params) => this.manager.showDocument(params));
    // Server-initiated refresh requests: acknowledge with null and let the
    // manager route them to the feature modules that hold the stale data.
    for (const [method, kind] of [
      ["workspace/codeLens/refresh", "codeLens"],
      ["workspace/semanticTokens/refresh", "semanticTokens"],
      ["workspace/inlayHint/refresh", "inlayHint"],
    ]) {
      this.connection.onRequest(method, () => {
        this.manager.requestRefresh(this, kind);
        return null;
      });
    }
    this.connection.onRequest("workspace/diagnostic/refresh", () => {
      this.refreshDiagnostics();
      return null;
    });
    if (this.adapter.handleServerRequest) {
      this.connection.onOtherRequest((method, params) =>
        this.adapter.handleServerRequest(method, params, { session: this }),
      );
    }
  }
  // Keyed by `uriKey` so a server's own spelling of the same file finds this
  // entry; `document.uri` keeps the spelling this client sends on the wire.
  async openEditor(editor) {
    // A cell editor is synced through the notebookDocument notifications; a
    // misrouted call here would double-open it as a plain text document.
    if (this.manager.externalDocuments?.has(editor)) return;
    const uri = C.pathToUri(editor.getPath());
    if (this.documents.has(C.uriKey(uri))) return;
    const document = { editor, uri, version: 1, subscriptions: new CompositeDisposable() };
    this.documents.set(C.uriKey(uri), document);
    this.connection.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageIdForEditor(this.adapter, editor),
        version: 1,
        text: this.transformDocumentText(editor.getText(), editor, uri),
      },
    });
    this.scheduleDiagnostics(document, 0);
    document.subscriptions.add(
      editor.getBuffer().onDidChangeText((event) => this.changeDocument(document, event)),
    );
    document.subscriptions.add(
      editor.onDidSave(() =>
        this.connection.notify("textDocument/didSave", {
          textDocument: { uri },
          text: this.transformDocumentText(editor.getText(), editor, uri),
        }),
      ),
    );
    document.subscriptions.add(editor.onDidDestroy(() => this.closeDocument(uri)));
  }
  changeDocument(document, event) {
    const sync =
      typeof this.capabilities.textDocumentSync === "number"
        ? this.capabilities.textDocumentSync
        : this.capabilities.textDocumentSync?.change;
    const contentChanges =
      sync === 1 || this.adapter.transformDocumentText
        ? [
            {
              text: this.transformDocumentText(
                document.editor.getText(),
                document.editor,
                document.uri,
              ),
            },
          ]
        : // TextBuffer reports every oldRange against the document before the
          // transaction, while LSP applies contentChanges sequentially. Sending
          // the highest change first keeps edits below it from shifting its
          // range. This is especially important for multi-hunk reloads after an
          // external tool rewrites a file.
          event.changes.toReversed().map((change) => ({
            range: C.rangeToLsp(change.oldRange),
            rangeLength: change.oldText?.length,
            text: change.newText,
          }));
    this.connection.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: ++document.version },
      contentChanges,
    });
    this.scheduleDiagnostics(document);
  }

  scheduleDiagnostics(document, delay = DIAGNOSTIC_DEBOUNCE_MS) {
    const key = C.uriKey(document.uri);
    // Notebook cells are never pulled: their diagnostics ride the notebook
    // push channel, and a server can answer a cell pull with an empty full
    // report that contradicts its own pushes — ruff does, wiping the cell's
    // messages the moment typing pauses.
    if (document.notebook || !this.supports("textDocument/diagnostic", document.editor)) {
      clearTimeout(this.diagnosticTimers.get(key));
      this.diagnosticTimers.delete(key);
      return;
    }
    clearTimeout(this.diagnosticTimers.get(key));
    this.diagnosticTimers.set(
      key,
      setTimeout(() => {
        this.diagnosticTimers.delete(key);
        this.pullDiagnostics(document);
      }, delay),
    );
  }

  refreshDiagnostics() {
    for (const document of this.documents.values()) this.scheduleDiagnostics(document, 0);
  }

  publishDiagnosticReport(uri, report, version) {
    if (!report || report.kind === "unchanged") return;
    this.manager.publishDiagnostics(this, {
      uri,
      version,
      diagnostics: Array.isArray(report.items) ? report.items : [],
    });
  }

  async pullDiagnostics(document) {
    if (
      this.state !== "running" ||
      document.notebook ||
      !this.documents.has(C.uriKey(document.uri)) ||
      !this.supports("textDocument/diagnostic", document.editor)
    )
      return;
    const version = document.version;
    const provider = this.capabilities.diagnosticProvider;
    const params = { textDocument: { uri: document.uri } };
    if (provider && typeof provider === "object" && provider.identifier)
      params.identifier = provider.identifier;
    if (document.diagnosticResultId) params.previousResultId = document.diagnosticResultId;
    try {
      const report = await this.request("textDocument/diagnostic", params);
      const current = this.documents.get(C.uriKey(document.uri));
      if (current !== document || current.version !== version) return;
      if (report?.resultId) document.diagnosticResultId = report.resultId;
      this.publishDiagnosticReport(document.uri, report, version);
      for (const [uri, related] of Object.entries(report?.relatedDocuments || {}))
        this.publishDiagnosticReport(uri, related);
    } catch (error) {
      if (this.state === "running")
        this.manager.log(this, `Unable to pull diagnostics: ${error.message}`);
    }
  }
  detachEditor(editor) {
    // Notebook cell documents are owned by the notebook module; routing one
    // through closeDocument would emit a protocol-violating textDocument/didClose.
    for (const document of [...this.documents.values()])
      if (document.editor === editor && !document.notebook) this.closeDocument(document.uri);
  }
  closeDocument(uri) {
    const doc = this.documents.get(C.uriKey(uri));
    if (!doc) return;
    doc.subscriptions.dispose();
    const key = C.uriKey(doc.uri);
    clearTimeout(this.diagnosticTimers.get(key));
    this.diagnosticTimers.delete(key);
    if (this.capabilities.diagnosticProvider)
      this.manager.publishDiagnostics(this, {
        uri: doc.uri,
        version: doc.version,
        diagnostics: [],
      });
    this.documents.delete(C.uriKey(uri));
    // Closed under the spelling it was opened with, whoever asked for it.
    this.connection.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
    if (!this.documents.size) this.manager.didCloseDocument(this);
  }
  // An explicit `cancelOnServer` still wins, for a caller that knows better.
  request(method, params, options) {
    if (this.state !== "running")
      return Promise.reject(new Error("Language server is not running"));
    return this.connection.request(method, params, {
      cancelOnServer: !ABANDON_QUIETLY.has(method),
      ...options,
    });
  }
  notify(method, params) {
    if (this.state === "running") this.connection.notify(method, params);
  }
  openNotebook(notebookDocument, cellTextDocuments = []) {
    this.notify("notebookDocument/didOpen", { notebookDocument, cellTextDocuments });
  }
  changeNotebook(notebookDocument, change) {
    this.notify("notebookDocument/didChange", { notebookDocument, change });
  }
  saveNotebook(notebookDocument) {
    this.notify("notebookDocument/didSave", { notebookDocument });
  }
  closeNotebook(notebookDocument, cellTextDocuments = []) {
    this.notify("notebookDocument/didClose", { notebookDocument, cellTextDocuments });
  }
  // A notebook cell participates in this session as a document — keeping the
  // session alive through the idle check — but its content flows through the
  // notebookDocument notifications, so nothing here sends textDocument/didOpen
  // for it, and its diagnostics ride the notebook push channel rather than
  // pulls. The version is a getter into the notebook module's counter: the
  // staleness guard in publishDiagnostics compares against the version the
  // module stamped on the wire.
  adoptNotebookCell({ record, cellId, editor, uri }) {
    const key = C.uriKey(uri);
    const existing = this.documents.get(key);
    if (existing) {
      // Adopted before etch built the cell's editor; the arrival still counts.
      if (existing.notebook === record && editor) existing.editor = editor;
      return;
    }
    const document = {
      editor,
      uri,
      notebook: record,
      subscriptions: new CompositeDisposable(),
      get version() {
        return record.cellVersion(cellId);
      },
    };
    this.documents.set(key, document);
  }
  releaseNotebookCell(uri) {
    const key = C.uriKey(uri);
    const document = this.documents.get(key);
    if (!document?.notebook) return;
    document.subscriptions.dispose();
    clearTimeout(this.diagnosticTimers.get(key));
    this.diagnosticTimers.delete(key);
    // Unconditionally, unlike closeDocument's pull-only clear: a push server
    // never clears a closing cell on its own, and a stale diagnostic against a
    // cell that no longer exists has no editor left to correct it.
    this.manager.publishDiagnostics(this, { uri: document.uri, diagnostics: [] });
    this.documents.delete(key);
    if (!this.documents.size) this.manager.didCloseDocument(this);
  }
  onExit(code, signal) {
    this.manager.clearProgress(this);
    if (this.state === "stopping" || this.state === "stopped") return;
    this.connection?.dispose();
    this.setState("failed", new Error(`Server exited (${code ?? signal})`));
    this.manager.scheduleRestart(this);
  }
  // `exit` asks the server to leave on its own. Killing it in the same tick
  // breaks its stdin before it has read the frame, so wait for it to go and
  // only insist once it is clear it will not.
  awaitExit() {
    const child = this.process;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    child.stdin?.end();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, EXIT_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  // Immediate teardown for a window that is already going, where `stop()` is no
  // use: its `shutdown`/`exit` round trip cannot finish while the environment is
  // being taken apart. Every orderly unload reaches `deactivate` and stops its
  // servers properly, so this is the net under the ones that do not — a renderer
  // that crashed and is being reloaded. A server that does not die with its
  // stdin would otherwise be orphaned, one more for every such reload, so the
  // process is killed outright instead of asked to leave. Synchronous on
  // purpose: nothing awaits a `will-destroy` handler.
  kill() {
    if (this.state === "stopped") return;
    // Assigned rather than `setState`: that reports the change onward, and the
    // views it would repaint are being torn down in the same breath.
    this.state = "stopped";
    for (const timer of this.diagnosticTimers.values()) clearTimeout(timer);
    this.diagnosticTimers.clear();
    try {
      this.connection?.dispose();
    } catch {
      /* The connection is going down with the window either way. */
    }
    this.process?.kill();
  }
  async stop() {
    if (this.state === "stopped") return;
    const wasRunning = this.state === "running";
    this.setState("stopping");
    try {
      if (wasRunning) {
        await withTimeout(this.connection.request("shutdown"), SHUTDOWN_TIMEOUT_MS);
      }
    } catch {
      /* The server may already be gone, or it never answered. */
    }
    // Awaited so the frame is on the wire before the process is taken down.
    await this.connection?.notify("exit");
    await this.awaitExit();
    this.connection?.dispose();
    for (const timer of this.diagnosticTimers.values()) clearTimeout(timer);
    this.diagnosticTimers.clear();
    for (const doc of this.documents.values()) doc.subscriptions.dispose();
    this.documents.clear();
    this.manager.clearDiagnosticsForSession(this);
    this.manager.clearProgress(this);
    this.setState("stopped");
  }
};
