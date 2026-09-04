const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const ServerSession = require("../lib/server-session");
const { languageIdForEditor } = require("../lib/language-ids");
const C = require("../lib/converters");

// Lets an awaited chain that a fake-clock timer started run to its end. The
// timers are faked, so nothing here waits on real time; only the microtasks
// between one `await` and the next need letting through.
const flushPromises = async () => {
  for (let tick = 0; tick < 50; tick++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("LanguageServerManager adapters", () => {
  let manager;
  beforeEach(() => {
    manager = new LanguageServerManager();
  });
  afterEach(async () => manager.deactivate());
  it("validates adapters", () =>
    expect(() => manager.registerAdapter({ id: "bad" })).toThrowError(/grammarScopes/));
  it("rejects duplicate IDs and disposes registrations", () => {
    const adapter = {
      id: "test",
      displayName: "Test",
      grammarScopes: ["source.test"],
      resolveServer: async () => null,
    };
    const registration = manager.registerAdapter(adapter);
    expect(() => manager.registerAdapter(adapter)).toThrowError(/already registered/);
    registration.dispose();
    expect(manager.adapters.has("test")).toBe(false);
  });
  it("reports which adapters cover an editor, and says when the set changes", async () => {
    // What a package that stands down while a server covers the same ground
    // reads: the registration, not a session, so it is settled before any
    // server has started.
    const adapter = {
      id: "test",
      displayName: "Test",
      grammarScopes: ["source.test"],
      resolveServer: async () => null,
    };
    const editor = { getGrammar: () => ({ scopeName: "source.test" }), getPath: () => null };
    const other = { getGrammar: () => ({ scopeName: "source.other" }), getPath: () => null };
    const changes = [];
    manager.onDidChangeAdapters((event) => changes.push(event));

    expect(manager.adaptersForEditor(editor)).toEqual([]);
    manager.registerAdapter(adapter);
    expect(manager.adaptersForEditor(editor)).toEqual([adapter]);
    expect(manager.adaptersForEditor(other)).toEqual([]);
    expect(changes).toEqual([{ adapter, registered: true }]);

    await manager.unregisterAdapter(adapter);
    expect(manager.adaptersForEditor(editor)).toEqual([]);
    expect(changes[1]).toEqual({ adapter, registered: false });
  });
  it("restarts instead of pushing settings when a changed key belongs to both lists", async () => {
    const adapter = {
      id: "test",
      displayName: "Test",
      grammarScopes: ["source.test"],
      resolveServer: async () => null,
      settingsKeyPaths: ["ide-client"],
      restartKeyPaths: ["ide-client.trace"],
    };
    spyOn(manager, "restartAdapter").and.returnValue(Promise.resolve([]));
    spyOn(manager, "pushSettingsForAdapter");
    const registration = manager.registerAdapter(adapter);

    lumine.config.set("ide-client.trace", "messages");

    expect(manager.restartAdapter).toHaveBeenCalledWith(adapter, { reportErrors: true });
    expect(manager.pushSettingsForAdapter).not.toHaveBeenCalled();
    registration.dispose();
    lumine.config.unset("ide-client.trace");
  });
  it("pushes the newest dynamic settings once after a slow start reaches running", async () => {
    const rootPath = path.join(path.sep, "tmp", "project");
    const adapter = { id: "test", displayName: "Test", grammarScopes: ["source.test"] };
    const session = {
      adapter,
      rootPath,
      folders: new Set([rootPath]),
      state: "starting",
      settingsRevision: 0,
      pushSettings: jasmine.createSpy("pushSettings").and.resolveTo(),
      stop: async () => {},
    };
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    const controller = manager.controllerForSession(session, true);

    manager.pushSettingsForAdapter(adapter);
    manager.pushSettingsForAdapter(adapter);
    expect(session.pushSettings).not.toHaveBeenCalled();
    session.state = "running";
    manager.didChangeSession(session);
    await flushPromises();

    expect(session.pushSettings.calls.count()).toBe(1);
    expect(session.settingsRevision).toBe(2);
    expect(controller.settingsPromise).toBeNull();
  });
  it("drains a settings revision bumped just before the previous guard clears", async () => {
    const pushed = deferred();
    const rootPath = path.join(path.sep, "tmp", "project");
    const adapter = { id: "test", displayName: "Test", grammarScopes: ["source.test"] };
    const session = {
      adapter,
      rootPath,
      folders: new Set([rootPath]),
      state: "running",
      settingsRevision: 0,
      pushSettings: jasmine
        .createSpy("pushSettings")
        .and.callFake(() =>
          session.pushSettings.calls.count() === 1 ? pushed.promise : Promise.resolve(),
        ),
      stop: async () => {},
    };
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    const controller = manager.controllerForSession(session, true);

    manager.pushSettingsForAdapter(adapter);
    pushed.promise.then(() => manager.pushSettingsForAdapter(adapter));
    pushed.resolve();
    await flushPromises();

    expect(session.pushSettings.calls.count()).toBe(2);
    expect(session.settingsRevision).toBe(2);
    expect(controller.settingsPromise).toBeNull();
  });
  it("drains a newer settings revision after the previous push rejects", async () => {
    const pushed = deferred();
    const rootPath = path.join(path.sep, "tmp", "project");
    const adapter = { id: "test", displayName: "Test", grammarScopes: ["source.test"] };
    const session = {
      adapter,
      rootPath,
      folders: new Set([rootPath]),
      state: "running",
      settingsRevision: 0,
      pushSettings: jasmine
        .createSpy("pushSettings")
        .and.callFake(() =>
          session.pushSettings.calls.count() === 1 ? pushed.promise : Promise.resolve(),
        ),
      stop: async () => {},
    };
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    const controller = manager.controllerForSession(session, true);
    spyOn(manager, "log");
    const notification = spyOn(lumine.notifications, "addError");

    manager.pushSettingsForAdapter(adapter);
    pushed.promise.catch(() => manager.pushSettingsForAdapter(adapter));
    pushed.reject(new Error("old settings push failed"));
    await flushPromises();

    expect(session.pushSettings.calls.count()).toBe(2);
    expect(session.settingsRevision).toBe(2);
    expect(controller.settingsPromise).toBeNull();
    expect(manager.log.calls.count()).toBe(1);
    expect(notification.calls.count()).toBe(1);
  });
  it("reports a failed settings revision once and waits for a newer revision", async () => {
    const rootPath = path.join(path.sep, "tmp", "project");
    const adapter = { id: "test", displayName: "Test", grammarScopes: ["source.test"] };
    const session = {
      adapter,
      rootPath,
      folders: new Set([rootPath]),
      state: "running",
      settingsRevision: 0,
      pushSettings: jasmine
        .createSpy("pushSettings")
        .and.returnValues(Promise.reject(new Error("settings failed")), Promise.resolve()),
      stop: async () => {},
    };
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    const controller = manager.controllerForSession(session, true);
    spyOn(manager, "log");
    const notification = spyOn(lumine.notifications, "addError");

    manager.pushSettingsForAdapter(adapter);
    await flushPromises();
    await flushPromises();

    expect(session.pushSettings.calls.count()).toBe(1);
    expect(session.settingsRevision).toBe(0);
    expect(controller.settingsPromise).toBeNull();
    expect(notification.calls.count()).toBe(1);

    manager.pushSettingsForAdapter(adapter);
    await flushPromises();

    expect(session.pushSettings.calls.count()).toBe(2);
    expect(session.settingsRevision).toBe(2);
    expect(notification.calls.count()).toBe(1);
  });
  it("reports one shared resolver failure for parallel editor attaches", async () => {
    const rootPath = lumine.project.getPaths()[0];
    const error = new Error("shared resolve failure");
    const adapter = {
      id: "test",
      displayName: "Test",
      grammarScopes: ["source.test"],
      resolveServer: jasmine.createSpy("resolveServer").and.rejectWith(error),
    };
    manager.adapters.set(adapter.id, adapter);
    const report = spyOn(manager, "reportStartFailure").and.callThrough();
    const notification = spyOn(lumine.notifications, "addError");
    const editor = (name) => ({
      getPath: () => path.join(rootPath, name),
      getGrammar: () => ({ scopeName: "source.test" }),
    });
    const editors = [editor("a.test"), editor("b.test")];
    spyOn(lumine.workspace, "getTextEditors").and.returnValue(editors);

    await Promise.all(editors.map((item) => manager.attachAdapter(adapter, item)));

    expect(adapter.resolveServer.calls.count()).toBe(1);
    expect(report.calls.count()).toBe(1);
    expect(notification.calls.count()).toBe(1);
    expect(manager.allSessions()).toEqual([]);
  });
  it("reports and cleans one shared start failure for parallel editor attaches", async () => {
    const rootPath = lumine.project.getPaths()[0];
    const adapter = {
      id: "test",
      displayName: "Test",
      grammarScopes: ["source.test"],
      resolveServer: async () => ({ command: "server" }),
    };
    manager.adapters.set(adapter.id, adapter);
    const start = spyOn(ServerSession.prototype, "start").and.rejectWith(
      new Error("shared start failure"),
    );
    const stop = spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    const report = spyOn(manager, "reportStartFailure").and.callThrough();
    const notification = spyOn(lumine.notifications, "addError");
    const editor = (name) => ({
      getPath: () => path.join(rootPath, name),
      getGrammar: () => ({ scopeName: "source.test" }),
    });
    const editors = [editor("a.test"), editor("b.test")];
    spyOn(lumine.workspace, "getTextEditors").and.returnValue(editors);

    await Promise.all(editors.map((item) => manager.attachAdapter(adapter, item)));
    await flushPromises();

    expect(start.calls.count()).toBe(1);
    expect(stop.calls.count()).toBe(1);
    expect(report.calls.count()).toBe(1);
    expect(notification.calls.count()).toBe(1);
    expect(manager.allSessions()).toEqual([]);
    expect(manager.controllers.size).toBe(0);
  });
  it("quarantines a replacement adapter until the old same-id child exits", async () => {
    const rootPath = path.join(path.sep, "tmp", "project");
    const oldAdapter = {
      id: "test",
      displayName: "Old Test",
      grammarScopes: ["source.old-test"],
      resolveServer: async () => null,
    };
    manager.registerAdapter(oldAdapter);
    const oldSession = {
      adapter: oldAdapter,
      rootPath,
      folders: new Set([rootPath]),
      state: "running",
      processExited: false,
      process: { exitCode: null, signalCode: null },
      stop: jasmine.createSpy("old.stop").and.callFake(async () => {
        oldSession.state = "stopped";
        manager.didChangeSession(oldSession);
        throw new Error("old child survived stop");
      }),
    };
    manager.sessions.set(manager.keyFor(oldAdapter, rootPath), oldSession);
    manager.controllerForSession(oldSession, true);
    manager.ownedSessions.add(oldSession);
    spyOn(console, "error");
    await manager.unregisterAdapter(oldAdapter);

    const newAdapter = {
      id: "test",
      displayName: "New Test",
      grammarScopes: ["source.new-test"],
      resolveServer: jasmine.createSpy("resolveServer").and.resolveTo({ command: "new-server" }),
    };
    manager.registerAdapter(newAdapter);
    const start = spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    const ensuring = manager.ensureSession(newAdapter, rootPath);
    await flushPromises();

    expect(newAdapter.resolveServer).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    oldSession.processExited = true;
    manager.didExitProcess(oldSession);

    const replacement = await ensuring;
    expect(newAdapter.resolveServer.calls.count()).toBe(1);
    expect(start.calls.count()).toBe(1);
    expect(replacement.adapter).toBe(newAdapter);
  });
});

describe("LanguageServerManager external documents", () => {
  let manager;
  const notebookPath = path.resolve("proj", "nb.ipynb");
  const record = () => ({
    filePath: notebookPath,
    notebookType: "jupyter-notebook",
    cellIndexOf: (cellId) => (cellId === "c1" ? 0 : -1),
  });
  const cellEditor = () => ({
    getGrammar: () => ({ scopeName: "source.python" }),
    getPath: () => null,
    getRootScopeDescriptor: () => null,
  });

  beforeEach(() => {
    manager = new LanguageServerManager();
  });
  afterEach(async () => manager.deactivate());

  it("routes a bound editor to its cell URI and back", () => {
    const editor = cellEditor();
    const uri = C.cellUri(notebookPath, "c1");
    manager.registerExternalDocument(editor, { editor, uri, cellId: "c1", record: record() });

    expect(manager.uriForEditor(editor)).toBe(uri);
    const resolved = manager.resolveUri(uri);
    expect(resolved.kind).toBe("cell");
    expect(resolved.editor).toBe(editor);
    expect(resolved.notebookPath).toBe(notebookPath);
    expect(resolved.cellIndex).toBe(0);

    manager.unregisterExternalDocument(editor);
    expect(manager.uriForEditor(editor)).toBeNull();
    expect(manager.resolveUri(uri)).toBeNull();
  });

  it("resolves file URIs to paths and declines the rest", () => {
    const filePath = path.resolve("proj", "a.py");
    expect(manager.resolveUri(C.pathToUri(filePath))).toEqual({ kind: "file", path: filePath });
    expect(manager.resolveUri("untitled:Untitled-1")).toBeNull();
  });

  it("hands a plain editor its file URI unchanged", () => {
    const filePath = path.resolve("proj", "a.py");
    const editor = { getPath: () => filePath };
    expect(manager.uriForEditor(editor)).toBe(C.pathToUri(filePath));
    expect(manager.uriForEditor({ getPath: () => null })).toBeNull();
  });

  it("asks only sessions that hold the cell document about a cell", () => {
    // Two same-root servers on one grammar; only the notebook-syncing one saw
    // the notebook, and the other must never be asked about a cell URI.
    const adapterA = {
      id: "with-sync",
      displayName: "A",
      grammarScopes: ["source.python"],
      resolveServer: async () => null,
    };
    const adapterB = {
      id: "without-sync",
      displayName: "B",
      grammarScopes: ["source.python"],
      resolveServer: async () => null,
    };
    manager.registerAdapter(adapterA);
    manager.registerAdapter(adapterB);
    const root = manager.rootForPath(notebookPath, adapterA);
    const uri = C.cellUri(notebookPath, "c1");
    const holding = {
      adapter: adapterA,
      rootPath: root,
      state: "running",
      documents: new Map([[C.uriKey(uri), {}]]),
      folders: new Set([root]),
      stop: async () => {},
    };
    const notHolding = {
      adapter: adapterB,
      rootPath: root,
      state: "running",
      documents: new Map(),
      folders: new Set([root]),
      stop: async () => {},
    };
    manager.sessions.set(manager.keyFor(adapterA, root), holding);
    manager.sessions.set(manager.keyFor(adapterB, root), notHolding);

    const editor = cellEditor();
    manager.registerExternalDocument(editor, { editor, uri, cellId: "c1", record: record() });
    expect(manager.sessionsForEditor(editor)).toEqual([holding]);
  });

  it("matches notebook-aware document selectors for bound editors", () => {
    const editor = cellEditor();
    const uri = C.cellUri(notebookPath, "c1");
    manager.registerExternalDocument(editor, { editor, uri, cellId: "c1", record: record() });
    const session = { adapter: { id: "test", grammarScopes: ["source.python"] } };

    // Scheme now follows the document, not a hard-coded "file".
    expect(manager.selectorMatches([{ scheme: "vscode-notebook-cell" }], session, editor)).toBe(
      true,
    );
    expect(manager.selectorMatches([{ scheme: "file" }], session, editor)).toBe(false);
    // The LSP 3.17 notebook filter shape.
    expect(
      manager.selectorMatches(
        [{ notebook: { scheme: "file", notebookType: "jupyter-notebook" }, language: "python" }],
        session,
        editor,
      ),
    ).toBe(true);
    expect(
      manager.selectorMatches(
        [{ notebook: { notebookType: "other-notebook" }, language: "python" }],
        session,
        editor,
      ),
    ).toBe(false);
    expect(manager.selectorMatches([{ notebook: "jupyter-notebook" }], session, editor)).toBe(true);
    // A notebook filter never matches a plain file editor.
    const fileEditor = {
      getGrammar: () => ({ scopeName: "source.python" }),
      getPath: () => path.resolve("proj", "a.py"),
    };
    expect(manager.selectorMatches([{ notebook: "jupyter-notebook" }], session, fileEditor)).toBe(
      false,
    );
    // Patterns run against the notebook's path for a cell.
    expect(manager.selectorMatches([{ pattern: "**/*.ipynb" }], session, editor)).toBe(true);
  });

  it("starts one session for concurrent ensureSession calls", async () => {
    // No real child process: the race under test is between resolveServer
    // completions, not the handshake.
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    let resolves = 0;
    const adapter = {
      id: "test",
      displayName: "Test",
      grammarScopes: ["source.test"],
      resolveServer: async () => {
        resolves++;
        await Promise.resolve();
        return { command: "fake-server" };
      },
    };
    manager.registerAdapter(adapter);
    const root = path.resolve("proj");
    const [first, second] = await Promise.all([
      manager.ensureSession(adapter, root),
      manager.ensureSession(adapter, root),
    ]);
    expect(first).toBe(second);
    expect(resolves).toBe(1);
    expect(manager.allSessions().length).toBe(1);
  });

  it("opens a restored editor before exposing its running session to features", async () => {
    const root = lumine.project.getPaths()[0];
    const editor = await lumine.workspace.open(path.join(root, "restored.test"));
    const adapter = {
      id: "restored",
      displayName: "Restored",
      grammarScopes: [editor.getGrammar().scopeName],
      resolveServer: async () => null,
    };
    manager.adapters.set(adapter.id, adapter);
    const uri = manager.uriForEditor(editor);
    const session = {
      adapter,
      rootPath: root,
      state: "running",
      ready: Promise.resolve(),
      folders: new Set([root]),
      documents: new Map(),
      openEditor: jasmine.createSpy("openEditor").and.callFake(async () => {
        session.documents.set(C.uriKey(uri), { editor, uri });
      }),
      stop: async () => {},
    };
    manager.sessions.set(manager.keyFor(adapter, root), session);

    expect(await manager.activeSessionsForEditor(editor)).toEqual([session]);
    expect(session.openEditor).toHaveBeenCalledOnceWith(editor);
    editor.destroy();
  });
});

describe("LanguageServerManager session lifetime", () => {
  let manager;
  const sessionAt = (rootPath) => {
    const session = {
      adapter: { id: "test", displayName: "Test", grammarScopes: ["source.test"] },
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    };
    manager.sessions.set(`test:${rootPath}`, session);
    return session;
  };

  beforeEach(() => {
    manager = new LanguageServerManager();
  });
  afterEach(async () => manager.deactivate());

  it("reclaims a session rooted outside the project once its last editor closes", () => {
    // What opening a lone file with no project folder produces: the root is
    // the file's own directory, so nothing will ever ask for this session
    // again.
    const session = sessionAt(path.join(path.sep, "tmp", "loose"));
    manager.didCloseDocument(session);
    advanceClock(1000);
    expect(session.stop).toHaveBeenCalled();
    expect(manager.sessions.size).toBe(0);
  });

  it("reclaims one that cannot be stopped without rejecting at nobody", async () => {
    // The reclaim runs from a timer, so a rejection here reaches no caller and
    // would be reported to the user as an unhandled one instead.
    spyOn(console, "error");
    const session = sessionAt(path.join(path.sep, "tmp", "loose"));
    session.stop.and.returnValue(Promise.reject(new Error("broken pipe")));

    manager.didCloseDocument(session);
    advanceClock(1000);
    await Promise.resolve();

    expect(session.stop).toHaveBeenCalled();
    expect(manager.sessions.size).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps a session rooted at a project path warm", () => {
    const [root] = lumine.project.getPaths();
    expect(root).toBeDefined();
    const session = sessionAt(root);
    manager.didCloseDocument(session);
    advanceClock(1000);
    // Reopening a file in the project must not pay for another server start.
    expect(session.stop).not.toHaveBeenCalled();
    expect(manager.sessions.size).toBe(1);
  });

  it("keeps a session whose documents came back before the grace period", () => {
    const session = sessionAt(path.join(path.sep, "tmp", "loose"));
    manager.didCloseDocument(session);
    // A save under a new name closes and reopens the document.
    session.documents.set("file:///tmp/loose/a.test", {});
    advanceClock(1000);
    expect(session.stop).not.toHaveBeenCalled();
  });

  it("gives an editor a new server when its root leaves the project", async () => {
    const editor = await lumine.workspace.open(path.join(lumine.project.getPaths()[0], "a.test"));
    spyOn(manager, "reattachEditor");
    spyOn(manager, "attachEditor");

    // The session serving it was stopped by reconcileProjects when the root
    // went away, leaving the still-open editor with nothing.
    manager.rerouteEditorsToTheirRoots();
    expect(manager.attachEditor).toHaveBeenCalledWith(editor);
    editor.destroy();
  });

  it("moves an editor onto the session of the root it just gained", async () => {
    const filePath = path.join(lumine.project.getPaths()[0], "b.test");
    const editor = await lumine.workspace.open(filePath);
    // Attached to a session keyed to its own directory, as it would be when
    // opened before any project folder existed.
    const loose = sessionAt(path.dirname(filePath));
    loose.documents.set(C.uriKey(require("url").pathToFileURL(filePath).href), {});
    spyOn(manager, "reattachEditor");

    manager.rerouteEditorsToTheirRoots();
    expect(manager.reattachEditor).toHaveBeenCalledWith(editor);
    editor.destroy();
  });

  it("leaves an editor alone when its root did not change", async () => {
    const filePath = path.join(lumine.project.getPaths()[0], "c.test");
    const editor = await lumine.workspace.open(filePath);
    const adapter = {
      id: "test",
      displayName: "Test",
      grammarScopes: [editor.getGrammar().scopeName],
      resolveServer: async () => null,
    };
    manager.registerAdapter(adapter);
    const root = lumine.project.getPaths()[0];
    const session = sessionAt(root);
    session.adapter = adapter;
    session.documents.set(C.uriKey(require("url").pathToFileURL(filePath).href), {});
    spyOn(manager, "reattachEditor");
    spyOn(manager, "attachEditor");

    // Already on the right session: no didClose/didOpen churn for every open
    // editor each time a folder is added.
    manager.rerouteEditorsToTheirRoots();
    expect(manager.reattachEditor).not.toHaveBeenCalled();
    expect(manager.attachEditor).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("reroutes editors whenever the project paths change", () => {
    spyOn(manager, "rerouteEditorsToTheirRoots");
    manager.knownRoots = [];
    manager.projectPathsChanged();
    expect(manager.rerouteEditorsToTheirRoots).toHaveBeenCalled();
  });

  it("keeps one session for a workspace-scoped adapter however the roots move", () => {
    const adapter = {
      id: "ws",
      displayName: "Workspace",
      grammarScopes: ["source.test"],
      sessionScope: "workspace",
      resolveServer: async () => null,
    };
    const [root] = lumine.project.getPaths();
    const other = path.join(path.sep, "tmp", "other");
    // The identity of a window-wide server must not depend on which root
    // happens to sort first, or removing a folder silently starts a second one.
    expect(manager.keyFor(adapter, root)).toBe(manager.keyFor(adapter, other));
    expect(manager.keyFor({ ...adapter, sessionScope: undefined }, root)).not.toBe(
      manager.keyFor({ ...adapter, sessionScope: undefined }, other),
    );
  });

  it("keeps a workspace-scoped session warm although its own root left", () => {
    const session = sessionAt(path.join(path.sep, "tmp", "gone"));
    session.adapter.sessionScope = "workspace";
    expect(lumine.project.getPaths().length).toBeGreaterThan(0);
    manager.didCloseDocument(session);
    advanceClock(1000);
    // It still answers for the roots that remain.
    expect(session.stop).not.toHaveBeenCalled();
  });

  it("drops pending checks when the package deactivates", async () => {
    const session = sessionAt(path.join(path.sep, "tmp", "loose"));
    manager.didCloseDocument(session);
    expect(manager.idleChecks.size).toBe(1);
    await manager.deactivate();
    expect(manager.idleChecks.size).toBe(0);
  });

  it("cancels a pending first resolution when its project root is removed", async () => {
    const resolution = deferred();
    const [root] = lumine.project.getPaths();
    const adapter = {
      id: "pending",
      displayName: "Pending",
      grammarScopes: ["source.pending-never-open"],
      resolveServer: () => resolution.promise,
    };
    manager.registerAdapter(adapter);
    manager.knownRoots = [root];
    const starting = manager.ensureSession(adapter, root);
    const start = spyOn(ServerSession.prototype, "start");
    spyOn(lumine.project, "getPaths").and.returnValue([]);

    manager.projectPathsChanged();
    resolution.resolve({ command: "too-late" });

    expect(await starting).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(manager.controllers.size).toBe(0);
  });

  it("keeps a pending resolution when an unrelated project root changes", async () => {
    const resolution = deferred();
    const root = path.join(path.sep, "tmp", "kept");
    const other = path.join(path.sep, "tmp", "other");
    const adapter = {
      id: "pending",
      displayName: "Pending",
      grammarScopes: ["source.pending-never-open"],
      resolveServer: () => resolution.promise,
    };
    manager.registerAdapter(adapter);
    manager.knownRoots = [root];
    spyOn(lumine.project, "getPaths").and.returnValue([root, other]);
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    const starting = manager.ensureSession(adapter, root);

    manager.projectPathsChanged();
    resolution.resolve({ command: "server" });

    const session = await starting;
    expect(session).not.toBeNull();
    expect(session.rootPath).toBe(root);
    expect(manager.sessionForRoute(adapter, root)).toBe(session);
  });
});

describe("LanguageServerManager multi-root servers", () => {
  let manager, adapter, notifications;
  const rootA = path.join(path.sep, "tmp", "a");
  const rootB = path.join(path.sep, "tmp", "b");
  const MULTI_ROOT = {
    workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
  };
  const sessionAt = (rootPath, capabilities) => {
    const session = {
      adapter,
      rootPath,
      state: "running",
      capabilities,
      documents: new Map(),
      folders: new Set([rootPath]),
      ready: Promise.resolve(),
      notify: (method, params) => notifications.push({ method, params }),
      stop: jasmine.createSpy("stop"),
    };
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    return session;
  };

  beforeEach(() => {
    manager = new LanguageServerManager();
    notifications = [];
    adapter = { id: "test", displayName: "Test", grammarScopes: ["source.test"] };
  });
  afterEach(async () => manager.deactivate());

  it("hands a second folder to a server that declares multi-root support", async () => {
    const first = sessionAt(rootA, MULTI_ROOT);
    const adopted = await manager.adoptFolder(adapter, rootB, manager.keyFor(adapter, rootB));
    // No second process: the running server is told about the folder.
    expect(adopted).toBe(first);
    expect(manager.sessions.get(manager.keyFor(adapter, rootB))).toBe(first);
    expect(first.folders.has(rootB)).toBe(true);
    expect(notifications[0].method).toBe("workspace/didChangeWorkspaceFolders");
    expect(notifications[0].params.event.added.map((f) => f.name)).toEqual([path.basename(rootB)]);
    expect(manager.workspaceFolders(first).map(({ uri }) => uri)).toEqual([
      C.pathToUri(rootA),
      C.pathToUri(rootB),
    ]);
    // Two keys, one server — everything that walks the sessions must see one.
    expect(manager.allSessions().length).toBe(1);
  });

  it("splits adopted folders when a replacement loses multi-root support", async () => {
    const session = sessionAt(rootA, MULTI_ROOT);
    await manager.adoptFolder(adapter, rootB, manager.keyFor(adapter, rootB));
    const controller = manager.controllerForSession(session, true);
    session.capabilities = {};

    manager.splitUnsupportedFolders(controller, session);

    expect([...session.folders]).toEqual([rootA]);
    expect(manager.controllerForRoute(adapter, rootA)).toBe(controller);
    expect(manager.controllerForRoute(adapter, rootB)).not.toBe(controller);
    expect(manager.sessions.has(manager.keyFor(adapter, rootB))).toBe(false);
  });

  it("cancels a pending controller displaced by multi-root adoption", async () => {
    const resolution = deferred();
    adapter.resolveServer = jasmine.createSpy("resolveServer").and.returnValue(resolution.promise);
    const shared = sessionAt(rootA, MULTI_ROOT);
    const sharedController = manager.controllerForSession(shared, true);
    const displaced = manager.createController(adapter, rootB);
    displaced.explicitDemand = true;
    const hiddenRestart = manager.requestControllerRestart(displaced, { force: true });

    await manager.adoptFolder(adapter, rootB);

    expect(displaced.cancelled).toBe(true);
    expect(manager.controllers.has(displaced)).toBe(false);
    expect(manager.controllerForRoute(adapter, rootB)).toBe(sharedController);
    expect(await hiddenRestart).toBeNull();
    resolution.resolve({ command: "too-late" });
    await flushPromises();
    expect(manager.allSessions()).toEqual([shared]);
  });

  it("starts a separate server when the running one cannot take folders", async () => {
    // No `workspaceFolders` capability: this server resolves its configuration
    // from the single root it was started with.
    sessionAt(rootA, {});
    const adopted = await manager.adoptFolder(adapter, rootB, manager.keyFor(adapter, rootB));
    expect(adopted).toBe(null);
    expect(manager.sessions.has(manager.keyFor(adapter, rootB))).toBe(false);
    expect(notifications).toEqual([]);
  });

  it("refuses to adopt when the server takes the list only at initialize", async () => {
    sessionAt(rootA, { workspace: { workspaceFolders: { supported: true } } });
    expect(await manager.adoptFolder(adapter, rootB, manager.keyFor(adapter, rootB))).toBe(null);
  });

  it("offers the folder to a running server before resolving a new one", async () => {
    const root = lumine.project.getPaths()[0];
    const editor = await lumine.workspace.open(path.join(root, "x.test"));
    adapter = {
      id: "adopt",
      displayName: "Adopt",
      grammarScopes: [editor.getGrammar().scopeName],
      resolveServer: jasmine.createSpy("resolveServer").and.returnValue(Promise.resolve(null)),
    };
    manager.adapters.set(adapter.id, adapter);
    const existing = sessionAt(rootA, MULTI_ROOT);
    existing.openEditor = jasmine.createSpy("openEditor");

    await manager.attachAdapter(adapter, editor);
    // The attach path has to go through the adoption, not just be able to.
    expect(adapter.resolveServer).not.toHaveBeenCalled();
    expect(existing.folders.has(root)).toBe(true);
    expect(existing.openEditor).toHaveBeenCalledWith(editor);
    editor.destroy();
  });

  it("keeps a shared server when only one of its folders leaves the project", async () => {
    const session = sessionAt(rootA, MULTI_ROOT);
    await manager.adoptFolder(adapter, rootB, manager.keyFor(adapter, rootB));
    notifications.length = 0;
    spyOn(lumine.project, "getPaths").and.returnValue([rootA]);

    manager.reconcileProjects();
    expect(session.stop).not.toHaveBeenCalled();
    expect(manager.sessions.has(manager.keyFor(adapter, rootB))).toBe(false);
    expect([...session.folders]).toEqual([rootA]);
    expect(notifications[0].params.event.removed.map((f) => f.name)).toEqual([
      path.basename(rootB),
    ]);
  });

  it("stops a shared server once its last folder leaves the project", async () => {
    const session = sessionAt(rootA, MULTI_ROOT);
    await manager.adoptFolder(adapter, rootB, manager.keyFor(adapter, rootB));
    spyOn(lumine.project, "getPaths").and.returnValue([]);

    manager.reconcileProjects();
    expect(session.stop).toHaveBeenCalled();
    expect(manager.sessions.size).toBe(0);
  });
});

describe("LanguageServerManager capabilities", () => {
  let manager;
  beforeEach(() => {
    manager = new LanguageServerManager();
  });
  afterEach(async () => manager.deactivate());

  it("merges fragments over the base without mutating either", () => {
    manager.addCapabilityFragment({ textDocument: { hover: { contentFormat: ["markdown"] } } });
    manager.addCapabilityFragment({ textDocument: { hover: { dynamicRegistration: true } } });
    const first = manager.buildClientCapabilities();
    expect(first.textDocument.hover).toEqual({
      contentFormat: ["markdown"],
      dynamicRegistration: true,
    });
    expect(first.general.positionEncodings).toEqual(["utf-16"]);
    const second = manager.buildClientCapabilities();
    expect(second.textDocument.hover).toEqual(first.textDocument.hover);
  });

  it("picks the running session that serves the request, not the first one", async () => {
    // Two servers on one grammar is normal — a type checker beside a linter —
    // and taking session[0] means whichever adapter registered first answers,
    // which is activation order and says nothing about who can serve it.
    const sessionWith = (id, capabilities) => {
      const adapter = {
        id,
        displayName: id,
        grammarScopes: ["source.js"],
        resolveServer: async () => null,
      };
      const session = new ServerSession(manager, adapter, "/root", {});
      session.state = "running";
      session.capabilities = capabilities;
      session.ready = Promise.resolve();
      return session;
    };
    const linter = sessionWith("ide-a", {});
    const checker = sessionWith("ide-b", { typeHierarchyProvider: true });
    spyOn(manager, "sessionsForEditor").and.returnValue([linter, checker]);

    const editor = {
      getGrammar: () => ({ scopeName: "source.js", name: "JavaScript" }),
      getPath: () => path.join("C:", "project", "x.js"),
      getRootScopeDescriptor: () => ["source.js"],
    };
    const uri = manager.uriForEditor(editor);
    for (const session of [linter, checker]) {
      spyOn(session, "openEditor").and.callFake(async () => {
        session.documents.set(C.uriKey(uri), { editor, uri });
      });
    }
    expect(await manager.activeSessionForFeature(editor, "textDocument/prepareTypeHierarchy")).toBe(
      checker,
    );
    // Nothing running serves it: null, rather than a session that cannot.
    expect(await manager.activeSessionForFeature(editor, "textDocument/prepareCallHierarchy")).toBe(
      null,
    );
  });

  it("matches string and relative glob patterns", () => {
    const filePath = path.join("C:", "project", "src", "main.ts");
    expect(manager.globMatches("**/*.ts", filePath)).toBe(true);
    expect(manager.globMatches("*.ts", filePath)).toBe(true);
    expect(manager.globMatches("**/*.py", filePath)).toBe(false);
    const base = require("url").pathToFileURL(path.join("C:", "project")).href;
    expect(manager.globMatches({ baseUri: base, pattern: "src/*.ts" }, filePath)).toBe(true);
    expect(manager.globMatches({ baseUri: base, pattern: "lib/*.ts" }, filePath)).toBe(false);
  });

  it("honours Windows path casing in server-supplied capability globs", () => {
    const editorPath = "C:\\Project\\src\\main.js";
    const serverPattern = "c:/project/src/main.js";
    expect(manager.globMatches(serverPattern, editorPath)).toBe(process.platform === "win32");
  });

  it("scopes dynamic registrations by document selector", () => {
    const session = { adapter: { grammarScopes: ["source.python"] } };
    manager.registerCapabilities(session, [
      {
        id: "reg-1",
        method: "textDocument/formatting",
        registerOptions: { documentSelector: [{ language: "python" }] },
      },
    ]);
    const pythonEditor = {
      getGrammar: () => ({ scopeName: "source.python", name: "Python" }),
      getPath: () => "x.py",
    };
    const jsEditor = {
      getGrammar: () => ({ scopeName: "source.js", name: "JavaScript" }),
      getPath: () => "x.js",
    };
    expect(manager.dynamicSupport(session, "textDocument/formatting", pythonEditor)).toBe(true);
    expect(manager.dynamicSupport(session, "textDocument/formatting", jsEditor)).toBe(false);
    expect(manager.dynamicSupport(session, "textDocument/hover", jsEditor)).toBeUndefined();
    manager.unregisterCapabilities(session, [{ id: "reg-1" }]);
    expect(
      manager.dynamicSupport(session, "textDocument/formatting", pythonEditor),
    ).toBeUndefined();
  });

  it("announces a capability that arrives after the session started", () => {
    // The feature modules hold rendered state and only re-read on an event. A
    // late registration that announced nothing left them concluding the server
    // could not serve it — which is how Tinymist's semantic tokens rendered
    // nothing at all while the server was answering perfectly.
    const session = { adapter: { grammarScopes: ["source.typst"] } };
    const announced = [];
    manager.onDidChangeCapabilities((event) => announced.push(event.session));

    manager.registerCapabilities(session, [
      { id: "reg-1", method: "textDocument/semanticTokens", registerOptions: {} },
    ]);
    manager.unregisterCapabilities(session, [{ id: "reg-1" }]);
    // Nothing changed, so nothing is announced.
    manager.registerCapabilities(session, []);

    expect(announced).toEqual([session, session]);
  });

  it("carries the options a dynamic registration was made with", () => {
    // A server that registers dynamically declares nothing statically, so the
    // legend, the trigger characters and the like live only here. Tinymist
    // registers its semantic tokens this way, and reading `capabilities` alone
    // found no legend, which left the feature rendering nothing at all.
    const session = { adapter: { grammarScopes: ["source.typst"] } };
    const legend = { tokenTypes: ["keyword", "string"], tokenModifiers: [] };
    manager.registerCapabilities(session, [
      { id: "reg-tokens", method: "textDocument/semanticTokens", registerOptions: { legend } },
    ]);
    const editor = {
      getGrammar: () => ({ scopeName: "source.typst", name: "Typst" }),
      getPath: () => "x.typ",
    };

    expect(manager.dynamicOptions(session, "textDocument/semanticTokens", editor).legend).toBe(
      legend,
    );
    expect(manager.dynamicOptions(session, "textDocument/hover", editor)).toBeUndefined();

    manager.unregisterCapabilities(session, [{ id: "reg-tokens" }]);
    expect(manager.dynamicOptions(session, "textDocument/semanticTokens", editor)).toBeUndefined();
  });

  it("routes watched-file events through registered watchers", () => {
    const notifications = [];
    const session = {
      state: "running",
      adapter: { grammarScopes: [] },
      notify: (method, params) => notifications.push({ method, params }),
    };
    manager.registerCapabilities(session, [
      {
        id: "watch-1",
        method: "workspace/didChangeWatchedFiles",
        registerOptions: { watchers: [{ globPattern: "**/*.ts", kind: 5 }] },
      },
    ]);
    const tsPath = path.join("C:", "project", "a.ts");
    const pyPath = path.join("C:", "project", "b.py");
    manager.routeFileEvents([
      { action: "created", path: tsPath },
      { action: "updated", path: tsPath },
      { action: "created", path: pyPath },
      { action: "deleted", path: path.join("C:", "project", "old.ts") },
    ]);
    expect(notifications.length).toBe(1);
    const changes = notifications[0].params.changes;
    // kind 5 = create | delete: the "updated" event and the .py file are filtered out.
    expect(changes.map((change) => change.type)).toEqual([1, 3]);

    manager.unregisterCapabilities(session, [{ id: "watch-1" }]);
    manager.registerCapabilities(session, [
      {
        id: "watch-2",
        method: "workspace/didChangeWatchedFiles",
        registerOptions: { watchers: [{ globPattern: "**/*.ts" }] },
      },
    ]);
    manager.routeFileEvents([{ action: "updated", path: tsPath }]);
    expect(notifications.at(-1).params.changes).toEqual([{ uri: C.pathToUri(tsPath), type: 2 }]);
  });

  it("routes file operations through the server's static filters", () => {
    const notifications = [];
    const markdownFilter = {
      scheme: "file",
      pattern: {
        glob: "**/*.{md,markdown}",
        matches: "file",
        options: { ignoreCase: true },
      },
    };
    const session = {
      state: "running",
      adapter: { grammarScopes: [] },
      capabilities: {
        workspace: {
          fileOperations: {
            didCreate: { filters: [markdownFilter] },
            didDelete: { filters: [markdownFilter] },
          },
        },
      },
      notify: (method, params) => notifications.push({ method, params }),
    };
    manager.sessions.set("fake:root", session);
    const root = path.join("C:", "project");
    manager.routeFileEvents([
      { action: "created", path: path.join(root, "New.MD") },
      { action: "created", path: path.join(root, "ignored.txt") },
      { action: "deleted", path: path.join(root, "old.markdown") },
    ]);

    expect(notifications.map(({ method }) => method)).toEqual([
      "workspace/didCreateFiles",
      "workspace/didDeleteFiles",
    ]);
    expect(notifications[0].params.files).toEqual([
      { uri: C.pathToUri(path.join(root, "New.MD")) },
    ]);
    expect(notifications[1].params.files).toEqual([
      { uri: C.pathToUri(path.join(root, "old.markdown")) },
    ]);
    manager.sessions.clear();
  });

  it("advertises exactly the file operations it routes", () => {
    expect(manager.buildClientCapabilities().workspace.fileOperations).toEqual({
      dynamicRegistration: false,
      didCreate: true,
      didDelete: true,
    });
  });

  it("notifies running sessions about workspace folder changes", () => {
    const notifications = [];
    const session = {
      state: "running",
      adapter: { sessionScope: "workspace", grammarScopes: [] },
      capabilities: { workspace: { workspaceFolders: { changeNotifications: true } } },
      notify: (method, params) => notifications.push({ method, params }),
      stop: () => {},
    };
    manager.sessions.set("fake:root", session);
    manager.knownRoots = [];
    manager.projectPathsChanged();
    const roots = lumine.project.getPaths();
    if (roots.length) {
      expect(notifications[0].method).toBe("workspace/didChangeWorkspaceFolders");
      expect(notifications[0].params.event.added.length).toBe(roots.length);
    }
    expect(manager.knownRoots).toEqual(roots);
    manager.sessions.clear();
  });
});

describe("LanguageServerManager diagnostics", () => {
  let manager;
  let session;
  const uri = "file:///project/main.test";

  beforeEach(() => {
    manager = new LanguageServerManager();
    // Keyed the way a real session keys it, so a server's own spelling of the
    // same file finds this document.
    session = { documents: new Map([[C.uriKey(uri), { version: 4 }]]) };
  });

  afterEach(async () => manager.deactivate());

  it("accepts diagnostics for the current document version", () => {
    manager.publishDiagnostics(session, { uri, version: 4, diagnostics: [{ message: "current" }] });
    expect(manager.diagnosticsFor(session, uri)[0].message).toBe("current");
  });

  it("drops versioned diagnostics for any other document snapshot", () => {
    const published = jasmine.createSpy("published");
    manager.onDidPublishDiagnostics(published);
    manager.publishDiagnostics(session, { uri, version: 3, diagnostics: [{ message: "old" }] });
    manager.publishDiagnostics(session, { uri, version: 5, diagnostics: [{ message: "future" }] });

    expect(manager.diagnosticsFor(session, uri)).toEqual([]);
    expect(published).not.toHaveBeenCalled();
  });

  it("accepts unversioned diagnostics and diagnostics for unopened files", () => {
    manager.publishDiagnostics(session, { uri, diagnostics: [{ message: "unversioned" }] });
    const unopened = "file:///project/other.test";
    manager.publishDiagnostics(session, {
      uri: unopened,
      version: 12,
      diagnostics: [{ message: "workspace" }],
    });

    expect(manager.diagnosticsFor(session, uri)[0].message).toBe("unversioned");
    expect(manager.diagnosticsFor(session, unopened)[0].message).toBe("workspace");
  });

  it("finds them again under the client's spelling of the same file", () => {
    // Pyright echoes `file:///c%3A/…ASILOI~1/…` for the
    // `file:///C:/…ASILOI%7E1/…` it was given. Stored under one and looked up
    // under the other, every lookup came back empty — which is what the
    // intentions provider reads to give a server the diagnostic it should fix,
    // so quick fixes were offered no context at all.
    const fromClient = "file:///C:/Users/ASILOI%7E1/project/greeter.py";
    const fromServer = "file:///c%3A/Users/ASILOI~1/project/greeter.py";
    const windows = { documents: new Map([[C.uriKey(fromClient), { version: 1 }]]) };

    manager.publishDiagnostics(windows, {
      uri: fromServer,
      diagnostics: [{ message: '"Path" is not defined' }],
    });

    expect(manager.diagnosticsFor(windows, fromClient)[0].message).toBe('"Path" is not defined');
    expect(manager.diagnosticCountFor(windows)).toEqual({ total: 1, files: 1 });
  });

  it("reports the server's own spelling back to consumers", () => {
    // The linter turns the URI it receives into a file path, so rewriting it to
    // the canonical key would hand it something that is not a URI at all.
    const published = [];
    manager.onDidPublishDiagnostics((event) => published.push(event.uri));
    const fromServer = "file:///c%3A/Users/ASILOI~1/project/greeter.py";
    const windows = { documents: new Map() };

    manager.publishDiagnostics(windows, { uri: fromServer, diagnostics: [{ message: "x" }] });
    manager.clearDiagnosticsForSession(windows);

    expect(published).toEqual([fromServer, fromServer]);
  });

  it("lets the adapter have the last word on what its server reported", () => {
    // ide-json drops "Comments are not permitted in JSON" this way, rather than
    // hiding the comments from the server and having to put them back into
    // every edit that comes home.
    const seen = [];
    const filtered = {
      ...session,
      transformDiagnostics: (diagnostics, publishedUri, document) => {
        seen.push({ uri: publishedUri, version: document?.version });
        return diagnostics.filter(({ code }) => code !== 521);
      },
    };
    const published = [];
    manager.onDidPublishDiagnostics((event) => published.push(event.diagnostics));

    manager.publishDiagnostics(filtered, {
      uri,
      version: 4,
      diagnostics: [{ message: "Comments are not permitted in JSON.", code: 521 }, { code: 519 }],
    });

    // Stored, emitted and counted all read the filtered list: nothing keeps an
    // unfiltered copy that a consumer could reach instead.
    expect(manager.diagnosticsFor(filtered, uri)).toEqual([{ code: 519 }]);
    expect(published).toEqual([[{ code: 519 }]]);
    expect(manager.diagnosticCountFor(filtered)).toEqual({ total: 1, files: 1 });
    expect(seen).toEqual([{ uri, version: 4 }]);
  });

  it("publishes what the server sent when no adapter filters it", () => {
    const untouched = { ...session, transformDiagnostics: () => undefined };
    manager.publishDiagnostics(untouched, { uri, version: 4, diagnostics: [{ code: 519 }] });
    expect(manager.diagnosticsFor(untouched, uri)).toEqual([{ code: 519 }]);
  });
});

describe("LanguageServerManager restart", () => {
  let manager;
  beforeEach(() => {
    manager = new LanguageServerManager();
  });
  afterEach(async () => manager.deactivate());

  // Not `sessionAt`: these are about what the supervisor reads off a session,
  // and every field it reads has to be stated here rather than defaulted.
  const failedSession = (fields = {}) => ({
    adapter: { id: "test", displayName: "Test Language Server" },
    restartCount: 0,
    failureCount: 0,
    runningSince: null,
    state: "failed",
    stop: async () => {},
    ...fields,
  });

  afterEach(() => lumine.config.unset("ide-client.restartLimit"));

  it("says so once when a server has exited more often than it may be restarted", () => {
    // Giving up was silent: the retries stopped, the status item read "failed",
    // and the reason sat unread in the log.
    lumine.config.set("ide-client.restartLimit", 2);
    const session = failedSession({ failureCount: 2 });
    const exhausted = [];
    manager.onDidExhaustRestarts((event) => exhausted.push(event.session));

    manager.scheduleRestart(session);
    // Every later exit reaches this again; the user is told once.
    manager.scheduleRestart(session);
    manager.scheduleRestart(session);

    expect(exhausted).toEqual([session]);
  });

  it("keeps quiet while it still has restarts left", () => {
    lumine.config.set("ide-client.restartLimit", 3);
    const session = failedSession();
    const exhausted = [];
    manager.onDidExhaustRestarts((event) => exhausted.push(event.session));
    manager.scheduleRestart(session);
    expect(exhausted).toEqual([]);
    expect(session.failureCount).toBe(1);
  });

  it("gives up on a server that dies on every start", async () => {
    // The failure run used to live on the session, and a restart replaces the
    // session, so the run was never longer than one: the status bar read
    // "failed", the details read "restarted 1×", and the limit was never
    // reached however often the server died. Driven through the real restart,
    // since carrying the run across the replacements is the whole fix.
    lumine.config.set("ide-client.restartLimit", 3);
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      // What a server that dies during the handshake leaves behind: a failed
      // session, and a rejection for whoever asked for the start.
      this.setState("failed", new Error("Server exited (1)"));
      throw new Error("Server exited (1)");
    });
    const launch = { command: "does-not-exist" };
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: async () => launch,
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = new ServerSession(manager, adapter, rootPath, launch);
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    const exhausted = [];
    manager.onDidExhaustRestarts((event) => exhausted.push(event.session));

    manager.scheduleRestart(session);
    // Longer than the longest backoff, so each round is one whole retry.
    for (let round = 0; round < 5; round++) {
      advanceClock(30000);
      await flushPromises();
    }

    expect(exhausted.length).toBe(1);
    // Three restarts, each of which died again — which is what the user is
    // told, and what the details report about the server that is left.
    expect(exhausted[0].failureCount).toBe(3);
    expect(exhausted[0].restartCount).toBe(3);
    // And nothing keeps trying behind the notification.
    expect(manager.restartTimers.size).toBe(0);
  });

  it("starts a fresh run for a restart somebody asked for", async () => {
    // The user acted — installed the binary, corrected a setting — and what
    // they fixed deserves the same patience the first start had.
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.setState("running");
    });
    const launch = { command: "server" };
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: async () => launch,
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const key = manager.keyFor(adapter, rootPath);
    const session = new ServerSession(manager, adapter, rootPath, launch);
    session.restartCount = 4;
    session.failureCount = 2;
    manager.sessions.set(key, session);

    const restarted = await manager.restart(session);
    expect(restarted).not.toBeNull();

    const replacement = manager.sessions.get(key);
    expect(replacement).not.toBe(session);
    // Still the same server as far as the details are concerned.
    expect(replacement.restartCount).toBe(5);
    expect(replacement.failureCount).toBe(0);
  });

  it("gives a server that stayed up its retries back", () => {
    // A crash after hours of work is not the same incident as the one before
    // it, and counting them together would retire a server over an afternoon
    // weeks earlier.
    lumine.config.set("ide-client.restartLimit", 3);
    const session = failedSession({ failureCount: 3, runningSince: Date.now() });
    const exhausted = [];
    manager.onDidExhaustRestarts((event) => exhausted.push(event.session));
    advanceClock(60000);

    manager.scheduleRestart(session);

    expect(exhausted).toEqual([]);
    expect(session.failureCount).toBe(1);
  });

  it("holds a server that only just started to its remaining retries", () => {
    lumine.config.set("ide-client.restartLimit", 3);
    const session = failedSession({ failureCount: 3, runningSince: Date.now() });
    const exhausted = [];
    manager.onDidExhaustRestarts((event) => exhausted.push(event.session));
    advanceClock(5000);

    manager.scheduleRestart(session);

    expect(exhausted).toEqual([session]);
  });

  it("keeps one retry in flight for a session", () => {
    // A start that fails is reported by the exit handler and by the caller that
    // awaited it. Two timers for one session would double the servers with
    // every round.
    lumine.config.set("ide-client.restartLimit", 3);
    const session = failedSession();
    manager.sessions.set("test:root", session);

    manager.scheduleRestart(session);
    manager.scheduleRestart(session);

    expect(manager.restartTimers.size).toBe(1);
    expect(session.failureCount).toBe(1);
  });

  it("drops a pending retry when the session is forgotten", () => {
    lumine.config.set("ide-client.restartLimit", 3);
    const session = failedSession();
    manager.sessions.set("test:root", session);
    spyOn(manager, "restart");

    manager.scheduleRestart(session);
    manager.forget(session);
    advanceClock(30000);

    expect(manager.restart).not.toHaveBeenCalled();
    expect(manager.restartTimers.size).toBe(0);
  });

  it("declines to restart a server the adapter says is not installed", async () => {
    // `null` is the documented way for an adapter to say the binary is gone,
    // and attaching honours it by starting nothing. Restarting used to build a
    // session around no launch and start it, which failed deep inside with
    // "Cannot destructure property 'command' of 'this.launch'" — a message that
    // says nothing about the binary.
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: async () => null,
    };
    const session = {
      adapter,
      rootPath: path.join(path.sep, "tmp", "project"),
      state: "running",
      documents: new Map(),
      folders: new Set(),
      stop: jasmine.createSpy("stop").and.callFake(async () => {}),
    };
    manager.sessions.set(manager.keyFor(adapter, session.rootPath), session);

    let result;
    let thrown = null;
    try {
      result = await manager.restart(session);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeNull();
    expect(result).toBeNull();
    expect(session.stop).toHaveBeenCalled();
    // Forgotten, so the crash-retry loop stops rather than failing forever.
    expect(manager.keysFor(session)).toEqual([]);
    expect(manager.getLog("test")).toContain("not available");
  });

  it("shares one restart operation for concurrent callers", async () => {
    const resolution = deferred();
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: jasmine.createSpy("resolveServer").and.returnValue(resolution.promise),
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("old.stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    spyOn(manager, "reattachAll").and.callFake(async () => {});

    const first = manager.restart(session);
    const concurrent = manager.restart(session);
    expect(concurrent).toBe(first);
    await Promise.resolve();
    expect(adapter.resolveServer.calls.count()).toBe(1);
    resolution.resolve({ command: "server" });

    const replacement = await first;
    expect(replacement).not.toBe(session);
    expect(session.stop.calls.count()).toBe(1);
    expect(ServerSession.prototype.start.calls.count()).toBe(1);
    expect(manager.restart(session)).not.toBe(first);
    expect(await manager.restart(session)).toBeNull();
  });

  it("restarts after exit delivery times out once the old process has exited", async () => {
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: async () => ({ command: "server" }),
    };
    manager.registerAdapter(adapter);
    const rootPath = path.join(path.sep, "tmp", "project");
    const timeout = Object.assign(new Error("Timed out after 1000ms"), {
      exitNotificationTimedOut: true,
    });
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      processExited: true,
      process: { exitCode: 0, signalCode: null },
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("old.stop").and.rejectWith(timeout),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    manager.controllerForSession(session, true);
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    spyOn(manager, "reattachAll").and.callFake(async () => {});
    const notification = spyOn(lumine.notifications, "addError");

    const [replacement] = await manager.restartAdapter(adapter, { reportErrors: true });
    await flushPromises();

    expect(replacement).not.toBe(session);
    expect(replacement.state).toBe("running");
    expect(notification).not.toHaveBeenCalled();
    expect(manager.getLog("test")).toContain(
      "Exit notification timed out; continuing restart after process exit",
    );
  });

  it("keeps the healthy server when preparing its replacement fails", async () => {
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: async () => {
        throw new Error("bad configured path");
      },
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("stop"),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);

    await expectAsync(manager.restart(session)).toBeRejectedWithError(/bad configured path/);
    expect(session.stop).not.toHaveBeenCalled();
    expect(manager.sessionForRoute(adapter, rootPath)).toBe(session);
  });

  it("cleans up a replacement whose start rejects before surfacing the error", async () => {
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: async () => ({ command: "server" }),
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("old.stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    spyOn(ServerSession.prototype, "start").and.rejectWith(new Error("initialize failed"));
    const stop = spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });

    await expectAsync(manager.restart(session)).toBeRejectedWithError(/initialize failed/);

    expect(stop.calls.count()).toBe(1);
    expect(stop.calls.mostRecent().object.state).toBe("stopped");
    expect(manager.allSessions()).toEqual([]);
  });

  it("preflights initialization options and settings before stopping the old server", async () => {
    const order = [];
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: async () => {
        order.push("resolve");
        return { command: "server" };
      },
      getInitializationOptions: async () => {
        order.push("initializationOptions");
        return { mode: "new" };
      },
      getSettings: async () => {
        order.push("settings");
        throw new Error("invalid settings");
      },
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("stop").and.callFake(async () => order.push("stop")),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);

    await expectAsync(manager.restart(session)).toBeRejectedWithError(/invalid settings/);

    expect(order).toEqual(["resolve", "initializationOptions", "settings"]);
    expect(session.stop).not.toHaveBeenCalled();
    expect(manager.sessionForRoute(adapter, rootPath)).toBe(session);
  });

  it("actively cancels a starting replacement when a newer generation arrives", async () => {
    const hangingStart = deferred();
    let firstReplacement;
    let starts = 0;
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: async () => ({ command: `server-${starts + 1}` }),
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("old.stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    spyOn(ServerSession.prototype, "start").and.callFake(function () {
      starts++;
      if (starts === 1) {
        firstReplacement = this;
        return hangingStart.promise;
      }
      this.state = "running";
      return Promise.resolve();
    });
    const stop = spyOn(ServerSession.prototype, "stop").and.callFake(function () {
      this.state = "stopped";
      if (this === firstReplacement) hangingStart.resolve();
      return Promise.resolve();
    });
    spyOn(manager, "reattachAll").and.callFake(async () => {});

    const restarting = manager.restart(session);
    await flushPromises();
    expect(starts).toBe(1);
    const controller = manager.controllerForSession(firstReplacement);
    const joined = manager.requestControllerRestart(controller, { force: true });

    expect(joined).toBe(restarting);
    expect(stop).toHaveBeenCalledWith();
    expect(firstReplacement.state).toBe("stopped");
    const replacement = await restarting;
    expect(starts).toBe(2);
    expect(replacement).not.toBe(firstReplacement);
    expect(replacement.state).toBe("running");
  });

  it("discards a resolved launch when a newer restart generation exists", async () => {
    const firstResolution = deferred();
    let calls = 0;
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.restart-generation"],
      resolveServer: () => (++calls === 1 ? firstResolution.promise : { command: "new-server" }),
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("old.stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    });
    spyOn(manager, "reattachAll").and.callFake(async () => {});
    manager.registerAdapter(adapter);
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    manager.controllerForSession(session, true);
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });

    const restarting = manager.restartAdapter(adapter);
    const joined = manager.restartAdapter(adapter);
    expect(joined).toBe(restarting);
    firstResolution.resolve({ command: "stale-server" });

    const [replacement] = await restarting;
    expect(calls).toBe(2);
    expect(session.stop.calls.count()).toBe(1);
    expect(replacement.launch.command).toBe("new-server");
    expect(ServerSession.prototype.start.calls.count()).toBe(1);
  });

  it("continues with the latest generation when an obsolete stop rejects", async () => {
    const stopping = deferred();
    let version = "first";
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.stop-generation"],
      resolveServer: jasmine.createSpy("resolveServer").and.callFake(async () => ({
        command: `${version}-server`,
      })),
    };
    manager.registerAdapter(adapter);
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      processExited: true,
      process: { exitCode: null, signalCode: null },
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("old.stop").and.returnValue(stopping.promise),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    manager.controllerForSession(session, true);
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    spyOn(manager, "reattachAll").and.callFake(async () => {});

    const restarting = manager.restartAdapter(adapter);
    await flushPromises();
    expect(session.stop).toHaveBeenCalled();
    version = "latest";
    const joined = manager.restartAdapter(adapter);
    expect(joined).toBe(restarting);
    stopping.reject(new Error("obsolete stop failure"));

    const [replacement] = await restarting;
    expect(adapter.resolveServer.calls.count()).toBe(2);
    expect(session.stop.calls.count()).toBe(1);
    expect(replacement.launch.command).toBe("latest-server");
    expect(replacement.state).toBe("running");
  });

  it("does not start a newer generation when the old process may still be alive", async () => {
    const stopping = deferred();
    let version = "first";
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.live-stop-generation"],
      resolveServer: jasmine.createSpy("resolveServer").and.callFake(async () => ({
        command: `${version}-server`,
      })),
    };
    manager.registerAdapter(adapter);
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      processExited: false,
      process: { exitCode: null, signalCode: null },
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("old.stop").and.returnValue(stopping.promise),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    manager.controllerForSession(session, true);
    const start = spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(manager, "reattachAll").and.callFake(async () => {});

    const restarting = manager.restartAdapter(adapter);
    await flushPromises();
    version = "latest";
    expect(manager.restartAdapter(adapter)).toBe(restarting);
    session.state = "stopped";
    stopping.reject(new Error("old process is still alive"));

    await expectAsync(restarting).toBeRejectedWithError(/old process is still alive/);
    expect(adapter.resolveServer.calls.count()).toBe(1);
    expect(start).not.toHaveBeenCalled();
    expect(manager.allSessions()).toEqual([]);
    const controller = manager.controllerForSession(session);
    expect(controller.blockedByLiveStop).toBe(session);
    controller.explicitDemand = false;
    manager.pruneUndemandedControllers();
    expect(manager.controllerForRoute(adapter, rootPath)).toBe(controller);

    const filePath = path.join(rootPath, "reopened.test");
    const editor = {
      getPath: () => filePath,
      getGrammar: () => ({ scopeName: "source.live-stop-generation" }),
    };
    spyOn(lumine.workspace, "getTextEditors").and.returnValue([editor]);

    version = "after-exit";
    const finalRestart = manager.restartAdapter(adapter);
    const attaching = manager.ensureSession(adapter, rootPath, { filePath });
    await flushPromises();
    expect(adapter.resolveServer.calls.count()).toBe(1);
    expect(start).not.toHaveBeenCalled();
    expect(manager.controllerForRoute(adapter, rootPath)).toBe(controller);

    session.processExited = true;
    manager.didExitProcess(session);
    const [replacement] = await finalRestart;
    expect(await attaching).toBe(replacement);
    expect(adapter.resolveServer.calls.count()).toBe(2);
    expect(start.calls.count()).toBe(1);
    expect(replacement.launch.command).toBe("after-exit-server");
  });

  it("does not reattach an adapter whose restart round failed", async () => {
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.restart-failure"],
      resolveServer: jasmine
        .createSpy("resolveServer")
        .and.rejectWith(new Error("restart preflight failed")),
    };
    manager.registerAdapter(adapter);
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("stop"),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    manager.controllerForSession(session, true);
    const reattach = spyOn(manager, "reattachAll").and.callFake(async () => {});
    const notification = spyOn(lumine.notifications, "addError");

    const restarting = manager.restartAdapter(adapter, { reportErrors: true });
    await expectAsync(restarting).toBeRejectedWithError(/restart preflight failed/);
    await flushPromises();

    expect(adapter.resolveServer.calls.count()).toBe(1);
    expect(session.stop).not.toHaveBeenCalled();
    expect(reattach).not.toHaveBeenCalled();
    expect(notification.calls.count()).toBe(1);
  });

  it("re-preflights when the controller root changes during resolution", async () => {
    const firstResolution = deferred();
    const rootA = path.join(path.sep, "tmp", "a");
    const rootB = path.join(path.sep, "tmp", "b");
    const contexts = [];
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: (context) => {
        contexts.push(context.rootPath);
        return contexts.length === 1
          ? firstResolution.promise
          : { command: "server-from-current-root" };
      },
    };
    const session = failedSession({
      adapter,
      rootPath: rootA,
      state: "running",
      documents: new Map(),
      folders: new Set([rootA, rootB]),
      stop: jasmine.createSpy("old.stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    });
    manager.sessions.set(manager.keyFor(adapter, rootA), session);
    manager.sessions.set(manager.keyFor(adapter, rootB), session);
    const controller = manager.controllerForSession(session, true);
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    spyOn(manager, "reattachAll").and.callFake(async () => {});

    const restarting = manager.restart(session);
    await flushPromises();
    manager.unbindController(controller, rootA);
    controller.rootPath = rootB;
    session.rootPath = rootB;
    manager.markControllerStructureChanged(controller);
    await flushPromises();

    const replacement = await restarting;
    firstResolution.resolve({ command: "stale-root" });
    expect(contexts).toEqual([rootA, rootB]);
    expect(session.stop.calls.count()).toBe(1);
    expect(replacement.rootPath).toBe(rootB);
    expect(replacement.startup.workspaceFolders.map(({ uri }) => uri)).toEqual([
      C.pathToUri(rootB),
    ]);
  });

  it("does not let an automatic retry downgrade a configuration restart", async () => {
    const resolution = deferred();
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: () => resolution.promise,
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("old.stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    spyOn(manager, "reattachAll").and.callFake(async () => {});

    const restarting = manager.restart(session);
    await flushPromises();
    manager.scheduleRestart(session);
    advanceClock(1000);
    await flushPromises();
    const controller = manager.controllerForSession(session);
    expect(controller.desiredRetry).toBe(false);
    resolution.resolve({ command: "configured-server" });

    const replacement = await restarting;
    expect(replacement.failureCount).toBe(0);
    expect(replacement.launch.command).toBe("configured-server");
  });

  it("ignores an old retry timer after a healthy manual replacement is running", async () => {
    const resolution = deferred();
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: jasmine.createSpy("resolveServer").and.returnValue(resolution.promise),
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("old.stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    const start = spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    const stop = spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    spyOn(manager, "reattachAll").and.callFake(async () => {});

    const restarting = manager.restart(session);
    await flushPromises();
    manager.scheduleRestart(session);
    resolution.resolve({ command: "healthy-server" });
    const replacement = await restarting;
    await flushPromises();
    expect(manager.controllerForSession(replacement).restartPromise).toBeNull();

    advanceClock(1000);
    await flushPromises();

    expect(manager.sessionForRoute(adapter, rootPath)).toBe(replacement);
    expect(replacement.state).toBe("running");
    expect(adapter.resolveServer.calls.count()).toBe(1);
    expect(start.calls.count()).toBe(1);
    expect(stop).not.toHaveBeenCalled();
    expect(manager.restartTimers.size).toBe(0);
  });

  it("cancels a restart that is still resolving when the server is disconnected", async () => {
    const resolution = deferred();
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      resolveServer: () => resolution.promise,
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = failedSession({
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      stop: jasmine.createSpy("stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    });
    manager.sessions.set(manager.keyFor(adapter, rootPath), session);
    const start = spyOn(ServerSession.prototype, "start");

    const restarting = manager.restart(session);
    await manager.disconnect(session);
    resolution.resolve({ command: "too-late" });

    expect(await restarting).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(manager.allSessions()).toEqual([]);
    expect(manager.controllers.size).toBe(0);
  });

  it("starts a previously unavailable controller after an adapter restart", async () => {
    let available = false;
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.test"],
      restartKeyPaths: ["test.serverPath"],
      resolveServer: async () => (available ? { command: "server" } : null),
    };
    manager.registerAdapter(adapter);
    const rootPath = path.join(path.sep, "tmp", "project");
    expect(await manager.ensureSession(adapter, rootPath)).toBeNull();
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    available = true;

    await manager.restartAdapter(adapter);

    expect(manager.sessionForRoute(adapter, rootPath)?.state).toBe("running");
  });

  it("does not start a pending project controller after its last editor closes", async () => {
    const resolution = deferred();
    let open = true;
    const rootPath = lumine.project.getPaths()[0];
    const filePath = path.join(rootPath, "pending.test");
    const editor = {
      getPath: () => filePath,
      getGrammar: () => ({ scopeName: "source.pending" }),
    };
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.pending"],
      resolveServer: jasmine.createSpy("resolveServer").and.returnValue(resolution.promise),
    };
    manager.adapters.set(adapter.id, adapter);
    spyOn(lumine.workspace, "getTextEditors").and.callFake(() => (open ? [editor] : []));
    const start = spyOn(ServerSession.prototype, "start");

    const starting = manager.ensureSession(adapter, rootPath, { filePath });
    await flushPromises();
    expect(adapter.resolveServer).toHaveBeenCalled();
    open = false;
    manager.pruneUndemandedControllers();

    expect(await starting).toBeNull();
    resolution.resolve({ command: "too-late" });
    await flushPromises();
    expect(start).not.toHaveBeenCalled();
    expect(manager.controllers.size).toBe(0);
  });

  it("does not revive an unavailable project controller after its demand closes", async () => {
    let open = true;
    let resolves = 0;
    const rootPath = lumine.project.getPaths()[0];
    const filePath = path.join(rootPath, "main.test");
    const editor = {
      getPath: () => filePath,
      getGrammar: () => ({ scopeName: "source.unavailable" }),
    };
    const adapter = {
      id: "test",
      displayName: "Test Language Server",
      grammarScopes: ["source.unavailable"],
      resolveServer: async () => {
        resolves++;
        return null;
      },
    };
    manager.adapters.set(adapter.id, adapter);
    spyOn(lumine.workspace, "getTextEditors").and.callFake(() => (open ? [editor] : []));

    expect(await manager.ensureSession(adapter, rootPath, { filePath })).toBeNull();
    expect(manager.controllers.size).toBe(1);
    open = false;
    await manager.restartAdapter(adapter);

    expect(resolves).toBe(1);
    expect(manager.controllers.size).toBe(0);
    expect(manager.allSessions()).toEqual([]);
  });

  it("does not let a late resolver from an unregistered adapter replace its successor", async () => {
    const oldResolution = deferred();
    const oldAdapter = {
      id: "test",
      displayName: "Old Test",
      grammarScopes: ["source.test"],
      resolveServer: () => oldResolution.promise,
    };
    manager.registerAdapter(oldAdapter);
    const rootPath = path.join(path.sep, "tmp", "project");
    const oldEnsure = manager.ensureSession(oldAdapter, rootPath);
    await manager.unregisterAdapter(oldAdapter);

    const newAdapter = {
      id: "test",
      displayName: "New Test",
      grammarScopes: ["source.test"],
      resolveServer: async () => ({ command: "new-server" }),
    };
    manager.registerAdapter(newAdapter);
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    const current = await manager.ensureSession(newAdapter, rootPath);
    oldResolution.resolve({ command: "old-server" });

    expect(await oldEnsure).toBeNull();
    expect(manager.sessionForRoute(newAdapter, rootPath)).toBe(current);
    expect(manager.sessionForRoute(oldAdapter, rootPath)).toBeNull();
    expect(current.launch.command).toBe("new-server");
  });
});

describe("LanguageServerManager teardown", () => {
  let manager;
  const add = (key, session) => {
    manager.sessions.set(key, session);
    return session;
  };
  const stubSession = (id) => ({
    adapter: { id, displayName: `${id} Server` },
    stop: jasmine.createSpy(`${id}.stop`),
    kill: jasmine.createSpy(`${id}.kill`),
  });

  beforeEach(() => {
    manager = new LanguageServerManager();
    // Activated for real here: the unload teardown is one of its subscriptions.
    manager.activate();
    // Reported per failure, and two of these tests cause one on purpose.
    spyOn(console, "error");
  });

  // Every test above leaves the manager torn down already; this is for the ones
  // that stop at `will-destroy`, which does not touch the subscriptions.
  afterEach(async () => manager.deactivate());

  it("stops every session and empties the map", async () => {
    const first = add("a:/project", stubSession("a"));
    const second = add("b:/project", stubSession("b"));

    await manager.deactivate();

    expect(first.stop).toHaveBeenCalled();
    expect(second.stop).toHaveBeenCalled();
    expect(manager.sessions.size).toBe(0);
  });

  it("finishes tearing down when one session cannot be stopped", async () => {
    // A server whose pipe is already gone, and — as the package's own doubles
    // used to be — an entry that is not a session at all. Either one used to
    // reject the whole `Promise.all`, which left the map full and the manager
    // half torn down while core logged the failure and moved on.
    const rejecting = add("a:/project", {
      adapter: { id: "a" },
      stop: jasmine.createSpy("a.stop").and.returnValue(Promise.reject(new Error("broken pipe"))),
    });
    const foreign = add("b:/project", { adapter: { id: "b" } });
    const healthy = add("c:/project", stubSession("c"));

    await manager.deactivate();

    expect(rejecting.stop).toHaveBeenCalled();
    expect(healthy.stop).toHaveBeenCalled();
    expect(foreign.stop).toBeUndefined();
    expect(manager.sessions.size).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("drops an adapter's sessions even when one of them refuses to stop", async () => {
    // The path an ide-* package takes when it deactivates. Nothing awaits the
    // disposable it drops, so a rejection would only ever be an unhandled one.
    const adapter = {
      id: "test",
      displayName: "Test",
      grammarScopes: ["source.test"],
      resolveServer: async () => null,
    };
    manager.registerAdapter(adapter);
    const rejecting = add("test:/a", {
      adapter,
      stop: jasmine.createSpy("stop").and.returnValue(Promise.reject(new Error("broken pipe"))),
    });
    const healthy = add("test:/b", { adapter, stop: jasmine.createSpy("stop") });

    await manager.unregisterAdapter(adapter);

    expect(rejecting.stop).toHaveBeenCalled();
    expect(healthy.stop).toHaveBeenCalled();
    expect(manager.sessions.size).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("kills the servers when the window goes away without deactivating", () => {
    // An orderly unload deactivates first, which stops the sessions properly and
    // leaves this nothing to do. What it covers is the teardown that never got
    // there — a crashed renderer being reloaded — where a server that outlives
    // its stdin would be orphaned.
    const session = add("a:/project", stubSession("a"));

    lumine.emitter.emit("will-destroy");

    expect(session.kill).toHaveBeenCalled();
    expect(session.stop).not.toHaveBeenCalled();
    expect(manager.sessions.size).toBe(0);
  });

  it("keeps a failing kill from stranding the rest", () => {
    const failing = add("a:/project", {
      adapter: { id: "a" },
      kill: jasmine.createSpy("a.kill").and.throwError("already gone"),
    });
    const healthy = add("b:/project", stubSession("b"));

    lumine.emitter.emit("will-destroy");

    expect(failing.kill).toHaveBeenCalled();
    expect(healthy.kill).toHaveBeenCalled();
    expect(manager.sessions.size).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("does not kill anything a close already stopped", async () => {
    // Both paths run on a window close: `deactivate` first, from
    // `prepareToUnloadEditorWindow`, and `will-destroy` as the window goes. The
    // second must not undo the graceful shutdown the first performed.
    const session = add("a:/project", stubSession("a"));

    await manager.deactivate();
    lumine.emitter.emit("will-destroy");

    expect(session.stop).toHaveBeenCalled();
    expect(session.kill).not.toHaveBeenCalled();
  });

  it("keeps ownership of a logically stopped live child until its real exit", async () => {
    const session = {
      adapter: { id: "live" },
      state: "running",
      processExited: false,
      process: { exitCode: null, signalCode: null },
      stop: jasmine.createSpy("stop").and.callFake(async () => {
        session.state = "stopped";
        manager.didChangeSession(session);
        throw new Error("kill did not terminate child");
      }),
      kill: jasmine.createSpy("kill"),
    };
    add("live:/project", session);
    manager.ownedSessions.add(session);

    await manager.deactivate();

    expect(session.stop).toHaveBeenCalled();
    expect(session.kill).toHaveBeenCalled();
    expect(manager.ownedSessions.has(session)).toBe(true);
    session.processExited = true;
    manager.didExitProcess(session);
    expect(manager.ownedSessions.has(session)).toBe(false);
  });

  it("cancels a resolving restart before the window teardown kills its source", async () => {
    const resolution = deferred();
    const adapter = {
      id: "a",
      displayName: "A Server",
      resolveServer: () => resolution.promise,
    };
    const rootPath = path.join(path.sep, "tmp", "project");
    const session = add("a:/project", {
      adapter,
      rootPath,
      state: "running",
      documents: new Map(),
      folders: new Set([rootPath]),
      restartCount: 0,
      failureCount: 0,
      stop: jasmine.createSpy("stop"),
      kill: jasmine.createSpy("kill"),
    });
    const start = spyOn(ServerSession.prototype, "start");
    const restarting = manager.restart(session);

    lumine.emitter.emit("will-destroy");
    resolution.resolve({ command: "too-late" });

    expect(await restarting).toBeNull();
    expect(session.kill).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(manager.controllers.size).toBe(0);
  });
});

describe("LanguageServerManager server messages", () => {
  let manager, session;
  beforeEach(() => {
    manager = new LanguageServerManager();
    session = { adapter: { id: "test", displayName: "Test Language Server" } };
    spyOn(lumine.notifications, "addError");
    spyOn(lumine.notifications, "addWarning");
  });
  afterEach(async () => manager.deactivate());

  it("names the server a message came from", () => {
    manager.showMessage(2, "Configuration file reloaded.", session);
    const [message, options] = lumine.notifications.addWarning.calls.mostRecent().args;
    expect(message).toBe("Test Language Server: Configuration file reloaded.");
    // One line and nothing under it: a headline is the whole notification.
    expect(options).toBeUndefined();
  });

  it("still names a server it has no session for", () => {
    manager.showMessage(1, "Something failed.", undefined);
    const [message] = lumine.notifications.addError.calls.mostRecent().args;
    expect(message).toBe("Language server: Something failed.");
  });

  it("describes a message that runs past its first line", () => {
    manager.showMessage(
      1,
      [
        "Enumeration of workspace source files is taking longer than 10 seconds.",
        "This may be because:",
        "* You have opened your home directory as a workspace",
        "* Your workspace contains a very large number of files",
        "To reduce this time, open a workspace directory with fewer files.",
      ].join("\n"),
      session,
    );
    const [message, options] = lumine.notifications.addError.calls.mostRecent().args;
    expect(message).toBe(
      "Test Language Server: Enumeration of workspace source files is taking longer than 10 seconds.",
    );
    // The closing sentence is a paragraph of its own. Without the blank line
    // markdown reads it as a continuation of the bullet above it, and it
    // renders inside that bullet.
    expect(options.description).toBe(
      [
        "This may be because:",
        "* You have opened your home directory as a workspace",
        "* Your workspace contains a very large number of files",
        "",
        "To reduce this time, open a workspace directory with fewer files.",
      ].join("\n"),
    );
    // Long enough to scroll, so long enough to outlast the five seconds an
    // undismissable notification gets.
    expect(options.dismissable).toBe(true);
  });
});

describe("languageIdForEditor", () => {
  const editorWith = (scopeName, name) => ({
    getGrammar: () => ({ scopeName, name }),
  });
  it("maps grammar scopes through the table", () => {
    expect(languageIdForEditor({}, editorWith("source.python", "Python"))).toBe("python");
    expect(languageIdForEditor({}, editorWith("source.js", "JavaScript"))).toBe("javascript");
    expect(languageIdForEditor({}, editorWith("text.tex.latex", "LaTeX"))).toBe("latex");
  });
  it("prefers the adapter scope override, then the table, then the blanket id", () => {
    const adapter = {
      languageId: "blanket",
      languageIdForScope: (scope) => (scope === "source.custom" ? "custom" : undefined),
    };
    expect(languageIdForEditor(adapter, editorWith("source.custom", "Custom"))).toBe("custom");
    expect(languageIdForEditor(adapter, editorWith("source.python", "Python"))).toBe("python");
    expect(languageIdForEditor(adapter, editorWith("source.unknown", "Unknown"))).toBe("blanket");
    expect(languageIdForEditor({}, editorWith("source.unknown", "Unknown"))).toBe("unknown");
  });
});
