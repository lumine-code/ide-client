const ChildProcess = require("child_process");
const net = require("net");
const { Emitter, CompositeDisposable } = require("lumine");
const RpcConnection = require("./rpc-connection");
const C = require("./converters");
const { STATIC_CAPABILITIES } = require("./capabilities");
const { languageIdForEditor } = require("./language-ids");
const { METHOD_FEATURES, featureEnabled } = require("./features");

// How long a server gets to exit on its own after `exit` before it is killed.
// Kept above the one-second interceptor used by the ESLint server.
const EXIT_GRACE_MS = 2000;

// Once a hard kill has been sent, wait a bounded interval for the operating
// system to report the physical process exit. A missing event must not leave
// window teardown pending forever.
const FINAL_EXIT_TIMEOUT_MS = 1000;

// Notifications normally flush immediately, but a wedged stream writer can
// leave even fire-and-forget traffic pending. `exit` gets its own bound before
// process teardown takes over.
const EXIT_NOTIFY_TIMEOUT_MS = 1000;

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
const START_CANCELLED = Symbol("start-cancelled");
const DYNAMIC_SETTINGS = Symbol("dynamic-settings");

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

// Resolves true when `promise` settles within the interval and false on the
// deadline. The input used here is a process-exit signal and never rejects.
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
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
  constructor(manager, adapter, rootPath, launch, startup = null) {
    this.manager = manager;
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.launch = launch;
    // A restart preflights these values while the old server is still healthy.
    // Direct starts pass no snapshot and resolve the same values here.
    this.startup = startup;
    // Every project folder this session answers for. More than one only when
    // the server declared multi-root support and adopted the rest.
    this.folders = new Set([rootPath]);
    this.documents = new Map();
    this.progressTitles = new Map();
    this.diagnosticTimers = new Map();
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.state = "starting";
    this.stateError = null;
    // `stop()` is single-flight. It is assigned before the first state event is
    // emitted so even a listener that calls stop reentrantly joins the same
    // teardown instead of starting a second protocol exchange.
    this.stopPromise = null;
    this.startCancelled = false;
    this.startCancellation = new Promise((resolve) => (this.resolveStartCancellation = resolve));
    this.startFailure = null;
    this.failureHandled = false;
    this.processExited = false;
    this.processError = null;
    this.processExitPromise = null;
    this.resolveProcessExit = null;
    this.socket = null;
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
    this.stateError = error || null;
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
    if (this.state === "starting" || this.state === "running")
      this.connection?.setTrace(lumine.config.get("ide-client.trace"));
  }
  async start() {
    if (!this.continueStart()) return;
    try {
      const {
        command,
        args = [],
        cwd = this.rootPath,
        env = {},
        transport = "stdio",
      } = this.launch;
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
        this.watchProcess();
        this.connection = RpcConnection.ipc(this.process, rpc);
      } else if (transport === "socket") {
        this.process = ChildProcess.spawn(command, args, options);
        this.watchProcess();
        this.socket = net.connect({
          host: this.launch.host || "127.0.0.1",
          port: this.launch.port,
        });
        await this.awaitDuringStart(() => this.awaitSocket(this.socket));
        if (!this.continueStart()) return;
        this.connection = RpcConnection.socket(this.socket, rpc);
      } else {
        this.process = ChildProcess.spawn(command, args, {
          ...options,
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.watchProcess();
        this.connection = RpcConnection.stdio(this.process, rpc);
      }
      if (!this.continueStart()) return;
      this.installClientHandlers();
      this.applyTrace();
      this.connection.listen();
      const rootUri = C.pathToUri(this.rootPath);
      const initializationOptions = this.startup
        ? this.startup.initializationOptions
        : await this.awaitDuringStart(() =>
            this.adapter.getInitializationOptions?.({
              rootPath: this.rootPath,
              rootUri,
            }),
          );
      if (!this.continueStart()) return;
      const result = await this.awaitDuringStart(() =>
        this.connection.request("initialize", {
          processId: process.pid,
          clientInfo: { name: "Lumine", version: lumine.application.getVersion() },
          locale: navigator.language,
          rootUri,
          workspaceFolders: this.startup?.workspaceFolders ?? this.manager.workspaceFolders(this),
          capabilities: this.manager.buildClientCapabilities(),
          initializationOptions,
        }),
      );
      if (!this.continueStart()) return;
      this.capabilities =
        this.adapter.transformServerCapabilities?.(result.capabilities) ||
        result.capabilities ||
        {};
      const encoding = this.capabilities.positionEncoding;
      if (encoding && encoding !== "utf-16")
        throw new Error(
          `${this.adapter.displayName} chose unsupported position encoding '${encoding}'`,
        );
      this.serverInfo = result.serverInfo;
      await this.awaitDuringStart(() => this.connection.notify("initialized", {}));
      if (!this.continueStart()) return;
      await this.pushSettings(this.startup ? this.startup.settings : DYNAMIC_SETTINGS);
      if (!this.continueStart()) return;
      this.startup = null;
      this.setState("running");
    } catch (error) {
      // Stopping a half-started session closes its connection and rejects any
      // pending initialize request. That is cancellation, not a start failure.
      if ((this.state === "stopping" || this.state === "stopped") && !this.startFailure) return;
      const failure =
        this.processError ||
        this.startFailure ||
        (this.state === "failed" ? this.stateError || error : error);
      // A failed hook, handshake, or capability check must not leave the
      // process alive until the manager notices. Manager cleanup joins this
      // same single-flight stop, so ownership remains coordinated.
      try {
        await this.stop();
      } catch (stopError) {
        this.manager.log(this, `Unable to clean up failed start: ${stopError.message}`);
      }
      throw failure;
    }
  }
  awaitDuringStart(operation) {
    if (this.startCancelled) return Promise.resolve(START_CANCELLED);
    const pending = Promise.resolve().then(operation);
    return Promise.race([pending, this.startCancellation]);
  }
  cancelStart() {
    if (this.startCancelled) return;
    this.startCancelled = true;
    this.resolveStartCancellation(START_CANCELLED);
  }
  continueStart() {
    if (this.startFailure) throw this.startFailure;
    if (this.state === "starting") return true;
    if (this.state === "stopping" || this.state === "stopped") return false;
    throw (
      this.stateError ||
      new Error(`Language server cannot finish starting from state '${this.state}'`)
    );
  }
  watchProcess() {
    this.processExitPromise = new Promise((resolve) => (this.resolveProcessExit = resolve));
    this.process.stderr?.on("data", (chunk) => this.manager.log(this, chunk.toString()));
    this.process.on("error", (error) => this.onProcessError(error));
    this.process.once("exit", (code, signal) => this.onProcessExit(code, signal));
  }
  awaitSocket(socket) {
    return new Promise((resolve, reject) => {
      let connected = false;
      const cleanup = () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };
      const onConnect = () => {
        connected = true;
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        if (connected) return;
        cleanup();
        reject(new Error("Language server socket closed before connecting"));
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }
  async pushSettings(settings = DYNAMIC_SETTINGS) {
    if (this.state !== "starting" && this.state !== "running") return;
    if (settings === DYNAMIC_SETTINGS) {
      settings = await this.awaitDuringStart(() => this.adapter.getSettings?.());
      if (settings === START_CANCELLED) return;
      if (settings == null)
        settings = await this.awaitDuringStart(() =>
          this.adapter.getWorkspaceConfiguration?.(undefined),
        );
      if (settings === START_CANCELLED) return;
      settings ??= {};
    }
    if (!this.connection || (this.state !== "starting" && this.state !== "running")) return;
    const sent = await this.awaitDuringStart(() =>
      this.connection.notify("workspace/didChangeConfiguration", { settings }),
    );
    if (sent === START_CANCELLED) return;
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
    this.subscriptions.add(this.connection.onClose(() => this.onConnectionClose()));
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
    this.connection.onRequest("workspace/workspaceFolders", () =>
      this.manager.workspaceFolders(this),
    );
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
    if (this.state !== "running") return;
    // A cell editor is synced through the notebookDocument notifications; a
    // misrouted call here would double-open it as a plain text document.
    if (this.manager.externalDocuments?.has(editor)) return;
    const uri = C.pathToUri(editor.getPath());
    const key = C.uriKey(uri);
    const existing = this.documents.get(key);
    // A feature request can join the manager's ordinary attachment while the
    // didOpen frame is still being written. Merely seeing the document in the
    // map is not enough: requests about it must remain ordered after didOpen.
    if (existing) return existing.openPromise;
    const document = { editor, uri, version: 1, subscriptions: new CompositeDisposable() };
    this.documents.set(key, document);
    document.openPromise = this.connection.notify("textDocument/didOpen", {
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
        this.notify("textDocument/didSave", {
          textDocument: { uri },
          text: this.transformDocumentText(editor.getText(), editor, uri),
        }),
      ),
    );
    document.subscriptions.add(editor.onDidDestroy(() => this.closeDocument(uri)));
    await document.openPromise;
  }
  changeDocument(document, event) {
    if (this.state !== "running") return;
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
    this.notify("textDocument/didChange", {
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
    if (
      this.state !== "running" ||
      document.notebook ||
      !this.supports("textDocument/diagnostic", document.editor)
    ) {
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
    if (this.state !== "running") return;
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
    this.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
    if (!this.documents.size && this.state === "running") this.manager.didCloseDocument(this);
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
    if (this.state !== "running") return;
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
    if (!this.documents.size && this.state === "running") this.manager.didCloseDocument(this);
  }
  settleProcessExit() {
    if (this.processExited) return;
    this.processExited = true;
    this.resolveProcessExit?.();
    this.manager.didExitProcess?.(this);
  }
  onProcessExit(code, signal) {
    this.settleProcessExit();
    this.failSession(new Error(`Server exited (${code ?? signal})`));
  }
  onProcessError(error) {
    this.processError ||= error;
    // A failed spawn has no process that could later emit exit. Settle its
    // waiter here; errors from an existing process still require physical exit.
    if (this.process?.pid == null) this.settleProcessExit();
    this.failSession(error);
  }
  onConnectionClose() {
    // A failed spawn closes its synthetic stdio streams as well as emitting the
    // child error. Let the more useful ENOENT/EACCES become the one terminal
    // cause rather than racing it with a generic connection message.
    if (this.process && this.process.pid == null && !this.processError) return;
    this.failSession(new Error(`${this.adapter.displayName} connection closed`));
  }
  failSession(error) {
    if (this.failureHandled || this.state === "stopping" || this.state === "stopped") return;
    this.failureHandled = true;
    this.startFailure = error;
    this.cancelStart();
    for (const cleanup of [
      () => this.manager.clearProgress(this),
      () => this.connection?.dispose(),
      () => this.socket?.destroy(),
      () => {
        if (
          this.process &&
          !this.processExited &&
          this.process.exitCode == null &&
          this.process.signalCode == null &&
          !this.process.kill("SIGKILL")
        )
          throw new Error("Language server refused SIGKILL after transport failure");
      },
    ])
      try {
        cleanup();
      } catch (cleanupError) {
        this.manager.log(this, cleanupError.stack || cleanupError.message);
      }
    try {
      this.setState("failed", error);
    } catch (stateError) {
      this.manager.log(this, stateError.stack || stateError.message);
    }
    try {
      this.manager.scheduleRestart(this);
    } catch (restartError) {
      this.manager.log(this, restartError.stack || restartError.message);
    }
  }
  // `exit` asks the server to leave on its own. Killing it in the same tick
  // breaks its stdin before it has read the frame, so wait for it to go and
  // only insist once it is clear it will not.
  async awaitExit() {
    const child = this.process;
    if (!child) return;
    if (this.processError && child.pid == null) throw this.processError;
    if (this.processExited || child.exitCode != null || child.signalCode != null) return;
    try {
      child.stdin?.end();
    } catch {
      // A closed stdin only means the graceful path is unavailable; the
      // bounded kill path below still guarantees that stop settles.
    }
    if (await settlesWithin(this.processExitPromise, EXIT_GRACE_MS)) return;

    let killError;
    try {
      if (!child.kill("SIGKILL")) killError = new Error("Language server refused SIGKILL");
    } catch (error) {
      killError = error;
    }
    if (await settlesWithin(this.processExitPromise, FINAL_EXIT_TIMEOUT_MS)) return;
    throw (
      killError ||
      this.processError ||
      new Error(`Language server did not exit within ${FINAL_EXIT_TIMEOUT_MS}ms after SIGKILL`)
    );
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
    if (this.processExited) return;
    // Assigned rather than `setState`: that reports the change onward, and the
    // views it would repaint are being torn down in the same breath.
    this.state = "stopped";
    this.cancelStart();
    for (const timer of this.diagnosticTimers.values()) clearTimeout(timer);
    this.diagnosticTimers.clear();
    try {
      this.connection?.dispose();
    } catch {
      /* The connection is going down with the window either way. */
    }
    try {
      this.socket?.destroy();
    } catch {
      /* The socket is going down with the window either way. */
    }
    try {
      if (!this.process || this.process.exitCode != null || this.process.signalCode != null)
        this.settleProcessExit();
      else this.process.kill("SIGKILL");
    } catch {
      /* Nothing can await or report a will-destroy fallback. */
    }
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "stopped") return (this.stopPromise = Promise.resolve());
    let resolveStop;
    let rejectStop;
    this.stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this.stopOnce().then(resolveStop, rejectStop);
    return this.stopPromise;
  }
  async stopOnce() {
    const wasRunning = this.state === "running";
    let stopError;
    const remember = (error) => {
      stopError ||= error;
    };
    try {
      try {
        this.setState("stopping");
      } catch (error) {
        remember(error);
      }
      this.cancelStart();
      for (const timer of this.diagnosticTimers.values()) clearTimeout(timer);
      this.diagnosticTimers.clear();
      // A socket still connecting has no JSON-RPC channel to shut down and
      // would otherwise be able to finish connecting after stop completed.
      if (!this.connection) this.socket?.destroy();
      if (wasRunning) {
        try {
          await withTimeout(this.connection.request("shutdown"), SHUTDOWN_TIMEOUT_MS);
        } catch {
          /* The server may already be gone, or it never answered. */
        }
      }
      // Awaited so the frame is on the wire before the process is taken down.
      try {
        await withTimeout(
          this.connection?.notify("exit") ?? Promise.resolve(),
          EXIT_NOTIFY_TIMEOUT_MS,
        );
      } catch (error) {
        remember(error);
      }
      try {
        await this.awaitExit();
      } catch (error) {
        remember(error);
      }
    } finally {
      try {
        this.connection?.dispose();
      } catch (error) {
        remember(error);
      }
      try {
        this.socket?.destroy();
      } catch (error) {
        remember(error);
      }
      this.socket = null;
      try {
        this.subscriptions.dispose();
      } catch (error) {
        remember(error);
      }
      for (const doc of this.documents.values()) {
        try {
          doc.subscriptions.dispose();
        } catch (error) {
          remember(error);
        }
      }
      this.documents.clear();
      this.startup = null;
      try {
        this.manager.clearDiagnosticsForSession(this);
      } catch (error) {
        remember(error);
      }
      try {
        this.manager.clearProgress(this);
      } catch (error) {
        remember(error);
      }
      try {
        this.setState("stopped");
      } catch (error) {
        remember(error);
      }
    }
    if (stopError) throw stopError;
  }
};
