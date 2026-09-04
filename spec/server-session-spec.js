const fs = require("fs");
const os = require("os");
const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const ServerSession = require("../lib/server-session");
const SymbolProvider = require("../lib/symbol-provider");
const C = require("../lib/converters");

const FIXTURE = path.join(__dirname, "fixtures", "fake-server.js");

const until = async (condition, timeout = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
};

describe("ServerSession against a fake server", () => {
  let manager, tempDir, sessions;

  const createSession = (config = {}, adapterExtras = {}, startup = null) => {
    const ipc = config.transport === "ipc";
    const launch = {
      command: ipc ? FIXTURE : process.execPath,
      args: ipc ? [JSON.stringify(config)] : [FIXTURE, JSON.stringify(config)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      transport: config.transport || "stdio",
    };
    const adapter = {
      id: "fake",
      displayName: "Fake Server",
      grammarScopes: ["source.js"],
      resolveServer: () => launch,
      ...adapterExtras,
    };
    const session = new ServerSession(manager, adapter, tempDir, launch, startup);
    sessions.push(session);
    return session;
  };

  const startSession = async (config = {}, adapterExtras = {}, startup = null) => {
    const session = createSession(config, adapterExtras, startup);
    await session.start();
    return session;
  };

  const receivedMessages = (session) => session.request("test/getReceived");

  beforeEach(() => {
    // Real timers and Date.now: these specs wait on child-process I/O.
    jasmine.useRealClock();
    manager = new LanguageServerManager();
    sessions = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-client-"));
  });

  afterEach(async () => {
    for (const session of sessions) await session.stop();
    await manager.deactivate();
  });

  it("advertises only utf-16 positions and implemented capabilities", async () => {
    const session = await startSession();
    const received = await receivedMessages(session);
    const initialize = received.find((message) => message.method === "initialize");
    expect(initialize.params.capabilities.general.positionEncodings).toEqual(["utf-16"]);
    expect(initialize.params.capabilities.textDocument.inlayHint).toBeUndefined();
    expect(initialize.params.capabilities.textDocument.semanticTokens).toBeUndefined();
    expect(initialize.params.capabilities.textDocument.codeLens).toBeUndefined();
    // Diagnostic tags are only sent by a server that saw them advertised, so
    // assert this over the real handshake rather than by reading the module.
    expect(initialize.params.capabilities.textDocument.publishDiagnostics.tagSupport).toEqual({
      valueSet: [1, 2],
    });
    expect(initialize.params.capabilities.workspace.workspaceEdit.failureHandling).toBe("abort");
    expect(initialize.params.capabilities.textDocument.diagnostic).toEqual({
      dynamicRegistration: false,
      relatedDocumentSupport: true,
    });
    expect(initialize.params.capabilities.textDocument.documentLink.tooltipSupport).toBe(true);
    expect(initialize.params.capabilities.textDocument.colorProvider.dynamicRegistration).toBe(
      true,
    );
    expect(initialize.params.capabilities.textDocument.foldingRange).toEqual({
      dynamicRegistration: true,
      lineFoldingOnly: false,
      rangeLimit: 5000,
    });
    expect(initialize.params.capabilities.textDocument.selectionRange.dynamicRegistration).toBe(
      true,
    );
    expect(initialize.params.capabilities.textDocument.linkedEditingRange.dynamicRegistration).toBe(
      true,
    );
    // Neither hierarchy has an implementation in the hub: both are advertised
    // on hierarchy-view's behalf, because an external package cannot
    // contribute a fragment of its own. A server that never saw these declares
    // no provider, so assert them over the real handshake too.
    expect(initialize.params.capabilities.textDocument.callHierarchy).toEqual({
      dynamicRegistration: true,
    });
    expect(initialize.params.capabilities.textDocument.typeHierarchy).toEqual({
      dynamicRegistration: true,
    });
    expect(initialize.params.capabilities.notebookDocument.synchronization).toEqual({
      dynamicRegistration: false,
    });
    expect(initialize.params.capabilities.workspace.diagnostics.refreshSupport).toBe(true);
    expect(
      initialize.params.capabilities.workspace.didChangeConfiguration.dynamicRegistration,
    ).toBe(true);
  });

  it("merges registered capability fragments into the handshake", async () => {
    manager.addCapabilityFragment({ textDocument: { hover: { contentFormat: ["markdown"] } } });
    const session = await startSession();
    const received = await receivedMessages(session);
    const initialize = received.find((message) => message.method === "initialize");
    expect(initialize.params.capabilities.textDocument.hover.contentFormat).toEqual(["markdown"]);
    expect(initialize.params.capabilities.workspace.applyEdit).toBe(true);
  });

  it("pushes workspace configuration after the handshake", async () => {
    const session = await startSession({}, { getSettings: () => ({ example: { size: 2 } }) });
    await until(async () =>
      (await receivedMessages(session)).some(
        (message) => message.method === "workspace/didChangeConfiguration",
      ),
    );
    const received = await receivedMessages(session);
    const initialized = received.findIndex((message) => message.method === "initialized");
    const configured = received.findIndex(
      (message) => message.method === "workspace/didChangeConfiguration",
    );
    expect(initialized).toBeGreaterThan(-1);
    expect(configured).toBeGreaterThan(initialized);
    expect(received[configured].params.settings).toEqual({ example: { size: 2 } });
  });

  it("sends adapter notifications after initialized and initial settings", async () => {
    let context;
    const session = await startSession(
      {},
      {
        getSettings: () => ({ css: { validate: true } }),
        getInitializedNotifications: (value) => {
          context = value;
          return [{ method: "css/customDataChanged", params: { paths: ["custom.json"] } }];
        },
      },
    );
    expect(context.rootPath).toBe(tempDir);
    expect(context.rootUri).toBe(C.pathToUri(tempDir));
    expect(context.session).toBe(session);
    const methods = (await receivedMessages(session)).map(({ method }) => method);
    expect(methods.indexOf("initialized")).toBeLessThan(
      methods.indexOf("workspace/didChangeConfiguration"),
    );
    expect(methods.indexOf("workspace/didChangeConfiguration")).toBeLessThan(
      methods.indexOf("css/customDataChanged"),
    );
  });

  it("uses a preflight startup snapshot without repeating adapter hooks", async () => {
    const initialization = jasmine.createSpy("initialization");
    const settings = jasmine.createSpy("settings");
    const workspaceFolders = [{ uri: "file:///preflight", name: "preflight" }];
    const session = await startSession(
      {},
      { getInitializationOptions: initialization, getSettings: settings },
      {
        workspaceFolders,
        initializationOptions: { preflight: true },
        settings: { fake: { preflight: true } },
      },
    );

    const received = await receivedMessages(session);
    const initialize = received.find(({ method }) => method === "initialize");
    const configured = received.find(({ method }) => method === "workspace/didChangeConfiguration");
    expect(initialize.params.workspaceFolders).toEqual(workspaceFolders);
    expect(initialize.params.initializationOptions).toEqual({ preflight: true });
    expect(configured.params.settings).toEqual({ fake: { preflight: true } });
    expect(initialization).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    settings.and.returnValue({ fake: { dynamic: true } });
    await session.pushSettings();
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("answers a server that asks for the current workspace folders", async () => {
    const session = await startSession();
    const initialized = (await receivedMessages(session)).find(
      (message) => message.method === "initialize",
    );
    await session.request("test/notify", {
      jsonrpc: "2.0",
      id: 706,
      method: "workspace/workspaceFolders",
    });
    await until(async () =>
      (await receivedMessages(session)).some(
        (message) => message.id === 706 && Object.hasOwn(message, "result"),
      ),
    );
    const response = (await receivedMessages(session)).find(
      (message) => message.id === 706 && Object.hasOwn(message, "result"),
    );
    expect(response.result).toEqual(initialized.params.workspaceFolders);
  });

  it("routes server-specific requests and notifications through adapter hooks", async () => {
    const filePath = path.join(tempDir, "custom.js");
    fs.writeFileSync(filePath, "const custom = true;\n");
    const requests = [];
    const notifications = [];
    let requestSession;
    let notificationSession;
    const session = await startSession(
      {
        capabilities: { textDocumentSync: 2 },
        onOpen: [
          { jsonrpc: "2.0", id: 707, method: "fake/customRequest", params: { value: 1 } },
          { jsonrpc: "2.0", method: "fake/customNotification", params: { value: 2 } },
        ],
      },
      {
        handleServerRequest(method, params, context) {
          requests.push({ method, params });
          requestSession = context.session;
          return { accepted: true };
        },
        handleServerNotification(method, params, context) {
          notifications.push({ method, params });
          notificationSession = context.session;
        },
      },
    );
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);
    await until(() => requests.length === 1 && notifications.length === 1);

    expect(requests).toEqual([{ method: "fake/customRequest", params: { value: 1 } }]);
    expect(notifications).toEqual([{ method: "fake/customNotification", params: { value: 2 } }]);
    expect(requestSession).toBe(session);
    expect(notificationSession).toBe(session);
    await until(async () =>
      (await receivedMessages(session)).some(
        (message) => message.id === 707 && message.result?.accepted === true,
      ),
    );
  });

  it("refuses servers that pick an unsupported position encoding", async () => {
    const launch = {
      command: process.execPath,
      args: [FIXTURE, JSON.stringify({ capabilities: { positionEncoding: "utf-8" } })],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const adapter = {
      id: "fake",
      displayName: "Fake Server",
      grammarScopes: ["source.js"],
      resolveServer: () => launch,
    };
    const session = new ServerSession(manager, adapter, tempDir, launch);
    sessions.push(session);
    await expectAsync(session.start()).toBeRejectedWithError(/position encoding 'utf-8'/);
  });

  it("synchronizes documents incrementally and closes them on detach", async () => {
    const filePath = path.join(tempDir, "example.js");
    fs.writeFileSync(filePath, "const one = 1;\n");
    const session = await startSession({ capabilities: { textDocumentSync: 2 } });
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);
    editor.setTextInBufferRange(
      [
        [0, 6],
        [0, 9],
      ],
      "two",
    );
    session.detachEditor(editor);
    const received = await receivedMessages(session);
    const didOpen = received.find((message) => message.method === "textDocument/didOpen");
    expect(didOpen.params.textDocument.version).toBe(1);
    expect(didOpen.params.textDocument.text).toBe("const one = 1;\n");
    const didChange = received.find((message) => message.method === "textDocument/didChange");
    expect(didChange.params.textDocument.version).toBe(2);
    expect(didChange.params.contentChanges[0].range).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 9 },
    });
    expect(didChange.params.contentChanges[0].text).toBe("two");
    expect(received.some((message) => message.method === "textDocument/didClose")).toBe(true);
  });

  it("sends didOpen before a restored editor's first document-symbol request", async () => {
    const filePath = path.join(tempDir, "restored.js");
    fs.writeFileSync(filePath, "const restored = true;\n");
    const result = [
      {
        name: "restored",
        kind: 13,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 22 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
      },
    ];
    const session = await startSession({
      capabilities: { documentSymbolProvider: true },
      responses: { "textDocument/documentSymbol": result },
    });
    session.ready = Promise.resolve();
    const editor = await lumine.workspace.open(filePath);
    session.adapter.grammarScopes = [editor.getGrammar().scopeName];
    manager.adapters.set(session.adapter.id, session.adapter);
    const rootPath = manager.rootForPath(filePath, session.adapter);
    manager.sessions.set(manager.keyFor(session.adapter, rootPath), session);
    const provider = new SymbolProvider(manager);

    const symbols = await provider.getSymbols({ editor, signal: new AbortController().signal });
    const received = await receivedMessages(session);
    const methods = received.map(({ method }) => method);

    expect(symbols.map(({ name }) => name)).toEqual(["restored"]);
    expect(methods.indexOf("textDocument/didOpen")).toBeLessThan(
      methods.indexOf("textDocument/documentSymbol"),
    );
    provider.destroy();
  });

  it("sends batched incremental changes in an order that reconstructs the document", async () => {
    const filePath = path.join(tempDir, "batched.js");
    const original = "one\nmiddle\nlast\n";
    fs.writeFileSync(filePath, original);
    const session = await startSession({ capabilities: { textDocumentSync: 2 } });
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);

    // An external reload is applied as one transaction with multiple hunks.
    // The first hunk shifts the coordinates of the second one by a whole row.
    editor.transact(() => {
      editor.setTextInBufferRange(
        [
          [0, 3],
          [0, 3],
        ],
        "\ninserted",
      );
      editor.setTextInBufferRange(
        [
          [3, 0],
          [3, 4],
        ],
        "finished",
      );
    });

    const received = await receivedMessages(session);
    const didChange = received.find((message) => message.method === "textDocument/didChange");
    expect(didChange.params.contentChanges.length).toBe(2);

    // LSP servers apply contentChanges one after another. Replaying the wire
    // representation must therefore produce exactly the text in the editor.
    const mirror = await lumine.workspace.buildTextEditor();
    mirror.setText(original);
    for (const change of didChange.params.contentChanges) {
      const { start, end } = change.range;
      mirror.setTextInBufferRange(
        [
          [start.line, start.character],
          [end.line, end.character],
        ],
        change.text,
      );
    }
    expect(mirror.getText()).toBe(editor.getText());
    mirror.destroy();
  });

  it("sends full text when the server wants full sync", async () => {
    const filePath = path.join(tempDir, "full.js");
    fs.writeFileSync(filePath, "start\n");
    const session = await startSession({ capabilities: { textDocumentSync: 1 } });
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);
    editor.setText("replaced\n");
    const received = await receivedMessages(session);
    const didChange = received.find((message) => message.method === "textDocument/didChange");
    expect(didChange.params.contentChanges).toEqual([{ text: "replaced\n" }]);
  });

  it("sends no document notifications when the server opts out of synchronization", async () => {
    const filePath = path.join(tempDir, "unsynced.js");
    fs.writeFileSync(filePath, "start\n");
    const session = await startSession({
      capabilities: { textDocumentSync: { openClose: false, change: 0, save: false } },
    });
    const editor = await lumine.workspace.open(filePath);

    await session.openEditor(editor);
    editor.setText("changed\n");
    await editor.save();
    session.detachEditor(editor);

    const methods = (await receivedMessages(session)).map(({ method }) => method);
    expect(methods).not.toContain("textDocument/didOpen");
    expect(methods).not.toContain("textDocument/didChange");
    expect(methods).not.toContain("textDocument/didSave");
    expect(methods).not.toContain("textDocument/didClose");
  });

  it("honors granular open, change, close and save options", async () => {
    const filePath = path.join(tempDir, "granular.js");
    fs.writeFileSync(filePath, "start\n");
    const session = await startSession({
      capabilities: {
        textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
      },
    });
    const editor = await lumine.workspace.open(filePath);

    await session.openEditor(editor);
    editor.setText("changed\n");
    await editor.save();
    session.detachEditor(editor);

    const received = await receivedMessages(session);
    expect(received.some(({ method }) => method === "textDocument/didOpen")).toBe(true);
    expect(received.some(({ method }) => method === "textDocument/didChange")).toBe(true);
    const save = received.find(({ method }) => method === "textDocument/didSave");
    expect(save.params).toEqual({ textDocument: { uri: C.pathToUri(filePath) } });
    expect(received.some(({ method }) => method === "textDocument/didClose")).toBe(true);
  });

  it("includes transformed text on save only when the server requests it", async () => {
    const filePath = path.join(tempDir, "save-text.js");
    fs.writeFileSync(filePath, "secret\n");
    const session = await startSession(
      {
        capabilities: {
          textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
        },
      },
      { transformDocumentText: (text) => text.replaceAll("secret", "hidden") },
    );
    const editor = await lumine.workspace.open(filePath);

    await session.openEditor(editor);
    await editor.save();

    const save = (await receivedMessages(session)).find(
      ({ method }) => method === "textDocument/didSave",
    );
    expect(save.params.text).toBe("hidden\n");
  });

  it("pulls, refreshes, and clears diagnostics for a pull-only server", async () => {
    const filePath = path.join(tempDir, "diagnostic.js");
    const uri = require("url").pathToFileURL(filePath).href;
    fs.writeFileSync(filePath, "const broken = ;\n");
    const diagnostic = {
      range: {
        start: { line: 0, character: 15 },
        end: { line: 0, character: 16 },
      },
      severity: 1,
      message: "Expression expected.",
    };
    const session = await startSession({
      capabilities: { textDocumentSync: 2, diagnosticProvider: { identifier: "fake" } },
      responseSequences: {
        "textDocument/diagnostic": [
          { kind: "full", resultId: "one", items: [diagnostic] },
          { kind: "unchanged", resultId: "one" },
          { kind: "full", resultId: "two", items: [] },
        ],
      },
    });
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);

    await until(() => manager.diagnosticsFor(session, uri).length === 1);
    let received = await receivedMessages(session);
    let requests = received.filter((message) => message.method === "textDocument/diagnostic");
    expect(requests.length).toBe(1);
    expect(requests[0].params.identifier).toBe("fake");

    await session.request("test/notify", {
      jsonrpc: "2.0",
      id: 997,
      method: "workspace/diagnostic/refresh",
    });
    await until(
      async () =>
        (await receivedMessages(session)).filter(
          (message) => message.method === "textDocument/diagnostic",
        ).length > 1,
    );
    received = await receivedMessages(session);
    requests = received.filter((message) => message.method === "textDocument/diagnostic");
    expect(requests.at(-1).params.previousResultId).toBe("one");
    expect(manager.diagnosticsFor(session, uri)).toEqual([diagnostic]);

    editor.setText("const fixed = true;\n");
    await until(async () => {
      const messages = await receivedMessages(session);
      return messages.filter(({ method }) => method === "textDocument/diagnostic").length > 2;
    });
    await until(() => manager.diagnosticsFor(session, uri).length === 0);

    session.detachEditor(editor);
    expect(manager.diagnosticsFor(session, uri)).toEqual([]);
  });

  it("pulls workspace diagnostics with previous result ids", async () => {
    const uri = C.pathToUri(path.join(tempDir, "workspace-error.js"));
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "workspace error",
    };
    const session = await startSession({
      capabilities: {
        diagnosticProvider: { identifier: "workspace", workspaceDiagnostics: true },
      },
      responseSequences: {
        "workspace/diagnostic": [
          { items: [{ uri, version: null, kind: "full", resultId: "w1", items: [diagnostic] }] },
          { items: [{ uri, version: null, kind: "unchanged", resultId: "w2" }] },
        ],
      },
    });
    await until(() => manager.diagnosticsFor(session, uri).length === 1);

    session.refreshDiagnostics();
    await until(async () => {
      const received = await receivedMessages(session);
      return received.filter(({ method }) => method === "workspace/diagnostic").length >= 2;
    });

    const requests = (await receivedMessages(session)).filter(
      ({ method }) => method === "workspace/diagnostic",
    );
    expect(requests[0].params.identifier).toBe("workspace");
    expect(requests[0].params.previousResultIds).toEqual([]);
    expect(requests[1].params.previousResultIds).toEqual([{ uri, value: "w1" }]);
    expect(manager.diagnosticsFor(session, uri)).toEqual([diagnostic]);
    expect(session.previousWorkspaceDiagnosticResultIds()).toEqual([{ uri, value: "w2" }]);
  });

  it("publishes partial workspace diagnostic reports through the same funnel", async () => {
    const uri = C.pathToUri(path.join(tempDir, "partial-error.js"));
    const diagnostic = {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
      message: "partial error",
    };
    const session = await startSession({
      capabilities: { diagnosticProvider: { workspaceDiagnostics: true } },
      workspaceDiagnosticPartial: {
        items: [{ uri, version: null, kind: "full", resultId: "partial", items: [diagnostic] }],
      },
      responses: { "workspace/diagnostic": { items: [] } },
    });

    await until(() => manager.diagnosticsFor(session, uri).length === 1);

    expect(manager.diagnosticsFor(session, uri)).toEqual([diagnostic]);
    expect(session.previousWorkspaceDiagnosticResultIds()).toEqual([{ uri, value: "partial" }]);
  });

  it("starts workspace diagnostics from a dynamic diagnostic registration", async () => {
    const uri = C.pathToUri(path.join(tempDir, "dynamic-workspace-error.js"));
    const session = await startSession({
      responses: {
        "workspace/diagnostic": {
          items: [{ uri, version: null, kind: "full", resultId: "dynamic", items: [] }],
        },
      },
    });
    await session.request("test/notify", {
      jsonrpc: "2.0",
      id: 991,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "dynamic-diagnostics",
            method: "textDocument/diagnostic",
            registerOptions: {
              identifier: "dynamic-workspace",
              workspaceDiagnostics: true,
            },
          },
        ],
      },
    });

    await until(async () =>
      (await receivedMessages(session)).some(
        ({ method, params }) =>
          method === "workspace/diagnostic" && params.identifier === "dynamic-workspace",
      ),
    );
    expect(session.previousWorkspaceDiagnosticResultIds()).toEqual([{ uri, value: "dynamic" }]);
  });

  it("pulls workspace diagnostics when they are enabled in any grammar scope", () => {
    const adapter = {
      id: "ide-a",
      displayName: "Scoped",
      grammarScopes: ["source.js"],
      resolveServer: async () => null,
    };
    const session = new ServerSession(manager, adapter, tempDir, {});
    session.state = "running";
    session.capabilities = { diagnosticProvider: { workspaceDiagnostics: true } };
    lumine.config.set("ide-a.features.diagnostics", false);
    lumine.config.set("ide-a.features.diagnostics", true, { scopeSelector: ".source.js" });

    expect(session.supportsWorkspaceDiagnostics()).toBe(true);
    spyOn(lumine.grammars, "selectGrammar").and.returnValue({ scopeName: "source.js" });
    expect(manager.featureEnabledForPath(adapter, "diagnostics", "unopened.js")).toBe(true);

    lumine.config.unset("ide-a.features.diagnostics", { scopeSelector: ".source.js" });
    lumine.config.unset("ide-a.features.diagnostics");
  });

  it("keeps document and workspace diagnostic result ids in separate streams", () => {
    const uri = C.pathToUri(path.join(tempDir, "separate-result-ids.js"));
    const session = createSession();
    session.state = "running";
    session.publishDiagnosticReport(uri, { kind: "full", resultId: "document-1", items: [] });
    expect(session.previousWorkspaceDiagnosticResultIds()).toEqual([]);

    session.processWorkspaceDiagnosticItems([
      { uri, version: null, kind: "full", resultId: "workspace-1", items: [] },
    ]);

    expect(session.previousWorkspaceDiagnosticResultIds()).toEqual([{ uri, value: "workspace-1" }]);
  });

  it("does not pull diagnostics while the adapter feature is disabled", async () => {
    const filePath = path.join(tempDir, "quiet.js");
    fs.writeFileSync(filePath, "const fine = true;\n");
    const session = await startSession(
      {
        capabilities: { textDocumentSync: 2, diagnosticProvider: {} },
        responses: {
          "textDocument/diagnostic": { kind: "full", items: [] },
        },
      },
      { features: { diagnostics: false } },
    );
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const received = await receivedMessages(session);
    expect(received.some(({ method }) => method === "textDocument/diagnostic")).toBe(false);
  });

  it("transforms synchronized text and switches incremental servers to full changes", async () => {
    const filePath = path.join(tempDir, "transformed.js");
    fs.writeFileSync(filePath, "visible secret\n");
    const session = await startSession(
      { capabilities: { textDocumentSync: 2 } },
      { transformDocumentText: (text) => text.replaceAll("secret", "hidden") },
    );
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);
    editor.setText("changed secret\n");

    const received = await receivedMessages(session);
    const didOpen = received.find((message) => message.method === "textDocument/didOpen");
    const didChange = received.find((message) => message.method === "textDocument/didChange");
    expect(didOpen.params.textDocument.text).toBe("visible hidden\n");
    expect(didChange.params.contentChanges).toEqual([{ text: "changed hidden\n" }]);
  });

  it("restores transformed text before applying a server workspace edit", async () => {
    const filePath = path.join(tempDir, "restored.js");
    fs.writeFileSync(filePath, "original\n");
    const session = await startSession(
      {},
      { restoreDocumentText: (text) => text.replaceAll("hidden", "secret") },
    );
    const editor = await lumine.workspace.open(filePath);
    await manager.applyWorkspaceEdit(
      {
        changes: {
          [require("url").pathToFileURL(filePath).href]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 8 },
              },
              newText: "hidden",
            },
          ],
        },
      },
      "Restore transformed text",
      session,
    );
    expect(editor.getText()).toBe("secret\n");
  });

  it("refuses a versioned workspace edit after the document changes", async () => {
    const filePath = path.join(tempDir, "stale-edit.js");
    fs.writeFileSync(filePath, "current\n");
    const editor = await lumine.workspace.open(filePath);
    const uri = C.pathToUri(filePath);
    const session = { documents: new Map([[C.uriKey(uri), { editor, uri, version: 2 }]]) };

    const applied = await manager.applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri, version: 1 },
            edits: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 7 },
                },
                newText: "stale",
              },
            ],
          },
        ],
      },
      "Stale edit",
      session,
    );

    expect(applied).toBe(false);
    expect(editor.getText()).toBe("current\n");
  });

  it("preflights every workspace edit before applying the first one", async () => {
    const firstPath = path.join(tempDir, "first-edit.js");
    const stalePath = path.join(tempDir, "second-stale.js");
    fs.writeFileSync(firstPath, "first\n");
    fs.writeFileSync(stalePath, "second\n");
    const first = await lumine.workspace.open(firstPath);
    const stale = await lumine.workspace.open(stalePath);
    const firstUri = C.pathToUri(firstPath);
    const staleUri = C.pathToUri(stalePath);
    const session = {
      documents: new Map([
        [C.uriKey(firstUri), { editor: first, uri: firstUri, version: 1 }],
        [C.uriKey(staleUri), { editor: stale, uri: staleUri, version: 2 }],
      ]),
    };

    const applied = await manager.applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: firstUri, version: 1 },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                newText: "changed",
              },
            ],
          },
          {
            textDocument: { uri: staleUri, version: 1 },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                newText: "stale",
              },
            ],
          },
        ],
      },
      "Atomic preflight",
      session,
    );

    expect(applied).toBe(false);
    expect(first.getText()).toBe("first\n");
    expect(stale.getText()).toBe("second\n");
  });

  it("reports a workspace edit as failed when its target cannot be resolved", async () => {
    const applied = await manager.applyWorkspaceEdit({
      changes: {
        "untitled:missing": [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "lost",
          },
        ],
      },
    });
    expect(applied).toBe(false);
  });

  it("honors overwrite and ignore options for workspace file operations", async () => {
    const created = path.join(tempDir, "created.txt");
    fs.writeFileSync(created, "old");
    expect(
      await manager.applyWorkspaceEdit({
        documentChanges: [
          {
            kind: "create",
            uri: C.pathToUri(created),
            options: { overwrite: true, ignoreIfExists: true },
          },
        ],
      }),
    ).toBe(true);
    expect(fs.readFileSync(created, "utf8")).toBe("");

    const source = path.join(tempDir, "source.txt");
    const target = path.join(tempDir, "target.txt");
    fs.writeFileSync(source, "source");
    fs.writeFileSync(target, "target");
    spyOn(lumine.window, "confirm").and.resolveTo(0);
    expect(
      await manager.applyWorkspaceEdit({
        documentChanges: [
          {
            kind: "rename",
            oldUri: C.pathToUri(source),
            newUri: C.pathToUri(target),
            options: { overwrite: true, ignoreIfExists: true },
          },
        ],
      }),
    ).toBe(true);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("source");

    const ignored = path.join(tempDir, "ignored.txt");
    fs.writeFileSync(ignored, "ignored");
    expect(
      await manager.applyWorkspaceEdit({
        documentChanges: [
          {
            kind: "rename",
            oldUri: C.pathToUri(target),
            newUri: C.pathToUri(ignored),
            options: { ignoreIfExists: true },
          },
        ],
      }),
    ).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("source");
    expect(fs.readFileSync(ignored, "utf8")).toBe("ignored");
  });

  it("applies text edits after creating their target", async () => {
    const filePath = path.join(tempDir, "created-and-edited.txt");
    const uri = C.pathToUri(filePath);
    const applied = await manager.applyWorkspaceEdit({
      documentChanges: [
        { kind: "create", uri },
        {
          textDocument: { uri, version: null },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "created",
            },
          ],
        },
      ],
    });
    const editor = lumine.workspace.getTextEditors().find((item) => item.getPath() === filePath);
    expect(applied).toBe(true);
    expect(editor.getText()).toBe("created");
  });

  it("opens a rename target only after the source has moved", async () => {
    const source = path.join(tempDir, "rename-source.txt");
    const target = path.join(tempDir, "rename-target.txt");
    fs.writeFileSync(source, "source text");
    const targetUri = C.pathToUri(target);
    spyOn(lumine.window, "confirm").and.resolveTo(0);
    const applied = await manager.applyWorkspaceEdit({
      documentChanges: [
        { kind: "rename", oldUri: C.pathToUri(source), newUri: targetUri },
        {
          textDocument: { uri: targetUri, version: null },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
              newText: "updated",
            },
          ],
        },
      ],
    });
    const editor = lumine.workspace.getTextEditors().find((item) => item.getPath() === target);
    expect(applied).toBe(true);
    expect(editor.getText()).toBe("updated text");
  });

  it("hands a pulled diagnostic report to the adapter with the editor it belongs to", async () => {
    const filePath = path.join(tempDir, "filtered.js");
    fs.writeFileSync(filePath, "one\n");
    const contexts = [];
    const session = await startSession(
      {
        capabilities: { textDocumentSync: 2, diagnosticProvider: {} },
        responses: {
          "textDocument/diagnostic": {
            kind: "full",
            items: [{ message: "dropped", code: 521 }, { message: "kept" }],
          },
        },
      },
      {
        transformDiagnostics: (diagnostics, context) => {
          contexts.push(context);
          return diagnostics.filter(({ code }) => code !== 521);
        },
      },
    );
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(manager.diagnosticsFor(session, session.documents.values().next().value.uri)).toEqual([
      { message: "kept" },
    ]);
    expect(contexts[0].editor).toBe(editor);
    expect(contexts[0].session).toBe(session);
    expect(contexts[0].uri).toContain("filtered.js");
  });

  it("routes $/progress to the busy provider", async () => {
    const busy = {
      added: [],
      removed: [],
      add(title) {
        this.added.push(title);
      },
      remove(title) {
        this.removed.push(title);
      },
      changeTitle() {},
      dispose() {},
    };
    manager.setBusyProvider(busy);
    const session = await startSession();
    await session.request("test/notify", {
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token: "t1", value: { kind: "begin", title: "Indexing" } },
    });
    await until(() => busy.added.length > 0);
    expect(busy.added).toEqual(["Fake Server: Indexing"]);
    await session.request("test/notify", {
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token: "t1", value: { kind: "end" } },
    });
    await until(() => busy.removed.length > 0);
    expect(busy.removed).toEqual(["Fake Server: Indexing"]);
  });

  it("honors dynamic registrations in supports()", async () => {
    const session = await startSession({ capabilities: { hoverProvider: true } });
    await session.request("test/notify", {
      jsonrpc: "2.0",
      id: 999,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "reg-1",
            method: "textDocument/formatting",
            registerOptions: { documentSelector: [{ language: "python" }] },
          },
        ],
      },
    });
    await until(() => manager.dynamicCapabilities.has(session));
    const pythonEditor = {
      getGrammar: () => ({ scopeName: "source.python", name: "Python" }),
      getPath: () => path.join(tempDir, "x.py"),
    };
    const jsEditor = {
      getGrammar: () => ({ scopeName: "source.js", name: "JavaScript" }),
      getPath: () => path.join(tempDir, "x.js"),
    };
    expect(session.supports("textDocument/formatting", pythonEditor)).toBe(true);
    expect(session.supports("textDocument/formatting", jsEditor)).toBe(false);
    expect(session.supports("textDocument/hover", jsEditor)).toBe(true);
    expect(session.supports("textDocument/rename", jsEditor)).toBe(false);
  });

  it("tells the two hierarchies apart in supports()", async () => {
    // Both are prepared by their own request and answered by their own
    // provider field, so a server that offers one must not appear to offer
    // the other. Only the `prepare` methods are mapped: the follow-up
    // requests are what a server registers dynamically under, and denying
    // those here would deny exactly the servers that register that way.
    const session = await startSession({ capabilities: { callHierarchyProvider: true } });
    const editor = {
      getGrammar: () => ({ scopeName: "source.js", name: "JavaScript" }),
      getPath: () => path.join(tempDir, "x.js"),
    };
    expect(session.supports("textDocument/prepareCallHierarchy", editor)).toBe(true);
    expect(session.supports("textDocument/prepareTypeHierarchy", editor)).toBe(false);
  });

  it("resolves capability options from a dynamic registration, then the static one", async () => {
    // Tinymist declares no semantic-token capability statically and registers
    // one instead, so its legend is reachable only through the registration.
    // Read from `capabilities` alone it is absent, and the feature renders
    // nothing while looking perfectly healthy.
    const legend = { tokenTypes: ["keyword"], tokenModifiers: [] };
    const session = await startSession({
      capabilities: { completionProvider: { triggerCharacters: ["."] } },
    });
    await session.request("test/notify", {
      jsonrpc: "2.0",
      id: 998,
      method: "client/registerCapability",
      params: {
        registrations: [
          { id: "reg-tokens", method: "textDocument/semanticTokens", registerOptions: { legend } },
        ],
      },
    });
    await until(() => manager.dynamicCapabilities.has(session));

    expect(session.capabilities.semanticTokensProvider).toBeUndefined();
    expect(session.capabilityOptions("textDocument/semanticTokens").legend).toEqual(legend);
    // The static capability still answers where there is no registration.
    expect(session.capabilityOptions("textDocument/completion").triggerCharacters).toEqual(["."]);
    // `true` says "served, with nothing to configure", which is not options.
    expect(session.capabilityOptions("textDocument/hover")).toBeUndefined();
  });

  // Pyright wedges permanently on a cancelled find-all-references: the next one
  // fails with "this._token.cancel is not a function" for the life of the
  // server. Both methods here are ones a server supersedes or completes on its
  // own, so there is nothing to gain by asking it to stop.
  describe("cancelling an in-flight request", () => {
    const HANGING = ["textDocument/references", "workspace/executeCommand", "textDocument/hover"];

    const cancelDuring = async (method, options) => {
      const session = await startSession({ hang: HANGING });
      const controller = new AbortController();
      const pending = session.request(method, {}, { signal: controller.signal, ...options });
      await until(async () =>
        (await receivedMessages(session)).some((message) => message.method === method),
      );
      controller.abort();
      await pending.catch(() => {});
      // `$/cancelRequest` is written from the abort listener itself, so it is
      // already queued ahead of this round trip if it was going to be sent.
      const received = await receivedMessages(session);
      return received.some((message) => message.method === "$/cancelRequest");
    };

    it("abandons references and commands without telling the server", async () => {
      expect(await cancelDuring("textDocument/references")).toBe(false);
      expect(await cancelDuring("workspace/executeCommand")).toBe(false);
    });

    it("still sends $/cancelRequest for everything else", async () => {
      expect(await cancelDuring("textDocument/hover")).toBe(true);
    });

    it("lets a caller ask for the cancellation anyway", async () => {
      expect(await cancelDuring("textDocument/references", { cancelOnServer: true })).toBe(true);
    });
  });

  it("marks the session failed when the server dies", async () => {
    const session = await startSession();
    const states = [];
    session.onDidChangeState(({ state }) => states.push(state));
    session.request("test/crash").catch(() => {});
    await until(() => states.includes("failed"));
    expect(session.state).toBe("failed");
  });

  it("reports a missing executable without an uncaught child-process error", async () => {
    const launch = { command: path.join(tempDir, "missing-language-server.exe") };
    const adapter = {
      id: "missing",
      displayName: "Missing Server",
      grammarScopes: ["source.js"],
    };
    const session = new ServerSession(manager, adapter, tempDir, launch);
    sessions.push(session);
    const states = [];
    session.onDidChangeState(({ state }) => states.push(state));

    await expectAsync(session.start()).toBeRejectedWithError(/ENOENT/);

    expect(session.state).toBe("stopped");
    expect(states.filter((state) => state === "failed").length).toBe(1);
    sessions.splice(sessions.indexOf(session), 1);
  });

  it("fails once on RPC close and rejects every pending request", async () => {
    const session = await startSession({
      hang: ["textDocument/hover", "textDocument/references"],
    });
    const restart = spyOn(manager, "scheduleRestart").and.callThrough();
    const states = [];
    session.onDidChangeState(({ state }) => states.push(state));
    const hover = session.request("textDocument/hover", {}).then(
      () => "resolved",
      () => "rejected",
    );
    const references = session.request("textDocument/references", {}).then(
      () => "resolved",
      () => "rejected",
    );
    session.process.stdout.destroy();

    await until(() => session.state === "failed");

    expect(await hover).toBe("rejected");
    expect(await references).toBe("rejected");
    expect(states.filter((state) => state === "failed").length).toBe(1);
    expect(restart).toHaveBeenCalledTimes(1);
    await until(() => session.process.exitCode != null || session.process.signalCode != null);
    await session.stop();
  });

  it("lets the server exit on its own rather than killing it mid-frame", async () => {
    const session = await startSession();
    const child = session.process;
    await session.stop();
    expect(session.state).toBe("stopped");
    // `exit` was read and acted on: a killed process reports its signal here.
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });

  it("shares one stop operation with concurrent and reentrant callers", async () => {
    const session = await startSession();
    const states = [];
    let reentrant;
    session.onDidChangeState(({ state }) => {
      states.push(state);
      if (state === "stopping") reentrant = session.stop();
    });
    const request = spyOn(session.connection, "request").and.callThrough();
    const notify = spyOn(session.connection, "notify").and.callThrough();

    const first = session.stop();
    const concurrent = session.stop();

    expect(reentrant).toBe(first);
    expect(concurrent).toBe(first);
    await first;
    expect(session.stop()).toBe(first);
    expect(request.calls.allArgs().filter(([method]) => method === "shutdown").length).toBe(1);
    expect(notify.calls.allArgs().filter(([method]) => method === "exit").length).toBe(1);
    expect(states).toEqual(["stopping", "stopped"]);
  });

  it("finishes cleanup and reaches stopped when one disposer fails", async () => {
    const session = await startSession();
    let documentDisposed = false;
    session.documents.set("synthetic", {
      subscriptions: { dispose: () => (documentDisposed = true) },
    });
    const dispose = session.connection.dispose.bind(session.connection);
    spyOn(session.connection, "dispose").and.callFake(() => {
      dispose();
      throw new Error("dispose failed");
    });

    await expectAsync(session.stop()).toBeRejectedWithError("dispose failed");

    expect(session.state).toBe("stopped");
    expect(documentDisposed).toBe(true);
    expect(session.documents.size).toBe(0);
    // afterEach must not await the deliberately rejected shared stop again.
    sessions.splice(sessions.indexOf(session), 1);
  });

  it("does not let a stopped startup become running or send delayed settings", async () => {
    let settingsStarted;
    const awaitingSettings = new Promise((resolve) => (settingsStarted = resolve));
    const settings = new Promise(() => {});
    const session = createSession(
      {},
      {
        getSettings() {
          settingsStarted();
          return settings;
        },
      },
    );
    const states = [];
    session.onDidChangeState(({ state }) => states.push(state));
    const starting = session.start();
    await awaitingSettings;
    const request = spyOn(session.connection, "request").and.callThrough();
    const notify = spyOn(session.connection, "notify").and.callThrough();

    const stopping = session.stop();
    session.notify("test/afterStop", {});
    await Promise.all([starting, stopping]);

    expect(session.state).toBe("stopped");
    expect(states).toEqual(["stopping", "stopped"]);
    expect(request.calls.allArgs().some(([method]) => method === "shutdown")).toBe(false);
    expect(
      notify.calls.allArgs().some(([method]) => method === "workspace/didChangeConfiguration"),
    ).toBe(false);
    expect(notify.calls.allArgs().some(([method]) => method === "test/afterStop")).toBe(false);
    await expectAsync(session.request("test/getReceived")).toBeRejectedWithError(
      "Language server is not running",
    );
  });

  it("cancels a startup blocked in initialization options", async () => {
    let hookStarted;
    const awaitingHook = new Promise((resolve) => (hookStarted = resolve));
    const session = createSession(
      {},
      {
        getInitializationOptions() {
          hookStarted();
          return new Promise(() => {});
        },
      },
    );
    const starting = session.start();
    await awaitingHook;

    const stopping = session.stop();
    await Promise.all([starting, stopping]);

    expect(session.state).toBe("stopped");
  });

  it("allows a server with a one-second exit interceptor to leave naturally", async () => {
    const session = await startSession({ exitDelay: 1100 });
    const child = session.process;

    await session.stop();

    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });

  it("waits for physical process exit after the hard-kill fallback", async () => {
    const session = await startSession({ ignoreExit: true });
    const child = session.process;
    let exited = false;
    child.once("exit", () => (exited = true));

    await session.stop();

    expect(exited).toBe(true);
    expect(child.exitCode != null || child.signalCode != null).toBe(true);
  });

  it("bounds a hanging exit notification and still completes cleanup", async () => {
    const session = await startSession();
    const notify = session.connection.notify.bind(session.connection);
    spyOn(session.connection, "notify").and.callFake((method, ...args) =>
      method === "exit" ? new Promise(() => {}) : notify(method, ...args),
    );

    let failure;
    try {
      await session.stop();
    } catch (error) {
      failure = error;
    }

    expect(failure.message).toMatch(/Timed out after 1000ms/);
    expect(failure.exitNotificationTimedOut).toBe(true);
    expect(session.state).toBe("stopped");
    expect(session.process.exitCode != null || session.process.signalCode != null).toBe(true);
    sessions.splice(sessions.indexOf(session), 1);
  });

  it("rejects after a bounded wait when SIGKILL is refused", async () => {
    const session = await startSession({ ignoreExit: true });
    manager.ownedSessions.add(session);
    const child = session.process;
    const kill = child.kill.bind(child);
    spyOn(child, "kill").and.returnValue(false);

    await expectAsync(session.stop()).toBeRejectedWithError(/refused SIGKILL/);

    expect(session.state).toBe("stopped");
    expect(manager.ownedSessions.has(session)).toBe(true);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill.and.callFake(kill);
    session.kill();
    await exited;
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill.calls.mostRecent().args).toEqual(["SIGKILL"]);
    expect(session.processExited).toBe(true);
    expect(manager.ownedSessions.has(session)).toBe(false);
    sessions.splice(sessions.indexOf(session), 1);
  });

  it("hard-kills even when connection and socket disposal fail", () => {
    const adapter = { id: "fake", displayName: "Fake Server" };
    const session = new ServerSession(manager, adapter, tempDir, {});
    let connectionDisposed = false;
    let socketDestroyed = false;
    let signal;
    session.connection = {
      dispose() {
        connectionDisposed = true;
        throw new Error("connection dispose failed");
      },
    };
    session.socket = {
      destroy() {
        socketDestroyed = true;
        throw new Error("socket destroy failed");
      },
    };
    session.process = { kill: (value) => (signal = value) };

    expect(() => session.kill()).not.toThrow();

    expect(connectionDisposed).toBe(true);
    expect(socketDestroyed).toBe(true);
    expect(signal).toBe("SIGKILL");
    expect(session.state).toBe("stopped");
  });

  it("starts and stops an IPC server through the same lifecycle", async () => {
    const session = await startSession({ transport: "ipc" });

    const messages = await receivedMessages(session);
    expect(messages.some(({ method }) => method === "initialize")).toBe(true);
    await session.stop();

    expect(session.state).toBe("stopped");
    expect(session.process.exitCode).toBe(0);
    expect(session.process.signalCode).toBeNull();
  });

  it("prepares Windows batch servers through cmd.exe with escaped arguments", () => {
    const prepared = ServerSession.prepareServerSpawn(
      "C:\\tools\\server.cmd",
      ["plain", "value & whoami", "%PATH%"],
      { shell: false },
      "win32",
    );
    expect(prepared.command.toLowerCase()).toContain("cmd");
    expect(prepared.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(prepared.args[3]).toContain("^&");
    expect(prepared.args[3]).toContain("^%");
    expect(prepared.options.windowsVerbatimArguments).toBe(true);
    expect(prepared.options.shell).toBe(false);
  });

  it("starts a language server through a Windows .cmd shim", async () => {
    if (process.platform !== "win32") return;
    const batch = path.join(tempDir, "fake-server.cmd");
    fs.writeFileSync(batch, `@echo off\r\n"${process.execPath}" "${FIXTURE}" %*\r\n`);
    const launch = {
      command: batch,
      args: [JSON.stringify({})],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const session = new ServerSession(
      manager,
      {
        id: "batch",
        displayName: "Batch Server",
        grammarScopes: ["source.js"],
        resolveServer: () => launch,
      },
      tempDir,
      launch,
    );
    sessions.push(session);

    await session.start();

    expect((await receivedMessages(session)).some(({ method }) => method === "initialize")).toBe(
      true,
    );
  });

  it("retries a refused socket until the spawned server starts listening", async () => {
    const EventEmitter = require("events");
    const net = require("net");
    let attempts = 0;
    spyOn(net, "connect").and.callFake(() => {
      attempts++;
      const socket = new EventEmitter();
      socket.destroy = jasmine.createSpy("destroy");
      if (attempts === 1) {
        const error = Object.assign(new Error("not ready"), { code: "ECONNREFUSED" });
        queueMicrotask(() => socket.emit("error", error));
      } else {
        queueMicrotask(() => socket.emit("connect"));
      }
      return socket;
    });
    const session = createSession();

    const socket = await session.connectSocket("127.0.0.1", 2087);

    expect(attempts).toBe(2);
    expect(socket).toBe(session.socket);
    session.socket = null;
  });

  it("cancels a socket connection that is still opening", async () => {
    const EventEmitter = require("events");
    const ChildProcess = require("child_process");
    const net = require("net");
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = new EventEmitter();
    child.stdin = {
      end() {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
      },
    };
    child.kill = () => {
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      return true;
    };
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => {
      if (socket.destroyed) return;
      socket.destroyed = true;
      queueMicrotask(() => socket.emit("close"));
    };
    spyOn(ChildProcess, "spawn").and.returnValue(child);
    spyOn(net, "connect").and.returnValue(socket);
    const session = createSession({ transport: "socket" });

    const starting = session.start();
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = session.stop();
    await Promise.all([starting, stopping]);

    expect(socket.destroyed).toBe(true);
    expect(session.connection).toBeUndefined();
    expect(session.state).toBe("stopped");
  });

  // `shutdown` is a request like any other, and a server that accepts it and
  // never answers would hold the promise open with nothing to time it out.
  // `stop()` runs on the unload path, where the main process is waiting on the
  // reply before it may reload or close the window — so this used to be a window
  // that never came back.
  it("stops a server that never answers shutdown", async () => {
    const session = await startSession();
    const child = session.process;
    const request = session.connection.request.bind(session.connection);
    spyOn(session.connection, "request").and.callFake((method, ...args) =>
      method === "shutdown" ? new Promise(() => {}) : request(method, ...args),
    );

    await session.stop();

    expect(session.state).toBe("stopped");
    expect(child.exitCode != null || child.signalCode != null).toBe(true);
  });

  // The report this guards: `exit` is written to a server that is already gone,
  // the write fails a tick later, and an unheard stream error takes down the
  // renderer with "Uncaught Error: write EPIPE".
  it("stops a server whose pipe is already broken without raising", async () => {
    const session = await startSession();
    const child = session.process;
    session.request("test/crash").catch(() => {});
    await until(() => child.exitCode != null || child.signalCode != null);
    await session.stop();
    expect(session.state).toBe("stopped");
    // Reported into the server's log, not thrown at the renderer.
    expect(manager.getLog("fake")).toContain("Could not deliver exit");
  });

  describe("notebook documents", () => {
    it("forwards the notebook lifecycle notifications verbatim", async () => {
      const session = await startSession();
      const notebook = { uri: "file:///C:/proj/nb.ipynb", notebookType: "jupyter-notebook" };
      const cells = [{ uri: "vscode-notebook-cell:///C:/proj/nb.ipynb#c1", languageId: "python" }];

      session.openNotebook({ ...notebook, version: 1, cells: [] }, cells);
      session.changeNotebook({ uri: notebook.uri, version: 2 }, { cells: { textContent: [] } });
      session.saveNotebook({ uri: notebook.uri });
      session.closeNotebook({ uri: notebook.uri }, [{ uri: cells[0].uri }]);

      const received = await receivedMessages(session);
      const methods = received.map((message) => message.method);
      expect(methods).toContain("notebookDocument/didOpen");
      expect(methods).toContain("notebookDocument/didChange");
      expect(methods).toContain("notebookDocument/didSave");
      expect(methods).toContain("notebookDocument/didClose");
      const open = received.find((message) => message.method === "notebookDocument/didOpen");
      expect(open.params.notebookDocument.notebookType).toBe("jupyter-notebook");
      expect(open.params.cellTextDocuments).toEqual(cells);
      const change = received.find((message) => message.method === "notebookDocument/didChange");
      expect(change.params.notebookDocument.version).toBe(2);

      await session.stop();
      // After stop the notify is a quiet no-op, never a throw.
      expect(() => session.saveNotebook({ uri: notebook.uri })).not.toThrow();
    });

    it("adopts a cell as a document without ever opening it as a text document", async () => {
      const session = await startSession();
      const record = { cellVersion: () => 7 };
      const editor = { getRootScopeDescriptor: () => null };
      const uri = C.cellUri("C:\\proj\\nb.ipynb", "c1");

      session.adoptNotebookCell({ record, cellId: "c1", editor, uri });

      const document = session.documents.get(C.uriKey(uri));
      expect(document).toBeDefined();
      expect(document.version).toBe(7);
      const received = await receivedMessages(session);
      expect(
        received.some(
          (message) =>
            message.method === "textDocument/didOpen" &&
            message.params.textDocument.uri.startsWith("vscode-notebook-cell:"),
        ),
      ).toBe(false);

      // detachEditor must not route a notebook cell through textDocument/didClose.
      session.detachEditor(editor);
      expect(session.documents.get(C.uriKey(uri))).toBe(document);

      const published = [];
      const subscription = manager.onDidPublishDiagnostics((params) => published.push(params));
      spyOn(manager, "didCloseDocument").and.callThrough();
      session.releaseNotebookCell(uri);

      expect(session.documents.has(C.uriKey(uri))).toBe(false);
      expect(published.length).toBe(1);
      expect(published[0].uri).toBe(uri);
      expect(published[0].diagnostics).toEqual([]);
      expect(manager.didCloseDocument).toHaveBeenCalledWith(session);
      const received2 = await receivedMessages(session);
      expect(received2.some((message) => message.method === "textDocument/didClose")).toBe(false);
      subscription.dispose();
    });
  });
});
