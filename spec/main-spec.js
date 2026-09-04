const fakeStatusBar = (tiles) => ({
  addRightTile(options) {
    const tile = {
      ...options,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    tiles.push(tile);
    return tile;
  },
});
const ServerSession = require("../lib/server-session");

describe("ide-client package", () => {
  beforeEach(async () => {
    await lumine.packages.activatePackage("ide-client");
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-client");
  });

  it("exposes the versioned language-server service", () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    const service = main.provideIdeClient();
    expect(typeof service.registerAdapter).toBe("function");
    expect(typeof service.adaptersForEditor).toBe("function");
    expect(typeof service.onDidChangeAdapters).toBe("function");
    expect(typeof service.sessionForEditor).toBe("function");
    expect(typeof service.activeSessionsForEditor).toBe("function");
    expect(typeof service.activeSessionForFeature).toBe("function");
    expect(typeof service.applyWorkspaceEdit).toBe("function");
    expect(typeof service.willCreateFiles).toBe("function");
    expect(typeof service.willRenameFiles).toBe("function");
    expect(typeof service.willDeleteFiles).toBe("function");
    expect(typeof service.didCreateFiles).toBe("function");
    expect(typeof service.didRenameFiles).toBe("function");
    expect(typeof service.didDeleteFiles).toBe("function");
    const hyperclick = main.provideHyperclick();
    expect(hyperclick.providerName).toBe("ide-client");
    expect(typeof hyperclick.getSuggestionForWord).toBe("function");
  });

  describe("reporting a missing server", () => {
    const adapterFor = (managedServer) => ({
      id: "ide-missing",
      displayName: "Missing Language Server",
      grammarScopes: ["source.missing"],
      resolveServer: async () => null,
      managedServer,
    });
    const descriptor = {
      source: "github-release",
      displayName: "Missingtool",
      repository: "example/missingtool",
      assetFor: () => null,
      checksum: "none",
      binary: "missingtool",
    };
    let main, service;

    beforeEach(() => {
      main = lumine.packages.getActivePackage("ide-client").mainModule;
      service = main.provideIdeClient();
      lumine.notifications.clear();
    });

    it("warns rather than errors, since an adapter with no server is not broken", () => {
      service.registerAdapter(adapterFor(descriptor));
      const notification = service.reportMissingServer("ide-missing", { description: "why" });
      expect(notification.getType()).toBe("warning");
      expect(notification.getMessage()).toBe("Unable to find Missingtool");
    });

    it("says it once per window however many editors ask", () => {
      service.registerAdapter(adapterFor(descriptor));
      service.reportMissingServer("ide-missing");
      expect(service.reportMissingServer("ide-missing")).toBe(null);
      expect(lumine.notifications.getNotifications().length).toBe(1);
    });

    it("offers Install only when the adapter says where to get the server", () => {
      service.registerAdapter(adapterFor(descriptor));
      const withSource = service.reportMissingServer("ide-missing");
      expect(withSource.getOptions().buttons.map(({ text }) => text)).toEqual([
        "Install Missingtool",
        "Never Ask Again",
      ]);
    });

    it("offers only the opt-out when there is nowhere to install from", () => {
      service.registerAdapter(adapterFor(undefined));
      const notification = service.reportMissingServer("ide-missing");
      expect(notification.getOptions().buttons.map(({ text }) => text)).toEqual([
        "Never Ask Again",
      ]);
    });

    it("stays silent once Never Ask Again has been pressed", () => {
      service.registerAdapter(adapterFor(descriptor));
      const notification = service.reportMissingServer("ide-missing");
      notification.getOptions().buttons.at(-1).onDidClick();
      // Written to the package's settings, so it survives a reload and can be
      // undone on the page it belongs to.
      expect(lumine.config.get("ide-missing.notifyWhenMissing")).toBe(false);

      main.missingReported.clear();
      expect(service.reportMissingServer("ide-missing")).toBe(null);
      lumine.config.unset("ide-missing.notifyWhenMissing");
    });

    // A notification button dismisses nothing on its own, and both of these are
    // terminal, so a banner still asking the question is the whole of what the
    // user sees after answering it.
    it("closes itself once Never Ask Again has been pressed", () => {
      service.registerAdapter(adapterFor(descriptor));
      const notification = service.reportMissingServer("ide-missing");
      notification.getOptions().buttons.at(-1).onDidClick();
      expect(notification.isDismissed()).toBe(true);
      lumine.config.unset("ide-missing.notifyWhenMissing");
    });

    it("closes itself once Install has been pressed", () => {
      service.registerAdapter(adapterFor(descriptor));
      spyOn(main, "installServer").and.returnValue(Promise.resolve());
      const notification = service.reportMissingServer("ide-missing");
      notification.getOptions().buttons.at(0).onDidClick();
      expect(main.installServer).toHaveBeenCalledWith("ide-missing");
      expect(notification.isDismissed()).toBe(true);
    });

    it("is armed again once a session for that adapter starts", () => {
      service.registerAdapter(adapterFor(descriptor));
      service.reportMissingServer("ide-missing");
      expect(main.missingReported.has("ide-missing")).toBe(true);
      // A session exists only because resolveServer found something, so a
      // server removed later is reported once more rather than staying silent.
      main.manager.didChangeSession({ adapter: { id: "ide-missing" }, state: "starting" });
      expect(main.missingReported.has("ide-missing")).toBe(false);
    });

    it("ignores an adapter that is not registered", () => {
      expect(service.reportMissingServer("ide-not-registered")).toBe(null);
    });
  });

  it("registers its workspace commands", () => {
    const commands = lumine.commands.findCommands({
      target: lumine.views.getView(lumine.workspace),
    });
    expect(commands.map(({ name }) => name)).toContain("ide-client:toggle-problems");
    expect(commands.map(({ name }) => name)).toContain("ide-client:restart");
    expect(commands.map(({ name }) => name)).toContain("ide-client:servers");
    expect(commands.map(({ name }) => name)).toContain("ide-client:fold-server-ranges");
    expect(commands.map(({ name }) => name)).toContain("ide-client:expand-selection-range");
    expect(commands.map(({ name }) => name)).toContain("ide-client:select-linked-ranges");
    expect(commands.map(({ name }) => name)).toContain("ide-client:color-presentation");
  });

  it("satisfies the autocomplete provider contract", () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    const provider = main.provideAutocomplete();
    // autocomplete rejects a provider outright when these are misnamed, and
    // the rejection is only visible at runtime.
    expect(typeof provider.scopeSelector).toBe("string");
    expect(provider.scopeSelector.length).toBeGreaterThan(0);
    expect(provider.selector).toBeUndefined();
    expect(provider.disableForSelector).toBeUndefined();
    expect(typeof provider.getSuggestions).toBe("function");
  });

  it("consumes a service name that no other provided service nests under", () => {
    const { consumedServices } = lumine.packages.getLoadedPackage("ide-client").metadata;
    // A service named "x.y" is stored at the key path ["x"]["y"], so it is
    // also handed to consumers of "x". Consuming both names would receive the
    // wrong value depending on registration order.
    const names = Object.keys(consumedServices);
    for (const name of names) {
      const parent = name.split(".")[0];
      if (parent === name) continue;
      expect(names).not.toContain(parent);
    }
  });

  it("bridges the tree-view file-operation lifecycle to the manager", async () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    const callbacks = new Map();
    const service = {};
    for (const name of [
      "onWillCreateFiles",
      "onWillRenameFiles",
      "onWillDeleteFiles",
      "onDidCreateFiles",
      "onDidRenameFiles",
      "onDidDeleteFiles",
    ]) {
      service[name] = (callback) => {
        callbacks.set(name, callback);
        return { dispose: () => callbacks.delete(name) };
      };
    }
    const will = spyOn(main.manager, "willRenameFiles").and.resolveTo(true);
    const did = spyOn(main.manager, "didRenameFiles");
    const registration = main.consumeTreeViewFileOperations(service);
    const payload = { files: [{ oldPath: "before", newPath: "after" }] };

    expect(await callbacks.get("onWillRenameFiles")(payload)).toBe(true);
    callbacks.get("onDidRenameFiles")(payload);

    expect(will).toHaveBeenCalledWith(payload);
    expect(did).toHaveBeenCalledWith(payload);
    registration.dispose();
    expect(callbacks.size).toBe(0);
  });

  it("takes only the transient half of busy-signal", () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    const provider = { add() {}, remove() {}, changeTitle() {}, clear() {}, dispose() {} };
    const registration = main.consumeBusySignal({
      create: () => provider,
      // The running servers have a status item of their own now; asking for a
      // background zone would mean the old mirroring path came back.
      createBackground: () => {
        throw new Error("createBackground must not be called");
      },
    });
    expect(main.manager.busyProvider).toBe(provider);

    // Dropping the service unhooks the manager rather than leaving a stale
    // provider it would keep reporting into.
    registration.dispose();
    expect(main.manager.busyProvider).toBe(null);
  });

  it("adds its status-bar item to the code-intelligence band", () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    const tiles = [];
    const registration = main.consumeStatusBar(fakeStatusBar(tiles));
    expect(tiles.length).toBe(1);
    // Outside source control (310) on the right panel.
    expect(tiles[0].priority).toBe(250);
    expect(tiles[0].item).toBe(main.serverStatus.element);

    registration.dispose();
    expect(tiles[0].destroyed).toBe(true);
    expect(main.serverStatus).toBe(null);
  });

  it("removes the status-bar item on deactivation", async () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    const tiles = [];
    // The disposable consumeStatusBar returns belongs to the status-bar
    // package, so it never fires when this package deactivates.
    main.consumeStatusBar(fakeStatusBar(tiles));
    await lumine.packages.deactivatePackage("ide-client");
    expect(tiles[0].destroyed).toBe(true);
  });

  it("publishes LSP diagnostics through linter.registry", () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    let indieConfig;
    const delegate = {
      batches: [],
      setMessages(filePath, messages) {
        this.batches.push({ filePath, messages });
      },
      dispose() {},
    };
    const registration = main.consumeLinterRegistry((config) => {
      indieConfig = config;
      return delegate;
    });
    const filePath = require("path").resolve("project", "main.ts");
    main.manager.publishDiagnostics(
      {},
      {
        uri: require("url").pathToFileURL(filePath).href,
        diagnostics: [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
            severity: 2,
            message: "Example warning",
          },
          // The full path is what matters here: the hub validates this batch
          // unconditionally, so a hint that it rejected would drop the warning
          // above along with it.
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
            severity: 4,
            tags: [1],
            message: "Unused import",
          },
        ],
      },
    );
    expect(delegate.batches[0].filePath).toBe(filePath);
    expect(delegate.batches[0].messages[0].severity).toBe("warning");
    expect(delegate.batches[0].messages[1].severity).toBe("hint");
    expect(delegate.batches[0].messages[1].tags).toEqual(["unnecessary"]);
    expect(indieConfig.markerInvalidation).toBe("never");
    registration.dispose();
  });

  it("publishes workspace diagnostics for unopened files and preserves unchanged reports", () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    const batches = [];
    const registration = main.consumeLinterRegistry(() => ({
      setMessages: (filePath, messages) => batches.push({ filePath, messages }),
      dispose() {},
    }));
    const adapter = {
      id: "workspace-diagnostics",
      displayName: "Workspace Diagnostics",
      grammarScopes: ["source.ts"],
      resolveServer: async () => null,
    };
    const session = new ServerSession(main.manager, adapter, "C:\\project", {});
    const filePath = require("path").resolve("project", "unopened.ts");
    const uri = require("url").pathToFileURL(filePath).href;
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "workspace error",
    };

    session.processWorkspaceDiagnosticItems([
      { uri, version: null, kind: "full", resultId: "w1", items: [diagnostic] },
    ]);
    session.processWorkspaceDiagnosticItems([
      { uri, version: null, kind: "unchanged", resultId: "w2" },
    ]);

    expect(batches.length).toBe(1);
    expect(batches[0].filePath).toBe(filePath);
    expect(batches[0].messages.map(({ excerpt }) => excerpt)).toEqual(["workspace error"]);
    expect(session.previousWorkspaceDiagnosticResultIds()).toEqual([{ uri, value: "w2" }]);

    session.processWorkspaceDiagnosticItems([
      { uri, version: null, kind: "full", resultId: "w3", items: [] },
    ]);
    expect(batches.at(-1)).toEqual({ filePath, messages: [] });
    registration.dispose();
  });

  it("aggregates cell diagnostics per notebook and evicts cell by cell", () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    const C = require("../lib/converters");
    const delegate = {
      batches: [],
      setMessages(filePath, messages) {
        this.batches.push({ filePath, messages });
      },
      dispose() {},
    };
    const registration = main.consumeLinterRegistry(() => delegate);
    const notebookPath = require("path").resolve("proj", "nb.ipynb");
    // Cell c2 sits at index 2 — a markdown cell between them — so the linter
    // cell numbers are full-list based, not code-cell based.
    const record = {
      filePath: notebookPath,
      notebookType: "jupyter-notebook",
      cellIndexOf: (id) => ({ c1: 0, c2: 2 })[id] ?? -1,
    };
    const editorA = { getRootScopeDescriptor: () => null };
    const editorB = { getRootScopeDescriptor: () => null };
    main.manager.registerExternalDocument(editorA, {
      editor: editorA,
      uri: C.cellUri(notebookPath, "c1"),
      cellId: "c1",
      record,
    });
    main.manager.registerExternalDocument(editorB, {
      editor: editorB,
      uri: C.cellUri(notebookPath, "c2"),
      cellId: "c2",
      record,
    });
    const diagnostic = (message) => ({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      message,
    });
    const session = { adapter: { id: "fake-adapter", displayName: "Fake" } };

    main.manager.publishDiagnostics(session, {
      uri: C.cellUri(notebookPath, "c1"),
      diagnostics: [diagnostic("one")],
    });
    main.manager.publishDiagnostics(session, {
      uri: C.cellUri(notebookPath, "c2"),
      diagnostics: [diagnostic("two")],
    });
    // One batch per publish, each carrying the WHOLE notebook: the delegate
    // replaces a file's bucket, so per-cell batches would erase each other.
    const combined = delegate.batches[delegate.batches.length - 1];
    expect(combined.filePath).toBe(notebookPath);
    expect(combined.messages.length).toBe(2);
    expect(combined.messages.map((m) => m.location.cell).sort()).toEqual([1, 3]);
    expect(combined.messages.every((m) => m.location.file === notebookPath)).toBe(true);
    expect(combined.messages.every((m) => m.location.buffer === undefined)).toBe(true);

    // An empty publish evicts that cell and keeps the rest.
    main.manager.publishDiagnostics(session, {
      uri: C.cellUri(notebookPath, "c1"),
      diagnostics: [],
    });
    const after = delegate.batches[delegate.batches.length - 1];
    expect(after.filePath).toBe(notebookPath);
    expect(after.messages.length).toBe(1);
    expect(after.messages[0].location.cell).toBe(3);

    main.manager.unregisterExternalDocument(editorA);
    main.manager.unregisterExternalDocument(editorB);
    registration.dispose();
  });

  it("says why a server that keeps dying has stopped, and offers its log", async () => {
    // The whole point is that the reason is in the log and nothing said to look
    // there, so the notification is only useful if it carries the way in.
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    spyOn(lumine.notifications, "addError");
    spyOn(main, "showLogForAdapter");
    lumine.config.set("ide-client.restartLimit", 1);

    const session = {
      adapter: { id: "ide-example", displayName: "Example Language Server" },
      // The failure run, which is what the notification counts: one restart
      // that died again is what used the single restart this allows.
      failureCount: 1,
      restartCount: 1,
      runningSince: null,
      state: "failed",
    };
    // Through the manager, so this covers the subscription rather than the
    // method: deleting the wiring in activate() has to fail this.
    main.manager.scheduleRestart(session);

    expect(lumine.notifications.addError).toHaveBeenCalled();
    const [title, options] = lumine.notifications.addError.calls.mostRecent().args;
    expect(title).toContain("Example Language Server");
    expect(options.description).toContain("restarted 1 time");
    expect(options.buttons.map((button) => button.text)).toEqual(["Open Log"]);

    options.buttons[0].onDidClick();
    expect(main.showLogForAdapter).toHaveBeenCalledWith("ide-example");
    lumine.config.unset("ide-client.restartLimit");
  });

  const gaveUp = () => ({
    adapter: { id: "ide-example", displayName: "Example Language Server" },
    failureCount: 1,
  });

  // A notification button dismisses nothing on its own, and this banner sits
  // over the workspace center the log opens into.
  it("closes the banner it raised once the log it pointed at is open", async () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    lumine.notifications.clear();
    const editor = await lumine.workspace.open();
    spyOn(main, "showLogForAdapter").and.returnValue(Promise.resolve(editor));

    main.reportServerGaveUp(gaveUp());
    const notification = lumine.notifications.getNotifications().at(-1);
    await notification.getOptions().buttons[0].onDidClick();
    expect(main.showLogForAdapter).toHaveBeenCalledWith("ide-example");
    expect(notification.isDismissed()).toBe(true);
  });

  // An open can decline, e.g. when the workspace center is full, and then the
  // notification is the one record left of what happened.
  it("keeps the banner up when the log could not be opened", async () => {
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    lumine.notifications.clear();
    spyOn(main, "showLogForAdapter").and.returnValue(Promise.resolve());

    main.reportServerGaveUp(gaveUp());
    const notification = lumine.notifications.getNotifications().at(-1);
    await notification.getOptions().buttons[0].onDidClick();
    expect(notification.isDismissed()).toBe(false);
  });
});
