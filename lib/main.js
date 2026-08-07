const LanguageServerManager = require("./language-server-manager");
const CompletionProvider = require("./completion-provider");
const SymbolProvider = require("./symbol-provider");
const HoverProvider = require("./hover-provider");
const SignatureProvider = require("./signature-provider");
const OutlineProvider = require("./outline-provider");
const CodeFormatProvider = require("./code-format-provider");
const ReferencesProvider = require("./references-provider");
const RefactorProvider = require("./refactor-provider");
const IntentionsProvider = require("./intentions-provider");
const ViewportTracker = require("./viewport-tracker");
const CodeLens = require("./code-lens");
const SemanticTokens = require("./semantic-tokens");
const InlayHints = require("./inlay-hints");
const SessionMenuView = require("./session-menu-view");
const ServerStatusView = require("./server-status-view");
const CustomServers = require("./custom-servers");
const { toLinterMessages } = require("./linter-messages");
const { CompositeDisposable, Disposable } = require("atom");

module.exports = {
  activate() {
    this.manager = new LanguageServerManager();
    this.completionProvider = new CompletionProvider(this.manager);
    this.symbolProvider = new SymbolProvider(this.manager);
    this.hoverProvider = new HoverProvider(this.manager);
    this.signatureProvider = new SignatureProvider(this.manager);
    this.outlineProvider = new OutlineProvider(this.manager);
    this.codeFormatProvider = new CodeFormatProvider(this.manager);
    this.referencesProvider = new ReferencesProvider(this.manager);
    this.refactorProvider = new RefactorProvider(this.manager);
    this.intentionsProvider = new IntentionsProvider(this.manager);
    // Constructed before activate() so their capability fragments are merged
    // into the initialize handshake of every session.
    this.viewportTracker = new ViewportTracker();
    this.codeLens = new CodeLens(this.manager, this.viewportTracker);
    this.semanticTokens = new SemanticTokens(this.manager, this.viewportTracker);
    this.inlayHints = new InlayHints(this.manager, this.viewportTracker);
    this.manager.activate();
    this.customServers = new CustomServers(this.manager);
    this.customServers.activate();
    this.uiSubscriptions = new CompositeDisposable();
    this.sessionMenu = new SessionMenuView(this);
    this.uiSubscriptions.add(
      this.manager.onDidExhaustRestarts(({ session }) => this.reportServerGaveUp(session)),
      atom.commands.add("atom-workspace", {
        "ide-client:servers": {
          modal: "Servers",
          didDispatch: () => this.sessionMenu.toggle(),
        },
        "ide-client:toggle-problems": () => this.showProblems(),
        "ide-client:restart": () => this.restart(),
        "ide-client:format": () => this.format(),
        "ide-client:show-log": () => this.showLog(),
        "ide-client:open-custom-servers-file": () => this.customServers.openFile(),
      }),
    );
  },
  async deactivate() {
    this.codeLens?.dispose();
    this.codeLens = null;
    this.semanticTokens?.dispose();
    this.semanticTokens = null;
    this.inlayHints?.dispose();
    this.inlayHints = null;
    this.viewportTracker?.dispose();
    this.viewportTracker = null;
    this.customServers?.dispose();
    this.customServers = null;
    this.sessionMenu?.destroy();
    // Before the manager stops every session: each stop reports a state change
    // the status item would render into a detached element.
    this.teardownStatusBar();
    this.indieSubscription?.dispose();
    this.disposeIndieDelegates();
    this.busyProvider?.dispose();
    this.busyProvider = null;
    this.uiSubscriptions?.dispose();
    await this.manager?.deactivate();
    this.manager = null;
  },
  provideIdeClient() {
    return {
      registerAdapter: (adapter) => this.manager.registerAdapter(adapter),
      adaptersForEditor: (editor) => this.manager.adaptersForEditor(editor),
      onDidChangeAdapters: (fn) => this.manager.onDidChangeAdapters(fn),
      sessionForEditor: (editor) => this.manager.sessionForEditor(editor),
      activeSessionForEditor: (editor) => this.manager.activeSessionForEditor(editor),
      getSessions: () => this.manager.allSessions(),
      onDidChangeSession: (fn) => this.manager.onDidChangeSession(fn),
      onDidPublishDiagnostics: (fn) => this.manager.onDidPublishDiagnostics(fn),
      onDidChangeFeatures: (fn) => this.manager.onDidChangeFeatures(fn),
      featureEnabled: (adapter, feature, editor) =>
        this.manager.featureEnabled(adapter, feature, editor),
      onDidLog: (fn) => this.manager.onDidLog(fn),
      request: (editor, method, params, options) =>
        this.manager.sessionForEditor(editor)?.request(method, params, options),
      restart: (session) => this.manager.restart(session),
      stop: (session) => session.stop(),
      getLog: (adapterId) => this.manager.getLog(adapterId),
      applyWorkspaceEdit: (edit, label) => this.manager.applyWorkspaceEdit(edit, label),
      openNotebook: (session, notebook, cells) => session.openNotebook(notebook, cells),
      changeNotebook: (session, notebook, change) => session.changeNotebook(notebook, change),
      saveNotebook: (session, notebook) => session.saveNotebook(notebook),
      closeNotebook: (session, notebook, cells) => session.closeNotebook(notebook, cells),
    };
  },
  provideAutocomplete() {
    return this.completionProvider;
  },
  provideSymbol() {
    return this.symbolProvider;
  },
  provideHover() {
    return this.hoverProvider;
  },
  provideHoverSignature() {
    return this.signatureProvider;
  },
  provideOutline() {
    return this.outlineProvider;
  },
  provideCodeFormatRange() {
    return this.codeFormatProvider.rangeProvider();
  },
  provideCodeFormatFile() {
    return this.codeFormatProvider.fileProvider();
  },
  provideCodeFormatOnType() {
    return this.codeFormatProvider.onTypeProvider();
  },
  provideCodeFormatOnSave() {
    return this.codeFormatProvider.onSaveProvider();
  },
  provideFindReferences() {
    return this.referencesProvider;
  },
  provideRefactor() {
    return this.refactorProvider;
  },
  provideIntentionsList() {
    return this.intentionsProvider;
  },
  consumeStatusBar(statusBar) {
    // status-bar can be reactivated while this package stays up, which calls
    // the consumer again; tear the previous item down rather than orphan it.
    this.teardownStatusBar();
    this.serverStatus = new ServerStatusView({
      manager: this.manager,
      onDidClick: () => this.sessionMenu.toggle(),
    });
    // Code-intelligence band, outside source control, see the priority
    // convention in packages/status-bar/README.md.
    this.serverStatusTile = statusBar.addRightTile({
      item: this.serverStatus.element,
      priority: 250,
    });
    return new Disposable(() => this.teardownStatusBar());
  },
  // The disposable above belongs to the status-bar package and never fires on
  // our own deactivation, so both paths call this and it has to be safe twice.
  teardownStatusBar() {
    this.serverStatusTile?.destroy();
    this.serverStatusTile = null;
    this.serverStatus?.destroy();
    this.serverStatus = null;
  },
  // Work-done progress a server reports spins the busy dot; the servers
  // themselves are long-lived and have a status item of their own.
  consumeBusySignal(busySignal) {
    this.busyProvider?.dispose();
    this.busyProvider = busySignal.create();
    this.manager.setBusyProvider(this.busyProvider);

    return new Disposable(() => {
      this.manager?.setBusyProvider(null);
      this.busyProvider?.dispose();
      this.busyProvider = null;
    });
  },
  consumeLinterRegistry(registerIndie) {
    this.indieSubscription?.dispose();
    this.disposeIndieDelegates();
    this.indieDelegates = new Map();
    // Diagnostics are pushed, so the `diagnostics` switch is honoured here
    // rather than where they arrive: what the server sent stays stored, and
    // switching the feature back on republishes it. Dropping it at arrival
    // would need a server restart to get it back — LSP has no way to ask for
    // diagnostics again.
    const publish = ({ session, uri, diagnostics }) => {
      const batch = toLinterMessages(uri, diagnostics);
      if (!batch.filePath) return;
      const adapter = session?.adapter;
      const enabled = this.manager.featureEnabled(
        adapter,
        "diagnostics",
        atom.workspace.getTextEditors().find((editor) => editor.getPath() === batch.filePath),
      );
      const key = adapter?.id || "unknown";
      let delegate = this.indieDelegates.get(key);
      // Nothing was ever shown for a server that has been off all along, so
      // there is nothing to clear and no reason to register for it.
      if (!delegate && !enabled) return;
      if (!delegate) {
        delegate = registerIndie({
          name: adapter?.displayName || "Language Server",
          markerInvalidation: "never",
        });
        this.indieDelegates.set(key, delegate);
      }
      delegate.setMessages(batch.filePath, enabled ? batch.messages : []);
    };
    const republish = (adapter) => {
      for (const entry of this.manager.allDiagnostics())
        if (!adapter || entry.session?.adapter === adapter) publish(entry);
    };
    republish(null);
    this.indieSubscription = new CompositeDisposable(
      this.manager.onDidPublishDiagnostics(publish),
      this.manager.onDidChangeFeatures(({ adapter }) => republish(adapter)),
    );
    return {
      dispose: () => {
        this.indieSubscription?.dispose();
        this.indieSubscription = null;
        this.disposeIndieDelegates();
      },
    };
  },
  disposeIndieDelegates() {
    for (const delegate of this.indieDelegates?.values() || []) delegate.dispose();
    this.indieDelegates = null;
  },
  // Diagnostics render through the linter package; this only opens its panel.
  showProblems() {
    if (this.indieDelegates) {
      atom.commands.dispatch(atom.views.getView(atom.workspace), "linter:toggle-panel");
    } else {
      atom.notifications.addInfo("Install the linter package to browse language-server problems.");
    }
  },
  active() {
    const editor = atom.workspace.getActiveTextEditor();
    return { editor, session: editor && this.manager.sessionForEditor(editor) };
  },
  // Restarts every server serving the active editor, since more than one can
  // be attached to it.
  async restart() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return;
    const sessions = this.manager.sessionsForEditor(editor);
    await Promise.all(sessions.map((session) => this.manager.restart(session)));
  },
  async format() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return;
    const edits = await this.codeFormatProvider.formatFile(editor);
    if (!edits.length) return;
    editor.transact(() => {
      for (const edit of [...edits].sort(
        (a, b) => b.oldRange[0][0] - a.oldRange[0][0] || b.oldRange[0][1] - a.oldRange[0][1],
      ))
        editor.setTextInBufferRange(edit.oldRange, edit.newText);
    });
  },
  async showLog() {
    const { session } = this.active();
    if (!session) return;
    return this.showLogForAdapter(session.adapter.id);
  },
  // A server that keeps dying leaves its reason in the log and nowhere else — a
  // panic, a missing dependency, a rejected option. Without this the only sign
  // was a status item reading "failed", which does not say to go and look.
  reportServerGaveUp(session) {
    const { adapter, restartCount } = session;
    atom.notifications.addError(`${adapter.displayName} stopped unexpectedly`, {
      description: restartCount
        ? `It was restarted ${restartCount} ${restartCount === 1 ? "time" : "times"} and exited again each time, so it will not be restarted any more. Its log says why.`
        : "Automatic restarts are turned off, so it will not be started again. Its log says why it stopped.",
      dismissable: true,
      // Restarting it again is the session menu's job; this is about saying why.
      buttons: [{ text: "Open Log", onDidClick: () => this.showLogForAdapter(adapter.id) }],
    });
  },
  async showLogForAdapter(adapterId) {
    const editor = await atom.workspace.open();
    // An open can decline, e.g. when the workspace center is full.
    if (!editor) return;
    editor.setText(this.manager.getLog(adapterId));
    editor.setGrammar(atom.grammars.grammarForScopeName("text.plain.null-grammar"));
  },
};
