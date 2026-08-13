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
    expect(resolves).toBe(2);
    expect(manager.allSessions().length).toBe(1);
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
    manager.registerAdapter({
      id: "test",
      displayName: "Test",
      grammarScopes: [editor.getGrammar().scopeName],
      resolveServer: async () => null,
    });
    const root = lumine.project.getPaths()[0];
    const session = sessionAt(root);
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
    // Two keys, one server — everything that walks the sessions must see one.
    expect(manager.allSessions().length).toBe(1);
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
      { action: "modified", path: tsPath },
      { action: "created", path: pyPath },
      { action: "renamed", path: tsPath, oldPath: path.join("C:", "project", "old.ts") },
    ]);
    expect(notifications.length).toBe(1);
    const changes = notifications[0].params.changes;
    // kind 5 = create | delete: the "modified" event and the .py file are filtered out.
    expect(changes.map((change) => change.type)).toEqual([1, 3, 1]);
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
            didRename: { filters: [markdownFilter] },
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
      {
        action: "renamed",
        oldPath: path.join(root, "before.md"),
        path: path.join(root, "after.md"),
      },
    ]);

    expect(notifications.map(({ method }) => method)).toEqual([
      "workspace/didCreateFiles",
      "workspace/didDeleteFiles",
      "workspace/didRenameFiles",
    ]);
    expect(notifications[0].params.files).toEqual([
      { uri: C.pathToUri(path.join(root, "New.MD")) },
    ]);
    expect(notifications[1].params.files).toEqual([
      { uri: C.pathToUri(path.join(root, "old.markdown")) },
    ]);
    expect(notifications[2].params.files).toEqual([
      {
        oldUri: C.pathToUri(path.join(root, "before.md")),
        newUri: C.pathToUri(path.join(root, "after.md")),
      },
    ]);
    manager.sessions.clear();
  });

  it("advertises exactly the file operations it routes", () => {
    expect(manager.buildClientCapabilities().workspace.fileOperations).toEqual({
      dynamicRegistration: false,
      didCreate: true,
      didRename: true,
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

    await manager.restart(session);

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
