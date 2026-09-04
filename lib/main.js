const LanguageServerManager = require("./language-server-manager");
const CompletionProvider = require("./completion-provider");
const SymbolProvider = require("./symbol-provider");
const HoverProvider = require("./hover-provider");
const SignatureProvider = require("./signature-provider");
const CodeFormatProvider = require("./code-format-provider");
const ReferencesProvider = require("./references-provider");
const RefactorProvider = require("./refactor-provider");
const IntentionsProvider = require("./intentions-provider");
const CodeLensProvider = require("./code-lens-provider");
const InlayHintsProvider = require("./inlay-hints-provider");
const SemanticTokensProvider = require("./semantic-tokens-provider");
const NotebookDocuments = require("./notebook-documents");
const ServerStatusView = require("./server-status-view");
const CustomServers = require("./custom-servers");
const ManagedServers = require("./managed-servers");
const { CompositeDisposable, Disposable } = require("lumine");

module.exports = {
  activate() {
    this.manager = new LanguageServerManager();
    // Constructed before activate() so their capability fragments are merged
    // into the initialize handshake of every session.
    this.completionProvider = new CompletionProvider(this.manager);
    this.symbolProvider = new SymbolProvider(this.manager);
    this.hoverProvider = new HoverProvider(this.manager);
    this.signatureProvider = new SignatureProvider(this.manager);
    this.codeFormatProvider = new CodeFormatProvider(this.manager);
    this.referencesProvider = new ReferencesProvider(this.manager);
    this.refactorProvider = new RefactorProvider(this.manager);
    this.intentionsProvider = new IntentionsProvider(this.manager);
    this.codeLensProvider = new CodeLensProvider(this.manager);
    this.inlayHintsProvider = new InlayHintsProvider(this.manager);
    this.semanticTokensProvider = new SemanticTokensProvider(this.manager);
    this.manager.activate();
    this.notebookDocuments = new NotebookDocuments(this.manager);
    this.manager.setNotebookDocuments(this.notebookDocuments);
    this.managedServers = new ManagedServers(this.manager);
    this.manager.setManagedServers(this.managedServers);
    // A stage or backup left by a killed install would otherwise sit in the
    // storage directory for good; nothing has been launched from it yet.
    this.managedServers.sweep();
    this.customServers = new CustomServers(this.manager);
    this.customServers.activate();
    this.uiSubscriptions = new CompositeDisposable();
    this.uiSubscriptions.add(
      this.manager.onDidExhaustRestarts(({ session }) => this.reportServerGaveUp(session)),
      // A session exists only because resolveServer found something, so this is
      // the signal that the server is no longer missing. Re-arming the notice
      // means a later removal is reported once more instead of staying silent.
      this.manager.onDidChangeSession(({ session }) =>
        this.missingReported?.delete(session.adapter.id),
      ),
      lumine.commands.add("lumine-workspace", {
        "ide-client:servers": {
          description: "List the language servers now running, and act on one.",
          modal: "Servers",
          didDispatch: () => this.getSessionMenu().toggle(),
        },
        "ide-client:manage-servers": {
          description: "Install, update or remove the servers the editor fetches.",
          modal: "Manage Servers",
          didDispatch: () => this.getManagedMenu().toggle(),
        },
        "ide-client:toggle-problems": {
          description: "Open the panel listing every diagnostic the servers report.",
          didDispatch: () => this.showProblems(),
        },
        "ide-client:restart": {
          description: "Restart the language server serving this file.",
          didDispatch: () => this.restart(),
        },
        "ide-client:format": {
          description: "Format this file with whatever its language server offers.",
          didDispatch: () => this.format(),
        },
        "ide-client:show-log": {
          description: "Open the log of what this file's server has sent and received.",
          didDispatch: () => this.showLog(),
        },
        "ide-client:open-custom-servers-file": {
          description: "Open the file that declares your own server commands.",
          didDispatch: () => this.customServers.openFile(),
        },
      }),
    );
  },
  async deactivate() {
    // Before the manager stops the sessions: closing notebooks sends the
    // didClose notifications while the connections still exist.
    this.notebookDocuments?.dispose();
    this.notebookDocuments = null;
    this.treeFileOperationSubscriptions?.dispose();
    this.treeFileOperationSubscriptions = null;
    this.symbolProvider?.destroy();
    this.symbolProvider = null;
    this.codeLensProvider?.dispose();
    this.codeLensProvider = null;
    this.inlayHintsProvider?.dispose();
    this.inlayHintsProvider = null;
    this.semanticTokensProvider?.dispose();
    this.semanticTokensProvider = null;
    this.completionProvider = null;
    this.hoverProvider = null;
    this.signatureProvider = null;
    this.codeFormatProvider = null;
    this.referencesProvider = null;
    this.refactorProvider = null;
    this.intentionsProvider = null;
    this.customServers?.dispose();
    this.customServers = null;
    this._sessionMenu?.destroy();
    this._sessionMenu = null;
    this._managedMenu?.destroy();
    this._managedMenu = null;
    this.managedServers = null;
    // The module object outlives a deactivate/activate cycle, so a Set left
    // here would silence the notice for the rest of the process — a reload
    // would look like the opt-out had been pressed.
    this.missingReported = null;
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
      activeSessionsForEditor: (editor) => this.manager.activeSessionsForEditor(editor),
      activeSessionForFeature: (editor, method, feature) =>
        this.manager.activeSessionForFeature(editor, method, feature),
      getSessions: () => this.manager.allSessions(),
      onDidChangeSession: (fn) => this.manager.onDidChangeSession(fn),
      onDidChangeCapabilities: (fn) => this.manager.onDidChangeCapabilities(fn),
      onDidPublishDiagnostics: (fn) => this.manager.onDidPublishDiagnostics(fn),
      onDidChangeFeatures: (fn) => this.manager.onDidChangeFeatures(fn),
      featureEnabled: (adapter, feature, editor) =>
        this.manager.featureEnabled(adapter, feature, editor),
      onDidLog: (fn) => this.manager.onDidLog(fn),
      request: (editor, method, params, options) =>
        this.manager.sessionForEditor(editor)?.request(method, params, options),
      restart: (session) => this.manager.restart(session),
      stop: (session) => this.manager.disconnect(session),
      getLog: (adapterId) => this.manager.getLog(adapterId),
      // Managed servers. An adapter reaches for these to offer an install where
      // it would otherwise only report the server missing; the same calls back
      // the Manage Servers list.
      reportMissingServer: (adapterId, options) => this.reportMissingServer(adapterId, options),
      installServer: (adapterId, options) => this.installServer(adapterId, options),
      updateServer: (adapterId) => this.updateServer(adapterId),
      uninstallServer: (adapterId) => this.managedServers.uninstall(adapterId),
      managedServer: (adapterId) =>
        this.managedServers.installFor(this.manager.adapters.get(adapterId)),
      serverInstallationStatus: (adapterId) => this.managedServers.installationStatus(adapterId),
      onDidChangeServerInstallation: (fn) => this.managedServers.onDidChangeInstallation(fn),
      applyWorkspaceEdit: (edit, label, session) =>
        this.manager.applyWorkspaceEdit(edit, label, session),
      willCreateFiles: (payload) => this.manager.willCreateFiles(payload),
      willRenameFiles: (payload) => this.manager.willRenameFiles(payload),
      willDeleteFiles: (payload) => this.manager.willDeleteFiles(payload),
      didCreateFiles: (payload) => this.manager.didCreateFiles(payload),
      didRenameFiles: (payload) => this.manager.didRenameFiles(payload),
      didDeleteFiles: (payload) => this.manager.didDeleteFiles(payload),
      // Notebook documents. `openNotebookDocument` is the bridge a notebook UI
      // drives — jupyter-view itself — and the rest of LSP follows:
      // sync, routing of the cell editors through every provider, and cell
      // diagnostics landing against the notebook.
      openNotebookDocument: (descriptor) => this.notebookDocuments.open(descriptor),
      adaptersForNotebook: (filePath) =>
        this.notebookDocuments?.adaptersForNotebook(filePath) ?? [],
      cellUri: (notebookPath, cellId) => require("./converters").cellUri(notebookPath, cellId),
      parseCellUri: (uri) => require("./converters").parseCellUri(uri),
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
  provideCodeLens() {
    return this.codeLensProvider;
  },
  provideInlayHints() {
    return this.inlayHintsProvider;
  },
  provideSemanticTokens() {
    return this.semanticTokensProvider;
  },
  get sessionMenu() {
    return this.getSessionMenu();
  },
  getSessionMenu() {
    if (!this._sessionMenu) {
      const SessionMenuView = require("./session-menu-view");
      this._sessionMenu = new SessionMenuView(this);
    }
    return this._sessionMenu;
  },
  getManagedMenu() {
    if (!this._managedMenu) {
      const ManagedServersView = require("./managed-servers-view");
      this._managedMenu = new ManagedServersView(this);
    }
    return this._managedMenu;
  },
  consumeStatusBar(statusBar) {
    // status-bar can be reactivated while this package stays up, which calls
    // the consumer again; tear the previous item down rather than orphan it.
    this.teardownStatusBar();
    this.serverStatus = new ServerStatusView({
      manager: this.manager,
      onDidClick: () => this.getSessionMenu().toggle(),
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
    // Per adapter, per notebook, per cell: the whole notebook publishes in one
    // setMessages call, because the delegate replaces a file's entire bucket —
    // publishing cells one at a time would leave only the last cell standing.
    this.notebookBuckets = new Map();
    const delegateFor = (adapter, enabled) => {
      const key = adapter?.id || "unknown";
      let delegate = this.indieDelegates.get(key);
      // Nothing was ever shown for a server that has been off all along, so
      // there is nothing to clear and no reason to register for it.
      if (!delegate && !enabled) return null;
      if (!delegate) {
        delegate = registerIndie({
          name: adapter?.displayName || "Language Server",
          markerInvalidation: "never",
        });
        this.indieDelegates.set(key, delegate);
      }
      return delegate;
    };
    // Diagnostics may be pushed or pulled, so the `diagnostics` switch is honoured here
    // rather than where they arrive: what the server sent stays stored, and
    // switching the feature back on republishes it. Dropping it at arrival
    // would need a server restart to get it back — LSP has no way to ask for
    // diagnostics again from a push-only server.
    const publish = ({ session, uri, diagnostics }) => {
      const adapter = session?.adapter;
      const resolved = this.manager.resolveUri(uri);
      if (resolved?.kind === "cell") {
        return this.publishCellDiagnostics({ adapter, uri, diagnostics, resolved }, delegateFor);
      }
      const { toLinterMessages } = require("./linter-messages");
      const batch = toLinterMessages(uri, diagnostics);
      if (!batch.filePath) return;
      const enabled = this.manager.featureEnabled(
        adapter,
        "diagnostics",
        lumine.workspace.getTextEditors().find((editor) => editor.getPath() === batch.filePath),
      );
      const delegate = delegateFor(adapter, enabled);
      if (!delegate) return;
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
  consumeTreeViewFileOperations(service) {
    this.treeFileOperationSubscriptions?.dispose();
    const subscriptions = new CompositeDisposable(
      service.onWillCreateFiles((payload) => this.manager?.willCreateFiles(payload) ?? true),
      service.onWillRenameFiles((payload) => this.manager?.willRenameFiles(payload) ?? true),
      service.onWillDeleteFiles((payload) => this.manager?.willDeleteFiles(payload) ?? true),
      service.onDidCreateFiles((payload) => this.manager?.didCreateFiles(payload)),
      service.onDidRenameFiles((payload) => this.manager?.didRenameFiles(payload)),
      service.onDidDeleteFiles((payload) => this.manager?.didDeleteFiles(payload)),
    );
    this.treeFileOperationSubscriptions = subscriptions;
    return new Disposable(() => {
      if (this.treeFileOperationSubscriptions !== subscriptions) return;
      subscriptions.dispose();
      this.treeFileOperationSubscriptions = null;
    });
  },
  disposeIndieDelegates() {
    for (const delegate of this.indieDelegates?.values() || []) delegate.dispose();
    this.indieDelegates = null;
    this.notebookBuckets = null;
  },
  // Cell diagnostics aggregate per notebook and publish as one batch against
  // the notebook's path — the shape jupyter-view's linter adapter projects
  // onto the cells. Republishing after a structural edit flows back through
  // here, and `resolveUri` reads the cell's CURRENT index, which is what
  // re-projects the stored diagnostics onto the right cells.
  publishCellDiagnostics({ adapter, uri, diagnostics, resolved }, delegateFor) {
    const { toNotebookLinterMessages } = require("./linter-messages");
    const C = require("./converters");
    const adapterKey = adapter?.id || "unknown";
    let byNotebook = this.notebookBuckets.get(adapterKey);
    if (!byNotebook) {
      byNotebook = new Map();
      this.notebookBuckets.set(adapterKey, byNotebook);
    }
    let byCell = byNotebook.get(resolved.notebookPath);
    if (!byCell) {
      byCell = new Map();
      byNotebook.set(resolved.notebookPath, byCell);
    }
    const cellKey = C.uriKey(uri);
    // A cell that vanished between the server's answer and now has no index;
    // whatever it had on screen is evicted.
    const messages =
      resolved.cellIndex >= 0 && diagnostics?.length
        ? toNotebookLinterMessages(
            { notebookPath: resolved.notebookPath, cellIndex: resolved.cellIndex },
            diagnostics,
          ).messages
        : [];
    if (messages.length) byCell.set(cellKey, messages);
    else byCell.delete(cellKey);
    const enabled = this.manager.featureEnabled(adapter, "diagnostics", resolved.editor);
    const delegate = delegateFor(adapter, enabled);
    if (!delegate) return;
    delegate.setMessages(resolved.notebookPath, enabled ? [...byCell.values()].flat() : []);
    if (!byCell.size) byNotebook.delete(resolved.notebookPath);
  },
  // Diagnostics render through the linter package; this only opens the panel
  // that lists them. That panel is its own package, so holding a linter
  // delegate says nothing about whether one is installed — ask for the command.
  showProblems() {
    const view = lumine.views.getView(lumine.workspace);
    const opensPanel = lumine.commands
      .findCommands({ target: view })
      .some((command) => command.name === "linter-panel:toggle");
    if (opensPanel) {
      lumine.commands.dispatch(view, "linter-panel:toggle");
    } else {
      lumine.notifications.addInfo(
        "Install the linter-panel package to browse language-server problems.",
      );
    }
  },
  active() {
    const editor = lumine.workspace.getActiveTextEditor();
    return { editor, session: editor && this.manager.sessionForEditor(editor) };
  },
  // Restarts every server serving the active editor, since more than one can
  // be attached to it.
  async restart() {
    const editor = lumine.workspace.getActiveTextEditor();
    if (!editor) return;
    const sessions = this.manager.sessionsForEditor(editor);
    await Promise.all(sessions.map((session) => this.manager.restart(session)));
  },
  // Says once, per window, that an adapter could not find its server.
  //
  // A warning rather than an error: the package is not broken, it simply has
  // nothing to run, and a red banner for an optional tool the user may never
  // have wanted is the loudest possible way to say something minor. Every
  // adapter routes through here so the wording, the dedupe and the opt-out are
  // one implementation instead of one per package — four of them said this in
  // four separate copies before.
  reportMissingServer(adapterId, { description } = {}) {
    const adapter = this.manager.adapters.get(adapterId);
    if (!adapter) return null;
    // Undeclared reads as undefined, which must not silence the notice — only
    // an explicit `false`, which is what Never Ask Again writes.
    if (lumine.config.get(`${adapterId}.notifyWhenMissing`) === false) return null;
    this.missingReported ??= new Set();
    if (this.missingReported.has(adapterId)) return null;
    this.missingReported.add(adapterId);

    const name =
      adapter.managedServer?.displayName || adapter.managedServerDisplayName || adapter.displayName;
    // A notification button dismisses nothing on its own — `notification-element`
    // calls `onDidClick` and leaves the banner where it is — so every answer here
    // closes it. Both buttons are terminal: the install reports its own progress
    // in a notification of its own, and the opt-out has nothing further to say,
    // so a banner still asking the question is the only thing on screen saying
    // whether the click registered.
    let notification;
    const answer = (act) => () => {
      notification?.dismiss();
      act();
    };
    const buttons = [];
    if (adapter.managedServer) {
      buttons.push({
        text: `Install ${name}`,
        // Progress and failure are reported by the install itself.
        onDidClick: answer(() => this.installServer(adapterId).catch(() => {})),
      });
    }
    buttons.push({
      text: "Never Ask Again",
      // Written to the package's own settings rather than kept in memory, so it
      // survives a reload and can be undone on the page it belongs to.
      onDidClick: answer(() => lumine.config.set(`${adapterId}.notifyWhenMissing`, false)),
    });
    notification = lumine.notifications.addWarning(`Unable to find ${name}`, {
      description,
      dismissable: true,
      buttons,
    });
    return notification;
  },
  installServer(adapterId, options) {
    return this.runManaged(adapterId, "Installing", (name, record) =>
      lumine.notifications.addSuccess(`${name} ${record.version} installed`),
    )(() => this.managedServers.install(adapterId, options));
  },
  updateServer(adapterId) {
    return this.runManaged(adapterId, "Updating", (name, record) =>
      record.upToDate
        ? lumine.notifications.addInfo(`${name} is already at ${record.version}`)
        : lumine.notifications.addSuccess(`${name} updated to ${record.version}`),
    )(() => this.managedServers.update(adapterId));
  },
  // Downloading a server takes long enough that silence reads as a hang, so the
  // work is announced while it runs — through busy-signal where that package is
  // present, and through a notification the rest of the time.
  runManaged(adapterId, verb, report) {
    return async (work) => {
      const adapter = this.manager.adapters.get(adapterId);
      const name =
        adapter?.managedServer?.displayName ||
        adapter?.managedServerDisplayName ||
        adapter?.displayName ||
        adapterId;
      let title = `${verb} ${name}`;
      this.busyProvider?.add(title);
      const pending = this.busyProvider ? null : lumine.notifications.addInfo(`${title}…`);
      // The same status the Manage Servers row shows, so the status bar says
      // which part is slow rather than one label for the whole thing. The
      // payload's own `adapterId` is renamed on the way in: shadowing the one
      // this was called with would make the guard compare a value to itself.
      const following = this.managedServers.onDidChangeInstallation(
        ({ adapterId: changed, status }) => {
          if (changed !== adapterId || !status) return;
          const next = `${status[0].toUpperCase()}${status.slice(1)} ${name}`;
          if (next === title) return;
          this.busyProvider?.changeTitle(next, title);
          title = next;
        },
      );
      try {
        const record = await work();
        report(name, record);
        return record;
      } catch (error) {
        lumine.notifications.addError(`${verb} ${name} failed`, {
          detail: error.message,
          dismissable: true,
        });
        throw error;
      } finally {
        following.dispose();
        this.busyProvider?.remove(title);
        pending?.dismiss();
      }
    };
  },
  async format() {
    const editor = lumine.workspace.getActiveTextEditor();
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
    const { adapter, failureCount } = session;
    const notification = lumine.notifications.addError(
      `${adapter.displayName} stopped unexpectedly`,
      {
        description: failureCount
          ? `It was restarted ${failureCount} ${failureCount === 1 ? "time" : "times"} and exited again each time, so it will not be restarted any more. Its log says why.`
          : "Automatic restarts are turned off, so it will not be started again. Its log says why it stopped.",
        dismissable: true,
        // Restarting it again is the session menu's job; this is about saying why.
        buttons: [
          {
            text: "Open Log",
            // A notification button dismisses nothing on its own, and this one
            // sits over the workspace center the log opens into — so it closes
            // once the log is on screen, which is the moment the banner has
            // said everything it had to say. Only then: an open that declines
            // leaves the notification as the one record of what happened.
            onDidClick: async () => {
              if (await this.showLogForAdapter(adapter.id)) notification.dismiss();
            },
          },
        ],
      },
    );
  },
  // Returns the editor the log went into, or nothing when the open declined —
  // the notification's Open Log button reads that to decide whether it may go.
  async showLogForAdapter(adapterId) {
    const editor = await lumine.workspace.open();
    // An open can decline, e.g. when the workspace center is full.
    if (!editor) return;
    editor.setText(this.manager.getLog(adapterId));
    editor.setGrammar(lumine.grammars.grammarForScopeName("text.plain.null-grammar"));
    return editor;
  },
};
