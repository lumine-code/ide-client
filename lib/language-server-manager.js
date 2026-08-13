const path = require("path");
const fs = require("fs");
const picomatch = require("picomatch");
const { Emitter, CompositeDisposable, Disposable } = require("lumine");
const ServerSession = require("./server-session");
const C = require("./converters");
const { baseCapabilities, mergeCapabilities } = require("./capabilities");
const { languageIdForEditor } = require("./language-ids");
const { featuresKeyPath, featureEnabled } = require("./features");

// Grace period before a session with no documents left is reclaimed.
const IDLE_SHUTDOWN_MS = 1000;

// How long a server has to stay up before the exit that follows it counts as a
// new incident rather than one more in the same failure run. Without a clock in
// it, "how many restarts are left" is the wrong question in both directions: a
// server that dies on every start would keep its retries for as long as the
// window is open, and one that runs for hours would eventually be retired over
// crashes that have nothing to do with each other.
const HEALTHY_UPTIME_MS = 60000;

// What is wrong with an adapter's `managedServer`, if it declares one. Checked
// at registration rather than at install time: a descriptor is static data, and
// a typo in it should not wait until a user asks for the install to surface.
function managedServerFaults(adapter) {
  const descriptor = adapter?.managedServer;
  const fetchesItsOwn = typeof adapter?.installServer === "function";
  // Two ways in, and an adapter that declares both leaves it ambiguous which
  // one fills the staging directory.
  if (descriptor && fetchesItsOwn) return ["managedServer with installServer"];
  if (!descriptor) return [];
  const faults = [];
  const named = (key) => `managedServer.${key}`;
  if (descriptor.source === "npm") {
    if (!Array.isArray(descriptor.packages) || !descriptor.packages.length)
      faults.push(named("packages"));
    if (!descriptor.module) faults.push(named("module"));
  } else if (descriptor.source === "github-release") {
    if (!descriptor.repository) faults.push(named("repository"));
    if (typeof descriptor.assetFor !== "function") faults.push(named("assetFor"));
    if (!descriptor.binary || path.basename(descriptor.binary) !== descriptor.binary)
      faults.push(named("binary"));
    if (descriptor.assetType && !["archive", "binary"].includes(descriptor.assetType))
      faults.push(named("assetType"));
    // Stated, never inferred: a source that publishes nothing to verify against
    // has to say so, so the gap is visible in the adapter rather than here.
    if (!["sha256-sidecar", "none"].includes(descriptor.checksum)) faults.push(named("checksum"));
  } else {
    faults.push(named("source"));
  }
  return faults;
}

module.exports = class LanguageServerManager {
  constructor() {
    this.adapters = new Map();
    this.adapterSubscriptions = new Map();
    this.sessions = new Map();
    this.dynamicCapabilities = new Map();
    this.capabilityFragments = [];
    this.diagnostics = new Map();
    this.logs = new Map();
    this.editorSubscriptions = new Map();
    this.busyProvider = null;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    // Pending checks for sessions whose last document just closed.
    this.idleChecks = new Map();
    // Pending automatic restarts, at most one per session.
    this.restartTimers = new Map();
    // Editors whose document identity is not their file path — notebook cells.
    // The WeakMap routes an editor to its binding; the Map routes a URI a
    // server sent back to the same binding. Registered by the notebook module.
    this.externalDocuments = new WeakMap();
    this.externalUris = new Map();
    this.notebookDocuments = null;
  }
  setNotebookDocuments(notebookDocuments) {
    this.notebookDocuments = notebookDocuments;
  }
  // binding: { editor, uri, cellId, record } — record carries the notebook's
  // filePath, its uri, cellIndexOf(cellId), and an optional show() callback.
  registerExternalDocument(editor, binding) {
    this.externalDocuments.set(editor, binding);
    this.externalUris.set(C.uriKey(binding.uri), binding);
  }
  unregisterExternalDocument(editor) {
    const binding = this.externalDocuments.get(editor);
    if (!binding) return;
    this.externalDocuments.delete(editor);
    this.externalUris.delete(C.uriKey(binding.uri));
  }
  // The document URI requests about this editor carry. For a bound editor that
  // is its cell URI; for everything else the file path, or null without one.
  uriForEditor(editor) {
    const binding = this.externalDocuments.get(editor);
    if (binding) return binding.uri;
    const filePath = editor.getPath();
    return filePath ? C.pathToUri(filePath) : null;
  }
  // What a URI a server answered with refers to. Cell URIs resolve through the
  // bindings; file URIs to their path; anything else to null.
  resolveUri(uri) {
    const binding = this.externalUris.get(C.uriKey(uri));
    if (binding) {
      return {
        kind: "cell",
        editor: binding.editor,
        notebookPath: binding.record.filePath,
        cellId: binding.cellId,
        cellIndex: binding.record.cellIndexOf(binding.cellId),
        record: binding.record,
      };
    }
    let filePath = null;
    try {
      filePath = C.uriToPath(uri);
    } catch {
      /* Not a URI this platform can resolve. */
    }
    return filePath ? { kind: "file", path: filePath } : null;
  }
  activate() {
    this.knownRoots = lumine.project.getPaths();
    this.subscriptions.add(
      lumine.workspace.observeTextEditors((editor) => {
        this.watchEditor(editor);
        this.attachEditor(editor);
      }),
      lumine.project.onDidChangePaths(() => this.projectPathsChanged()),
      lumine.project.onDidChangeFiles((events) => this.routeFileEvents(events)),
      lumine.config.onDidChange("ide-client.trace", () => {
        for (const session of this.allSessions()) session.applyTrace();
      }),
      // Package deactivation is skipped on a reload, and a language server is a
      // child process that outlives the window it was started from.
      lumine.window.onWillDestroy(() => this.killAllSessions()),
    );
  }
  onDidChangeSession(fn) {
    return this.emitter.on("did-change-session", fn);
  }
  // fn({adapter, registered}) — fired when an adapter is registered or
  // unregistered. What a package outside the hub needs it for: a linter that
  // shells out to the same tool a server already serves stands down while that
  // adapter covers an editor, and has to hear when the coverage changes.
  onDidChangeAdapters(fn) {
    return this.emitter.on("did-change-adapters", fn);
  }
  onDidPublishDiagnostics(fn) {
    return this.emitter.on("did-publish-diagnostics", fn);
  }
  // fn({adapter}) — fired when one of an adapter's feature switches changes.
  // What is already on screen was produced under the old answer, so whoever
  // holds it re-reads: the feature modules refetch, and diagnostics — which are
  // pushed and cannot be re-requested — are republished from what is stored.
  onDidChangeFeatures(fn) {
    return this.emitter.on("did-change-features", fn);
  }
  featureEnabled(adapter, feature, editor) {
    return featureEnabled(adapter, feature, editor);
  }
  onDidLog(fn) {
    return this.emitter.on("did-log", fn);
  }
  // fn({session, kind: "codeLens" | "semanticTokens" | "inlayHint"}) — fired
  // when a server asks the client to re-fetch that feature's data.
  onDidRequestRefresh(fn) {
    return this.emitter.on("did-request-refresh", fn);
  }
  requestRefresh(session, kind) {
    this.emitter.emit("did-request-refresh", { session, kind });
  }
  // Feature modules contribute client-capability fragments before any session
  // starts; the merged result is sent with every initialize request.
  addCapabilityFragment(fragment) {
    if (fragment) this.capabilityFragments.push(fragment);
  }
  buildClientCapabilities() {
    return mergeCapabilities(baseCapabilities(), ...this.capabilityFragments);
  }
  workspaceFolders() {
    return lumine.project
      .getPaths()
      .map((projectPath) => ({ uri: C.pathToUri(projectPath), name: path.basename(projectPath) }));
  }
  setBusyProvider(provider) {
    this.busyProvider = provider;
  }
  allGrammarScopes() {
    const scopes = new Set();
    for (const adapter of this.adapters.values())
      for (const scope of adapter.grammarScopes) scopes.add(scope);
    return [...scopes];
  }
  registerAdapter(adapter) {
    const faults = ["id", "displayName"].filter((key) => !adapter?.[key]);
    if (!Array.isArray(adapter?.grammarScopes) || !adapter.grammarScopes.length)
      faults.push("grammarScopes");
    if (typeof adapter?.resolveServer !== "function") faults.push("resolveServer");
    faults.push(...managedServerFaults(adapter));
    if (faults.length) throw new TypeError(`Invalid language-server adapter: ${faults.join(", ")}`);
    if (this.adapters.has(adapter.id))
      throw new Error(`Language-server adapter '${adapter.id}' is already registered`);
    this.adapters.set(adapter.id, adapter);
    const subs = new CompositeDisposable();
    for (const keyPath of adapter.settingsKeyPaths || [])
      subs.add(lumine.config.onDidChange(keyPath, () => this.pushSettingsForAdapter(adapter)));
    const features = featuresKeyPath(adapter);
    if (features)
      subs.add(
        lumine.config.onDidChange(features, () =>
          this.emitter.emit("did-change-features", { adapter }),
        ),
      );
    this.adapterSubscriptions.set(adapter.id, subs);
    this.emitter.emit("did-change-adapters", { adapter, registered: true });
    this.reattachAll();
    return new Disposable(() => this.unregisterAdapter(adapter));
  }
  async unregisterAdapter(adapter) {
    if (this.adapters.get(adapter.id) !== adapter) return;
    this.adapters.delete(adapter.id);
    this.adapterSubscriptions.get(adapter.id)?.dispose();
    this.adapterSubscriptions.delete(adapter.id);
    // Announced before the sessions are reclaimed: the adapter is already out
    // of `adaptersForEditor`, which is what a subscriber re-reads.
    this.emitter.emit("did-change-adapters", { adapter, registered: false });
    const owned = new Set(
      this.allSessions().filter((session) => session.adapter.id === adapter.id),
    );
    // Reclaimed rather than disconnected: this runs from the disposable an
    // adapter package drops on its own deactivation, and nothing awaits that.
    await Promise.all([...owned].map((session) => this.reclaim(session)));
  }
  // Every adapter that serves this editor. More than one is normal and
  // intended: a type checker and a linter/formatter commonly cover the same
  // grammar, and both run.
  adaptersForEditor(editor) {
    const scope = editor.getGrammar()?.scopeName;
    // A cell editor has no path of its own; selector patterns run against the
    // notebook's, which is the file the server is really being asked about.
    const filePath = this.externalDocuments.get(editor)?.record.filePath ?? editor.getPath();
    return [...this.adapters.values()].filter(
      (adapter) =>
        adapter.grammarScopes.includes(scope) &&
        (!adapter.documentSelector ||
          adapter.documentSelector.some(
            (filter) => !filter.pattern || this.globMatches(filter.pattern, filePath || ""),
          )),
    );
  }
  adapterForEditor(editor) {
    return this.adaptersForEditor(editor)[0];
  }
  rootForPath(filePath, adapter) {
    const roots = lumine.project.getPaths();
    if (adapter.sessionScope === "workspace") return roots[0] || path.dirname(filePath);
    return (
      roots
        .filter((root) => filePath === root || filePath.startsWith(root + path.sep))
        .sort((a, b) => b.length - a.length)[0] || path.dirname(filePath)
    );
  }
  // A project-root session is identified by the root it serves. A
  // workspace-scoped one serves the whole window, so its identity must not
  // move when `roots[0]` does: it keeps whichever root it started with as its
  // `rootUri` and hears about the rest through `didChangeWorkspaceFolders`.
  keyFor(adapter, rootPath) {
    return adapter.sessionScope === "workspace" ? `${adapter.id}:` : `${adapter.id}:${rootPath}`;
  }
  // A session that adopted folders is reachable under one key per folder, so
  // anything walking the sessions themselves has to go through here.
  allSessions() {
    return [...new Set(this.sessions.values())];
  }
  // The project folders a session answers for. A workspace-scoped one answers
  // for all of them and only happens to have started at the first, so its own
  // `rootPath` says nothing about its reach.
  foldersFor(session) {
    if (session.adapter.sessionScope !== "workspace") return [...session.folders];
    const roots = lumine.project.getPaths();
    return roots.length ? roots : [session.rootPath];
  }
  // What a session covers: the window as a whole, one or more project roots,
  // or the directory of a file opened outside the project.
  scopeFor(session) {
    if (session.adapter.sessionScope === "workspace") return "workspace";
    const roots = lumine.project.getPaths();
    return [...session.folders].some((folder) => roots.includes(folder)) ? "root" : "file";
  }
  keysFor(session) {
    return [...this.sessions].filter(([, value]) => value === session).map(([key]) => key);
  }
  forget(session) {
    this.cancelRestart(session);
    for (const key of this.keysFor(session)) this.sessions.delete(key);
  }
  folderOf(rootPath) {
    return { uri: C.pathToUri(rootPath), name: path.basename(rootPath) };
  }
  // Whether a running server can take on a project folder it was not started
  // with. `supported` alone only means it read the list at initialize; adding
  // one afterwards needs the change notification as well.
  acceptsFolders(session) {
    const folders = session.capabilities.workspace?.workspaceFolders;
    return !!folders?.supported && !!folders.changeNotifications;
  }
  // A server that declares multi-root support does not need a second process
  // for a second project folder — it is told about the folder instead. The
  // capabilities say which servers those are, so no adapter has to declare it.
  async adoptFolder(adapter, rootPath, key) {
    if (adapter.sessionScope === "workspace") return null;
    for (const session of this.allSessions()) {
      if (session.adapter !== adapter || session.folders.has(rootPath)) continue;
      try {
        await session.ready;
      } catch {
        continue;
      }
      // Another attach for the same root won the race while we were waiting.
      if (this.sessions.has(key)) return this.sessions.get(key);
      if (session.state !== "running" || !this.acceptsFolders(session)) continue;
      session.folders.add(rootPath);
      this.sessions.set(key, session);
      session.notify("workspace/didChangeWorkspaceFolders", {
        event: { added: [this.folderOf(rootPath)], removed: [] },
      });
      this.didChangeSession(session);
      return session;
    }
    return null;
  }
  adapterContext(adapter, rootPath) {
    return {
      rootPath,
      projectPaths: lumine.project.getPaths(),
      configDirPath: lumine.getConfigDirPath(),
      managedStoragePath: path.join(lumine.getConfigDirPath(), "language-servers", adapter.id),
      // The copy the editor installed on the user's behalf, or null. Resolved
      // here so an adapter reads one field instead of knowing the layout.
      managedServer: this.managedServers?.installFor(adapter) ?? null,
    };
  }
  setManagedServers(managedServers) {
    this.managedServers = managedServers;
  }
  // Re-runs attachment for every open editor. Registering an adapter does this
  // so an already-open file finds its new server; installing or removing a
  // managed server does it so the next launch reads the new resolution.
  async reattachAll() {
    for (const editor of lumine.workspace.getTextEditors()) await this.attachEditor(editor);
    // Notebooks attach through their own module: an adapter registered after a
    // notebook opened, or a restarted server, gets its notebookDocument/didOpen
    // from here.
    await this.notebookDocuments?.reattachAll();
  }
  watchEditor(editor) {
    if (this.editorSubscriptions.has(editor)) return;
    const subs = new CompositeDisposable(
      editor.onDidChangeGrammar(() => this.reattachEditor(editor)),
      editor.onDidChangePath(() => this.reattachEditor(editor)),
      editor.onDidDestroy(() => {
        subs.dispose();
        this.editorSubscriptions.delete(editor);
      }),
    );
    this.editorSubscriptions.set(editor, subs);
  }
  reattachEditor(editor) {
    for (const session of this.allSessions()) session.detachEditor(editor);
    return this.attachEditor(editor);
  }
  async attachEditor(editor) {
    const filePath = editor.getPath();
    if (!filePath) return;
    await Promise.all(
      this.adaptersForEditor(editor).map((adapter) => this.attachAdapter(adapter, editor)),
    );
  }
  // Finds or starts the session for (adapter, rootPath), without attaching any
  // document to it. Throws what resolveServer throws; resolves null when the
  // adapter declined. The caller owns failure reporting.
  async ensureSession(adapter, rootPath) {
    const key = this.keyFor(adapter, rootPath);
    let session = this.sessions.get(key) || (await this.adoptFolder(adapter, rootPath, key));
    if (!session) {
      const launch = await adapter.resolveServer(this.adapterContext(adapter, rootPath));
      if (!launch) return null;
      // Another attach for the same adapter and root won the race while we
      // were resolving; answer with the session it created.
      if (this.sessions.has(key)) return this.sessions.get(key);
      session = new ServerSession(this, adapter, rootPath, launch);
      this.sessions.set(key, session);
      // The session exists now; state changes alone never say so, and it stays
      // "starting" until the handshake finishes.
      this.didChangeSession(session);
      session.ready = session.start();
      session.ready.catch(() => {});
    }
    return session;
  }
  async attachAdapter(adapter, editor) {
    const filePath = editor.getPath();
    const rootPath = this.rootForPath(filePath, adapter);
    const key = this.keyFor(adapter, rootPath);
    let session;
    try {
      session = await this.ensureSession(adapter, rootPath);
    } catch (error) {
      return this.reportStartFailure(adapter, rootPath, error);
    }
    if (!session) return;
    try {
      await session.ready;
      if (this.sessions.get(key) !== session) return;
      await session.openEditor(editor);
    } catch (error) {
      if (this.sessions.get(key) === session) {
        // Every key it holds, not only this one: a session that adopted folders
        // and then failed to start would otherwise stay reachable under the
        // rest, reading "failed" in the status bar with nothing left to serve
        // it. Forgetting it also cancels the retry its exit handler scheduled —
        // a server that cannot start at all is reported once rather than
        // retried behind a notification that already said so.
        this.forget(session);
        // The start already failed; the reason the user needs is reported below,
        // and cleaning up after it must not add a rejection nobody is awaiting.
        this.stopSession(session);
      }
      this.reportStartFailure(adapter, rootPath, error);
    }
  }
  reportStartFailure(adapter, rootPath, error) {
    this.log({ adapter, rootPath }, error.stack || error.message);
    lumine.notifications.addError(`Unable to start ${adapter.displayName}`, {
      detail: error.message,
      dismissable: true,
    });
  }
  // Every session serving this editor, in adapter registration order.
  sessionsForEditor(editor) {
    const binding = this.externalDocuments.get(editor);
    const filePath = binding?.record.filePath ?? editor.getPath();
    if (!filePath) return [];
    const sessions = this.adaptersForEditor(editor)
      .map((adapter) =>
        this.sessions.get(this.keyFor(adapter, this.rootForPath(filePath, adapter))),
      )
      .filter(Boolean);
    // For a cell, only the sessions actually holding the cell document — a
    // same-root server without notebook sync never saw the notebook and must
    // never be asked about a cell URI.
    if (binding) {
      const key = C.uriKey(binding.uri);
      return sessions.filter((session) => session.documents.has(key));
    }
    return sessions;
  }
  sessionForEditor(editor) {
    return this.sessionsForEditor(editor)[0] || null;
  }
  // Resolves once each session for this editor finished starting, keeping only
  // the ones that are running.
  async activeSessionsForEditor(editor) {
    const sessions = await Promise.all(
      this.sessionsForEditor(editor).map(async (session) => {
        try {
          await session.ready;
        } catch {
          return null;
        }
        return session.state === "running" ? session : null;
      }),
    );
    return sessions.filter(Boolean);
  }
  // The first running session that can serve `method` for this editor. Used by
  // the features where several answers cannot sensibly be combined — a single
  // rename, one formatting result, one outline. Which server that is follows
  // from the feature switches: turning the feature off for one adapter hands
  // the request to the next.
  async activeSessionForFeature(editor, method, feature) {
    const sessions = await this.activeSessionsForEditor(editor);
    return sessions.find((session) => session.supports(method, editor, feature)) || null;
  }
  async activeSessionForEditor(editor) {
    return (await this.activeSessionsForEditor(editor))[0] || null;
  }
  didChangeSession(session, error) {
    this.emitter.emit("did-change-session", { session, state: session.state, error });
  }
  // Diagnostics are stored per session as well as per document: several
  // servers commonly report on the same file, and one must not erase another.
  // Keyed by `uriKey`, not by the URI as it arrived: this is where a spelling
  // the server chose has to find a document the client opened, and the two are
  // not the same string. What is emitted keeps the server's own spelling.
  publishDiagnostics(session, params) {
    const document = session.documents?.get(C.uriKey(params.uri));
    // versionSupport is advertised, so a versioned result belongs to exactly
    // the document snapshot that produced it. An older response must not
    // repaint markers after a newer keystroke; an impossible future version is
    // equally unsafe to apply. Unversioned diagnostics remain valid because
    // servers are not required to send the optional field. A notebook cell has
    // two defensible counters — its own text document version and the notebook
    // document's — and servers disagree on which one "the document" means
    // (ruff stamps the notebook's, basedpyright the cell's), so a cell accepts
    // either; insisting on one dropped every ruff cell publish as stale.
    if (params.version != null && document) {
      const versions = document.notebook
        ? [document.version, document.notebook.version]
        : [document.version];
      if (!versions.includes(params.version)) return;
    }
    // The adapter's last word on what its server reported. This is the only
    // funnel — push notifications, pulled reports and the cleared list a closed
    // document publishes all arrive here — so what it returns is what is
    // stored, emitted, counted, and offered as a code action's context, with no
    // second copy of the raw list to drift from it.
    const entry = { session, ...params };
    if (Array.isArray(params.diagnostics))
      entry.diagnostics =
        session.transformDiagnostics?.(params.diagnostics, params.uri, document) ??
        params.diagnostics;
    const byUri = this.diagnostics.get(session) || new Map();
    byUri.set(C.uriKey(params.uri), entry);
    this.diagnostics.set(session, byUri);
    this.emitter.emit("did-publish-diagnostics", entry);
  }
  diagnosticsFor(session, uri) {
    return this.diagnostics.get(session)?.get(C.uriKey(uri))?.diagnostics || [];
  }
  // Re-emits what is stored for these documents, unchanged. After a structural
  // notebook edit the diagnostics are the same but every consumer's idea of
  // which cell a URI names has shifted, so the projection has to run again.
  republishStoredDiagnostics(session, uriKeys) {
    const byUri = this.diagnostics.get(session);
    if (!byUri) return;
    for (const key of uriKeys) {
      const entry = byUri.get(key);
      if (entry) this.emitter.emit("did-publish-diagnostics", entry);
    }
  }
  allDiagnostics() {
    return [...this.diagnostics.values()].flatMap((byUri) => [...byUri.values()]);
  }
  // What one session has reported, for the UIs that summarize a server rather
  // than a file. Files with nothing left to say are not counted: a cleared
  // document keeps its entry with an empty list.
  diagnosticCountFor(session) {
    let total = 0;
    let files = 0;
    for (const entry of this.diagnostics.get(session)?.values() || []) {
      if (!entry.diagnostics?.length) continue;
      total += entry.diagnostics.length;
      files++;
    }
    return { total, files };
  }
  clearDiagnosticsForSession(session) {
    const byUri = this.diagnostics.get(session);
    if (!byUri) return;
    this.diagnostics.delete(session);
    // The stored entry, not the map key: a consumer receives the URI the server
    // used, which is what it was given when the diagnostics first arrived.
    for (const entry of byUri.values())
      this.emitter.emit("did-publish-diagnostics", { session, uri: entry.uri, diagnostics: [] });
  }
  // fn({session}) — fired when a server registers or withdraws a capability
  // after it started. What a feature holding rendered state needs it for: a
  // capability that arrives late was absent when the session came up, so
  // whoever looked then concluded the server could not serve it and stopped.
  onDidChangeCapabilities(fn) {
    return this.emitter.on("did-change-capabilities", fn);
  }
  registerCapabilities(session, registrations = []) {
    const map = this.dynamicCapabilities.get(session) || new Map();
    for (const item of registrations) map.set(item.id, item);
    this.dynamicCapabilities.set(session, map);
    if (registrations.length) this.emitter.emit("did-change-capabilities", { session });
  }
  unregisterCapabilities(session, registrations = []) {
    const map = this.dynamicCapabilities.get(session);
    for (const item of registrations || []) map?.delete(item.id);
    if (registrations?.length) this.emitter.emit("did-change-capabilities", { session });
  }
  // Returns true/false when dynamic registrations govern the method for this
  // editor, undefined when none do (static capability applies).
  dynamicSupport(session, method, editor) {
    const registrations = this.dynamicCapabilities.get(session);
    if (!registrations) return undefined;
    let found;
    for (const item of registrations.values()) {
      if (item.method !== method) continue;
      found = false;
      const selector = item.registerOptions?.documentSelector;
      if (!selector || this.selectorMatches(selector, session, editor)) return true;
    }
    return found;
  }
  // The register options of the dynamic registration governing this method for
  // this editor, or undefined when none does. Companion to `dynamicSupport`:
  // that one answers whether, this one carries what it was registered with.
  dynamicOptions(session, method, editor) {
    const registrations = this.dynamicCapabilities.get(session);
    if (!registrations) return undefined;
    for (const item of registrations.values()) {
      if (item.method !== method) continue;
      const selector = item.registerOptions?.documentSelector;
      if (!selector || this.selectorMatches(selector, session, editor)) return item.registerOptions;
    }
    return undefined;
  }
  selectorMatches(selector, session, editor) {
    if (!editor) return true;
    const binding = this.externalDocuments.get(editor);
    const scheme = binding ? C.CELL_SCHEME : "file";
    // Patterns run against the file the server knows: the notebook's path for
    // a cell, the editor's own for everything else.
    const filePath = binding?.record.filePath ?? editor.getPath() ?? "";
    const languageId = languageIdForEditor(session.adapter, editor);
    return selector.some((filter) => {
      if (typeof filter === "string") return filter === languageId;
      // LSP 3.17 NotebookCellTextDocumentFilter: `notebook` names the
      // containing notebook, `language` the cell. basedpyright registers its
      // dynamic capabilities with this shape.
      if (filter.notebook !== undefined) {
        if (!binding) return false;
        if (!this.notebookFilterMatches(filter.notebook, binding.record)) return false;
        return !filter.language || filter.language === languageId;
      }
      if (filter.scheme && filter.scheme !== scheme) return false;
      if (filter.language && filter.language !== languageId) return false;
      if (filter.pattern && !this.globMatches(filter.pattern, filePath)) return false;
      return !!(filter.language || filter.pattern || filter.scheme);
    });
  }
  notebookFilterMatches(filter, record) {
    if (typeof filter === "string") return filter === record.notebookType;
    if (filter.notebookType && filter.notebookType !== record.notebookType) return false;
    // The notebook itself is a file: URI whatever its cells' scheme is.
    if (filter.scheme && filter.scheme !== "file") return false;
    if (filter.pattern && !this.globMatches(filter.pattern, record.filePath || "")) return false;
    return true;
  }
  globMatches(globPattern, filePath) {
    if (!globPattern || !filePath) return false;
    const normalized = filePath.replaceAll("\\", "/");
    // Windows paths are case-insensitive, but servers do not agree on drive
    // letter casing. vscode-eslint, for example, registers `c:/...` while
    // Electron reports the same editor as `C:\\...`; a case-sensitive glob
    // silently drops that otherwise valid dynamic capability.
    const options = { dot: true, nocase: process.platform === "win32" };
    if (typeof globPattern === "string") {
      return (
        picomatch.isMatch(normalized, globPattern, options) ||
        picomatch.isMatch(normalized, `**/${globPattern}`, options)
      );
    }
    const base = C.uriToPath(globPattern.baseUri?.uri || globPattern.baseUri);
    if (!base) return false;
    const relative = path.relative(base, filePath);
    // An absolute result means the two paths share no root at all — a different
    // Windows drive or UNC server — which `..` does not express.
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    return picomatch.isMatch(relative.replaceAll("\\", "/"), globPattern.pattern, options);
  }
  // Watched-file events are limited to paths under the project roots â€” that is
  // the scope of lumine.project.onDidChangeFiles.
  routeFileEvents(events) {
    for (const [session, registrations] of this.dynamicCapabilities) {
      if (session.state !== "running") continue;
      const watchers = [];
      for (const item of registrations.values())
        if (item.method === "workspace/didChangeWatchedFiles")
          watchers.push(...(item.registerOptions?.watchers || []));
      if (!watchers.length) continue;
      const changes = [];
      const push = (filePath, type) => {
        const kindBit = type === 1 ? 1 : type === 2 ? 2 : 4;
        const matched = watchers.some(
          (watcher) =>
            ((watcher.kind ?? 7) & kindBit) !== 0 &&
            this.globMatches(watcher.globPattern, filePath),
        );
        if (matched) changes.push({ uri: C.pathToUri(filePath), type });
      };
      for (const event of events) {
        if (event.action === "created") push(event.path, 1);
        else if (event.action === "modified") push(event.path, 2);
        else if (event.action === "deleted") push(event.path, 3);
        else if (event.action === "renamed") {
          if (event.oldPath) push(event.oldPath, 3);
          push(event.path, 1);
        }
      }
      if (changes.length) session.notify("workspace/didChangeWatchedFiles", { changes });
    }

    for (const session of this.allSessions()) {
      if (session.state !== "running") continue;
      const operations = session.capabilities?.workspace?.fileOperations;
      if (!operations) continue;

      const created = [];
      const deleted = [];
      const renamed = [];
      for (const event of events) {
        if (
          event.action === "created" &&
          this.fileOperationMatches(operations.didCreate?.filters, event.path)
        ) {
          created.push({ uri: C.pathToUri(event.path) });
        } else if (
          event.action === "deleted" &&
          this.fileOperationMatches(operations.didDelete?.filters, event.path)
        ) {
          deleted.push({ uri: C.pathToUri(event.path) });
        } else if (
          event.action === "renamed" &&
          event.oldPath &&
          (this.fileOperationMatches(operations.didRename?.filters, event.oldPath) ||
            this.fileOperationMatches(operations.didRename?.filters, event.path))
        ) {
          renamed.push({ oldUri: C.pathToUri(event.oldPath), newUri: C.pathToUri(event.path) });
        }
      }
      if (created.length) session.notify("workspace/didCreateFiles", { files: created });
      if (deleted.length) session.notify("workspace/didDeleteFiles", { files: deleted });
      if (renamed.length) session.notify("workspace/didRenameFiles", { files: renamed });
    }
  }
  fileOperationMatches(filters, filePath) {
    if (!Array.isArray(filters) || !filters.length || !filePath) return false;
    const normalized = filePath.replaceAll("\\", "/");
    return filters.some((filter) => {
      if (filter.scheme && filter.scheme !== "file") return false;
      const pattern = filter.pattern;
      if (!pattern?.glob) return false;
      const options = { dot: true, nocase: !!pattern.options?.ignoreCase };
      return (
        picomatch.isMatch(normalized, pattern.glob, options) ||
        picomatch.isMatch(normalized, `**/${pattern.glob}`, options)
      );
    });
  }
  projectPathsChanged() {
    const roots = lumine.project.getPaths();
    const toFolder = (root) => ({ uri: C.pathToUri(root), name: path.basename(root) });
    const added = roots.filter((root) => !this.knownRoots.includes(root)).map(toFolder);
    const removed = this.knownRoots.filter((root) => !roots.includes(root)).map(toFolder);
    this.knownRoots = roots;
    // Only a workspace-scoped session answers for the project as a whole. The
    // others hear about exactly the folders they take on or lose, from
    // `adoptFolder` and `reconcileProjects`.
    if (added.length || removed.length) {
      for (const session of this.allSessions()) {
        if (
          session.state === "running" &&
          session.adapter.sessionScope === "workspace" &&
          session.capabilities.workspace?.workspaceFolders?.changeNotifications
        )
          session.notify("workspace/didChangeWorkspaceFolders", { event: { added, removed } });
      }
    }
    this.reconcileProjects();
    this.rerouteEditorsToTheirRoots();
    // A notebook whose session was reclaimed with a departed root needs a
    // replacement under its new root, same as the file editors above.
    this.notebookDocuments?.reattachAll();
  }
  // Which session serves an editor follows from its root, so adding or
  // removing a project folder can move it. A file that gained a root belongs
  // to that root's session now rather than the one keyed to its own directory,
  // and a file whose root was just removed has had its server stopped from
  // under it by `reconcileProjects` and needs another.
  rerouteEditorsToTheirRoots() {
    for (const editor of lumine.workspace.getTextEditors()) {
      const filePath = editor.getPath();
      if (!filePath) continue;
      const key = C.uriKey(C.pathToUri(filePath));
      const wanted = new Set(this.sessionsForEditor(editor));
      const attached = this.allSessions().filter((session) => session.documents.has(key));
      if (attached.length !== wanted.size || attached.some((session) => !wanted.has(session))) {
        this.reattachEditor(editor);
      } else if (!attached.length) {
        this.attachEditor(editor);
      }
    }
  }
  pushSettingsForAdapter(adapter) {
    for (const session of this.allSessions())
      if (session.adapter === adapter && session.state === "running") session.pushSettings();
  }
  handleProgress(session, { token, value }) {
    if (!value) return;
    const titles = session.progressTitles;
    if (value.kind === "begin") {
      const base = `${session.adapter.displayName}: ${value.title}`;
      titles.set(token, { base, current: base });
      this.busyProvider?.add(base);
    } else if (value.kind === "report") {
      const entry = titles.get(token);
      if (!entry || !value.message) return;
      const next = `${entry.base} (${value.message})`;
      this.busyProvider?.changeTitle(next, entry.current);
      entry.current = next;
    } else if (value.kind === "end") {
      const entry = titles.get(token);
      if (!entry) return;
      titles.delete(token);
      this.busyProvider?.remove(entry.current);
    }
    this.log(session, `progress ${value.kind}: ${value.title || value.message || token}`);
  }
  clearProgress(session) {
    for (const entry of session.progressTitles.values()) this.busyProvider?.remove(entry.current);
    session.progressTitles.clear();
  }
  log(session, message) {
    const id = session.adapter?.id || "unknown";
    const entries = this.logs.get(id) || [];
    entries.push(`[${new Date().toISOString()}] ${String(message).trim()}`);
    if (entries.length > 2000) entries.shift();
    this.logs.set(id, entries);
    this.emitter.emit("did-log", { session, message });
  }
  getLog(adapterId) {
    return (this.logs.get(adapterId) || []).join("\n");
  }
  showMessage(type, message) {
    const methods = { 1: "addError", 2: "addWarning", 3: "addInfo", 4: "addInfo" };
    lumine.notifications[methods[type] || "addInfo"](message);
  }
  async showMessageRequest(type, message, actions) {
    const buttons = actions.map((action) => action.title).concat("Cancel");
    const selected = await lumine.window.confirm({
      type: type === 1 ? "error" : type === 2 ? "warning" : "info",
      message,
      buttons,
    });
    return selected < actions.length ? actions[selected] : null;
  }
  async showDocument({ uri, selection, external, takeFocus }) {
    try {
      if (external) {
        lumine.shell.openExternal(uri);
        return { success: true };
      }
      const resolved = this.resolveUri(uri);
      if (!resolved) return { success: false };
      if (resolved.kind === "cell") {
        // The notebook's own reveal, when the bridge supplied one; the range
        // is cell-relative either way.
        if (resolved.record.show) {
          await resolved.record.show({
            cellId: resolved.cellId,
            range: selection && C.rangeFromLsp(selection),
            takeFocus: takeFocus !== false,
          });
          return { success: true };
        }
        if (selection && resolved.editor?.setSelectedBufferRange)
          resolved.editor.setSelectedBufferRange(C.rangeFromLsp(selection), { autoscroll: true });
        return { success: true };
      }
      const editor = await lumine.workspace.open(resolved.path, {
        activateItem: takeFocus !== false,
      });
      if (selection && editor?.setSelectedBufferRange)
        editor.setSelectedBufferRange(C.rangeFromLsp(selection), { autoscroll: true });
      return { success: true };
    } catch {
      return { success: false };
    }
  }
  async applyWorkspaceEdit(edit, label, session = null) {
    const documentChanges =
      edit.documentChanges ||
      Object.entries(edit.changes || {}).map(([uri, edits]) => ({ textDocument: { uri }, edits }));
    const destructive = documentChanges.some(
      (change) => change.kind === "delete" || change.kind === "rename",
    );
    if (destructive) {
      const choice = await lumine.window.confirm({
        type: "warning",
        message: label || "The language server wants to rename or delete files",
        detail: "Review your version-control diff after applying this operation.",
        buttons: ["Apply", "Cancel"],
      });
      if (choice !== 0) return false;
    }
    try {
      for (const change of documentChanges) {
        if (change.kind === "create") {
          const target = C.uriToPath(change.uri);
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          if (!change.options?.ignoreIfExists || !fs.existsSync(target))
            await fs.promises.writeFile(target, "", {
              flag: change.options?.overwrite ? "w" : "wx",
            });
          continue;
        }
        if (change.kind === "rename") {
          await fs.promises.rename(C.uriToPath(change.oldUri), C.uriToPath(change.newUri));
          continue;
        }
        if (change.kind === "delete") {
          const target = C.uriToPath(change.uri);
          await fs.promises.rm(target, {
            recursive: !!change.options?.recursive,
            force: !!change.options?.ignoreIfNotExists,
          });
          continue;
        }
        const resolved = this.resolveUri(change.textDocument?.uri);
        if (!resolved) continue;
        let editor;
        if (resolved.kind === "cell") {
          // Cell-relative LSP ranges are the cell buffer's own ranges —
          // identity, no translation. A cell that closed mid-flight resolves
          // to nothing and its edits are skipped, like a file that never opened.
          editor = resolved.editor;
        } else {
          editor =
            lumine.workspace.getTextEditors().find((item) => item.getPath() === resolved.path) ||
            (await lumine.workspace.open(resolved.path, { activateItem: false, pending: true }));
        }
        // An open can decline — an unreadable path, a full workspace center —
        // and an edit cannot be applied to a file that never opened.
        if (!editor || editor.isDestroyed?.()) continue;
        editor.transact(() =>
          [...change.edits]
            .sort(
              (a, b) =>
                b.range.start.line - a.range.start.line ||
                b.range.start.character - a.range.start.character,
            )
            .forEach((textEdit) =>
              editor.setTextInBufferRange(
                C.rangeFromLsp(textEdit.range),
                session?.restoreDocumentText(textEdit.newText, editor, change.textDocument?.uri) ??
                  textEdit.newText,
              ),
            ),
        );
      }
      return true;
    } catch (error) {
      lumine.notifications.addError("Language server edit failed", {
        detail: error.message,
        dismissable: true,
      });
      return false;
    }
  }
  // fn({session}) — fired once when a server has exited more times than it may
  // be restarted. Nothing is going to happen after this, so it is the last
  // chance to say so: the reason a server keeps dying is in its log, and until
  // this the only sign was a status item quietly reading "failed".
  onDidExhaustRestarts(fn) {
    return this.emitter.on("did-exhaust-restarts", fn);
  }
  // A crashed server is restarted on a timer, and how many times depends on how
  // long it managed to stay up rather than on how many exits this window has
  // seen. A restart replaces the session, so the failure run has to be carried
  // across the replacements or it is never longer than one: that is what left a
  // server dying on every start restarting for ever, reading "failed" in the
  // status bar and "restarted 1×" in its details, and never reaching the limit
  // that would have told the user to go and read its log.
  scheduleRestart(session) {
    // One retry in flight at a time. A start that fails reaches this from the
    // exit handler and from the caller that awaited it, and two live timers
    // would double the servers with every round.
    if (this.restartTimers.has(session)) return;
    // The run ends where the server proved it can stay up. Everything after a
    // healthy stretch is a fresh incident with its full complement of retries.
    if (session.runningSince != null && Date.now() - session.runningSince >= HEALTHY_UPTIME_MS) {
      session.failureCount = 0;
      session.gaveUp = false;
    }
    const limit = lumine.config.get("ide-client.restartLimit");
    if (session.failureCount >= limit) {
      // Reached again on every later exit; the user needs telling once.
      if (!session.gaveUp) {
        session.gaveUp = true;
        this.emitter.emit("did-exhaust-restarts", { session });
      }
      return;
    }
    const delay = Math.min(1000 * 2 ** session.failureCount++, 30000);
    this.restartTimers.set(
      session,
      setTimeout(async () => {
        this.restartTimers.delete(session);
        const keys = this.keysFor(session);
        if (!keys.length) return;
        try {
          await this.restart(session, { retry: true });
        } catch (error) {
          this.log(session, error.stack || error);
          // The replacement is already in the map when its own start is what
          // failed, and it — not the session it took over from — is what the
          // next retry has to be counted against. A replacement whose process
          // exited has scheduled its own retry already, which the guard above
          // leaves standing.
          this.scheduleRestart(this.sessions.get(keys[0]) ?? session);
        }
      }, delay),
    );
  }
  cancelRestart(session) {
    clearTimeout(this.restartTimers.get(session));
    this.restartTimers.delete(session);
  }
  cancelRestarts() {
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
  }
  // `retry` marks the automatic restarts, which continue the failure run that
  // led here. A restart somebody asked for starts a new one: the user acted, and
  // whatever they fixed deserves the same patience the first start had.
  async restart(session, { retry = false } = {}) {
    const keys = this.keysFor(session);
    await session.stop();
    const launch = await session.adapter.resolveServer(
      this.adapterContext(session.adapter, session.rootPath),
    );
    // `null` is how an adapter says the server is not installed — the same
    // answer `attachEditor` honours by not starting anything. Restarting has to
    // honour it too: building a session around no launch and starting it fails
    // deep inside with "Cannot destructure property 'command' of 'this.launch'",
    // which says nothing about the binary being gone.
    if (!launch) {
      this.forget(session);
      this.log(session, `${session.adapter.displayName} is not available; not restarting`);
      return null;
    }
    const replacement = new ServerSession(this, session.adapter, session.rootPath, launch);
    // The replacement inherits the folders, so every editor the old session
    // served finds it under the same key.
    replacement.folders = new Set(session.folders);
    // It is the same server as far as the user and the supervisor are
    // concerned: the details say how often it has been restarted under them,
    // and an automatic retry carries the failure run it belongs to.
    replacement.restartCount = session.restartCount + 1;
    replacement.failureCount = retry ? session.failureCount : 0;
    for (const key of keys) this.sessions.set(key, replacement);
    this.didChangeSession(replacement);
    replacement.ready = replacement.start();
    replacement.ready.catch(() => {});
    await replacement.ready;
    await this.reattachAll();
    return replacement;
  }
  // Both take a session out of the map and shut it down; what differs is who
  // hears about a failure. `disconnect` is for a stop somebody asked for and
  // rejects, so the caller can report it. `reclaim` runs where nothing awaits
  // the result — a timer, a disposable, a project that changed under a server —
  // so a failure is logged rather than left as an unhandled rejection.
  async disconnect(session) {
    this.forget(session);
    await session.stop();
  }
  reclaim(session) {
    this.forget(session);
    return this.stopSession(session);
  }
  // A session outlives the editors it serves on purpose: reopening a file in a
  // project should not pay for another server start. That only holds while
  // something can still reach it — a session rooted at a project path waits for
  // the next editor there. One rooted at a lone file's directory, opened with
  // no project, can never be reached again once that editor is gone, so it is
  // shut down instead of idling for the life of the window.
  didCloseDocument(session) {
    if (this.idleChecks.has(session)) return;
    const timer = setTimeout(() => {
      this.idleChecks.delete(session);
      this.stopIfUnreachable(session);
      // Long enough that closing an editor to immediately reopen it — a save
      // under a new name, a grammar change — does not restart the server.
    }, IDLE_SHUTDOWN_MS);
    this.idleChecks.set(session, timer);
  }
  stopIfUnreachable(session) {
    if (session.state === "stopped" || session.state === "stopping") return;
    if (session.documents.size > 0) return;
    const roots = lumine.project.getPaths();
    // A workspace-scoped session answers for every root, so it stays warm as
    // long as the window has one, whatever its own `rootPath` says. Any other
    // session waits for the next editor under a folder it still answers for.
    if (
      session.adapter.sessionScope === "workspace"
        ? roots.length
        : [...session.folders].some((folder) => roots.includes(folder))
    )
      return;
    const stillServesAnEditor = lumine.workspace
      .getTextEditors()
      .some((editor) => this.sessionsForEditor(editor).includes(session));
    if (stillServesAnEditor) return;
    this.reclaim(session);
  }
  cancelIdleChecks() {
    for (const timer of this.idleChecks.values()) clearTimeout(timer);
    this.idleChecks.clear();
  }
  // A folder that left the project takes its key with it. A session that held
  // more than one survives on the folders it has left; one that held only the
  // departed folder has nothing to answer for and stops.
  reconcileProjects() {
    const roots = lumine.project.getPaths();
    for (const session of this.allSessions()) {
      if (session.adapter.sessionScope === "workspace") continue;
      const gone = [...session.folders].filter((folder) => !roots.includes(folder));
      if (!gone.length) continue;
      if (gone.length === session.folders.size) {
        this.reclaim(session);
        continue;
      }
      for (const folder of gone) {
        session.folders.delete(folder);
        this.sessions.delete(this.keyFor(session.adapter, folder));
      }
      if (!session.folders.has(session.rootPath)) [session.rootPath] = session.folders;
      session.notify("workspace/didChangeWorkspaceFolders", {
        event: { added: [], removed: gone.map((folder) => this.folderOf(folder)) },
      });
    }
  }
  // Teardown must not be abortable: one server that cannot be shut down cleanly
  // — a broken pipe, a process already gone — must not strand the servers beside
  // it or the cleanup that follows them, so the failure is reported rather than
  // thrown. See `reclaim` for which callers want this and which want to hear it.
  async stopSession(session) {
    try {
      await session.stop();
    } catch (error) {
      console.error(
        `ide-client: failed to stop ${session?.adapter?.id ?? "a language server"}`,
        error,
      );
    }
  }
  async stopAllSessions() {
    this.cancelRestarts();
    await Promise.all(this.allSessions().map((session) => this.stopSession(session)));
    this.sessions.clear();
  }
  // The net under a teardown that never reached `deactivate` — a crashed
  // renderer being reloaded. Every orderly unload stops its sessions properly
  // first, which empties the map and leaves this a no-op. See
  // `ServerSession#kill` for why what is left is killed rather than asked to
  // shut down.
  killAllSessions() {
    this.cancelRestarts();
    for (const session of this.allSessions()) {
      try {
        session.kill();
      } catch (error) {
        console.error(
          `ide-client: failed to kill ${session?.adapter?.id ?? "a language server"}`,
          error,
        );
      }
    }
    this.sessions.clear();
  }
  async deactivate() {
    this.cancelIdleChecks();
    this.subscriptions.dispose();
    for (const subs of this.editorSubscriptions.values()) subs.dispose();
    this.editorSubscriptions.clear();
    for (const subs of this.adapterSubscriptions.values()) subs.dispose();
    this.adapterSubscriptions.clear();
    await this.stopAllSessions();
    this.emitter.dispose();
  }
};
