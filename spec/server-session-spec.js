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

  const installFileOperationsExecutor = () => {
    const executor = {
      plans: [],
      inspect: jasmine.createSpy("inspect file-operation paths").and.callFake(async (paths) =>
        Object.freeze(
          paths.map((filePath) => {
            let status = "missing";
            try {
              status = fs.lstatSync(filePath).isDirectory() ? "directory" : "file";
            } catch (error) {
              if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
            }
            return Object.freeze({ path: filePath, status });
          }),
        ),
      ),
      prepare: jasmine.createSpy("prepare file operations").and.callFake(async (operations) => {
        const virtual = new Map();
        const keyFor = (filePath) =>
          process.platform === "win32"
            ? path.resolve(filePath).toLowerCase()
            : path.resolve(filePath);
        const exists = (filePath) => {
          const key = keyFor(filePath);
          return virtual.has(key) ? virtual.get(key) : fs.existsSync(filePath);
        };
        const setExists = (filePath, value) => virtual.set(keyFor(filePath), value);
        const descriptions = operations.map((operation) => {
          if (operation.kind === "create") {
            const skip =
              exists(operation.path) &&
              !operation.options?.overwrite &&
              operation.options?.ignoreIfExists;
            if (!skip) setExists(operation.path, true);
            return Object.freeze({ status: skip ? "skip" : "apply" });
          }
          if (operation.kind === "rename") {
            const skip =
              exists(operation.newPath) &&
              !operation.options?.overwrite &&
              operation.options?.ignoreIfExists;
            if (!skip) {
              setExists(operation.oldPath, false);
              setExists(operation.newPath, true);
            }
            return Object.freeze({ status: skip ? "skip" : "apply" });
          }
          const skip = !exists(operation.path) && operation.options?.ignoreIfNotExists;
          if (!skip) setExists(operation.path, false);
          return Object.freeze({ status: skip ? "skip" : "apply" });
        });
        let index = 0;
        const executeNext = jasmine
          .createSpy("execute next file operation")
          .and.callFake(async () => {
            const operationIndex = index++;
            const operation = operations[operationIndex];
            if (descriptions[operationIndex].status === "skip") {
              return { status: "skipped", effects: [] };
            }
            if (operation.kind === "create") {
              if (fs.existsSync(operation.path) && !operation.options?.overwrite) {
                if (operation.options?.ignoreIfExists) return { status: "skipped", effects: [] };
                return { status: "failed", reason: "target exists", effects: [] };
              }
              fs.mkdirSync(path.dirname(operation.path), { recursive: true });
              fs.writeFileSync(operation.path, "");
              return {
                status: "applied",
                effects: [{ kind: "create", path: operation.path, isDirectory: false }],
              };
            }
            if (operation.kind === "rename") {
              if (fs.existsSync(operation.newPath)) {
                if (!operation.options?.overwrite) {
                  if (operation.options?.ignoreIfExists) return { status: "skipped", effects: [] };
                  return { status: "failed", reason: "target exists", effects: [] };
                }
                fs.rmSync(operation.newPath, { recursive: true, force: true });
              }
              const isDirectory = fs.statSync(operation.oldPath).isDirectory();
              fs.renameSync(operation.oldPath, operation.newPath);
              return {
                status: "applied",
                effects: [
                  {
                    kind: "rename",
                    oldPath: operation.oldPath,
                    newPath: operation.newPath,
                    isDirectory,
                  },
                ],
              };
            }
            if (operation.kind === "delete") {
              if (!fs.existsSync(operation.path)) {
                if (operation.options?.ignoreIfNotExists) return { status: "skipped", effects: [] };
                return { status: "failed", reason: "target is missing", effects: [] };
              }
              const isDirectory = fs.statSync(operation.path).isDirectory();
              if (isDirectory && !operation.options?.recursive) fs.rmdirSync(operation.path);
              else fs.rmSync(operation.path, { recursive: true, force: false });
              return {
                status: "applied",
                effects: [{ kind: "delete", path: operation.path, isDirectory }],
              };
            }
            return { status: "failed", reason: "unknown operation", effects: [] };
          });
        const plan = {
          describe: () => Object.freeze(descriptions),
          executeNext,
          dispose: jasmine.createSpy("dispose file operation plan"),
        };
        executor.plans.push(plan);
        return { status: "ready", plan };
      }),
    };
    manager.setFileOperationsExecutor(executor);
    return executor;
  };

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
    expect(
      initialize.params.capabilities.workspace.workspaceEdit.resourceOperations,
    ).toBeUndefined();
    expect(initialize.params.capabilities.textDocument.diagnostic).toEqual({
      dynamicRegistration: true,
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

  it("advertises resource operations only while their executor is available", async () => {
    installFileOperationsExecutor();
    const session = await startSession();
    const initialize = (await receivedMessages(session)).find(
      (message) => message.method === "initialize",
    );
    expect(initialize.params.capabilities.workspace.workspaceEdit.resourceOperations).toEqual([
      "create",
      "rename",
      "delete",
    ]);
  });

  it("returns the detailed resource failure to workspace/applyEdit", async () => {
    const session = await startSession();
    await session.request("test/notify", {
      jsonrpc: "2.0",
      id: 996,
      method: "workspace/applyEdit",
      params: {
        edit: {
          documentChanges: [
            { kind: "create", uri: C.pathToUri(path.join(tempDir, "from-server.js")) },
          ],
        },
      },
    });

    await until(async () => (await receivedMessages(session)).some(({ id }) => id === 996));
    const response = (await receivedMessages(session)).find(({ id }) => id === 996);
    expect(response.result).toEqual({
      applied: false,
      failureReason: "File operation service is unavailable.",
      failedChange: 0,
    });
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

  it("uses a dynamic diagnostic identifier and clears its report when the document closes", async () => {
    const filePath = path.join(tempDir, "dynamic-document-error.js");
    const uri = C.pathToUri(filePath);
    fs.writeFileSync(filePath, "bad();\n");
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      message: "bad call",
    };
    const session = await startSession({
      capabilities: { textDocumentSync: 2 },
      responses: {
        "textDocument/diagnostic": { kind: "full", resultId: "dynamic-1", items: [diagnostic] },
      },
    });
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);
    await session.request("test/notify", {
      jsonrpc: "2.0",
      id: 992,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "dynamic-document-diagnostics",
            method: "textDocument/diagnostic",
            registerOptions: { identifier: "dynamic-document" },
          },
        ],
      },
    });

    await until(() => manager.diagnosticsFor(session, uri).length === 1);
    const pull = (await receivedMessages(session)).find(
      ({ method, params }) =>
        method === "textDocument/diagnostic" && params.identifier === "dynamic-document",
    );
    expect(pull).toBeDefined();

    editor.destroy();
    expect(manager.diagnosticsFor(session, uri)).toEqual([]);
  });

  it("does not reuse diagnostic result ids after a dynamic provider is replaced", async () => {
    const filePath = path.join(tempDir, "dynamic-provider-change.js");
    const uri = C.pathToUri(filePath);
    fs.writeFileSync(filePath, "bad();\n");
    const session = await startSession({
      capabilities: { textDocumentSync: 2 },
      responseSequences: {
        "textDocument/diagnostic": [
          { kind: "full", resultId: "provider-one-result", items: [] },
          { kind: "full", resultId: "provider-two-result", items: [] },
        ],
      },
    });
    const editor = await lumine.workspace.open(filePath);
    await session.openEditor(editor);
    const registration = (id, identifier) => ({
      jsonrpc: "2.0",
      id,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: `diagnostics-${identifier}`,
            method: "textDocument/diagnostic",
            registerOptions: { identifier },
          },
        ],
      },
    });
    await session.request("test/notify", registration(993, "provider-one"));
    await until(() =>
      [...session.documents.values()].some(
        (document) => document.diagnosticResultId === "provider-one-result",
      ),
    );
    session.workspaceDiagnosticResultIds.set("old", { uri: "file:///old", value: "old" });
    const pushed = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      message: "pushed independently",
    };
    manager.publishDiagnostics(session, { uri, diagnostics: [pushed] });

    await session.request("test/notify", {
      jsonrpc: "2.0",
      id: 994,
      method: "client/unregisterCapability",
      params: {
        unregisterations: [{ id: "diagnostics-provider-one", method: "textDocument/diagnostic" }],
      },
    });
    expect(manager.diagnosticsFor(session, uri)).toEqual([pushed]);
    await session.request("test/notify", registration(995, "provider-two"));

    await until(async () =>
      (await receivedMessages(session)).some(
        ({ method, params }) =>
          method === "textDocument/diagnostic" && params.identifier === "provider-two",
      ),
    );
    const second = (await receivedMessages(session)).find(
      ({ method, params }) =>
        method === "textDocument/diagnostic" && params.identifier === "provider-two",
    );
    expect(second.params.previousResultId).toBeUndefined();
    expect(session.workspaceDiagnosticResultIds.size).toBe(0);
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

    session.workspaceDiagnosticResultIds.clear();
    session.documents.set(C.uriKey(uri), { uri, version: 2, subscriptions: { dispose() {} } });
    session.processWorkspaceDiagnosticItems([
      { uri, version: 1, kind: "full", resultId: "stale-workspace", items: [] },
    ]);
    expect(session.previousWorkspaceDiagnosticResultIds()).toEqual([]);
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
    const result = await manager.applyWorkspaceEditDetailed({
      changes: {
        "untitled:missing": [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "lost",
          },
        ],
      },
    });
    expect(result.applied).toBe(false);
  });

  it("omits failedChange for the unordered changes-map form", async () => {
    const result = await manager.applyWorkspaceEditDetailed({
      changes: {
        "untitled:missing": [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "lost",
          },
        ],
      },
    });
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("Cannot resolve workspace edit target");
    expect(result.failedChange).toBeUndefined();
  });

  it("rejects a mixed edit before touching text when the file executor is unavailable", async () => {
    const filePath = path.join(tempDir, "untouched.js");
    fs.writeFileSync(filePath, "original\n");
    const editor = await lumine.workspace.open(filePath);
    const uri = C.pathToUri(filePath);
    const created = C.pathToUri(path.join(tempDir, "created.js"));

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        {
          textDocument: { uri, version: null },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
              newText: "changed",
            },
          ],
        },
        { kind: "create", uri: created },
      ],
    });

    expect(result).toEqual({
      applied: false,
      failureReason: "File operation service is unavailable.",
      failedChange: 1,
    });
    expect(editor.getText()).toBe("original\n");
    expect(fs.existsSync(C.uriToPath(created))).toBe(false);
  });

  it("maps a file preflight failure back to the original documentChanges index", async () => {
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({
        status: "failed",
        failedOperation: 1,
        reason: "second resource failed",
      }),
    });
    const textPath = path.join(tempDir, "index-map.js");
    fs.writeFileSync(textPath, "text\n");

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { kind: "create", uri: C.pathToUri(path.join(tempDir, "first.js")) },
        {
          textDocument: { uri: C.pathToUri(textPath), version: null },
          edits: [],
        },
        { kind: "delete", uri: C.pathToUri(path.join(tempDir, "missing.js")) },
      ],
    });

    expect(result).toEqual({
      applied: false,
      failureReason: "second resource failed",
      failedChange: 2,
    });
  });

  it("disposes a file plan whose opaque description is invalid", async () => {
    const dispose = jasmine.createSpy("dispose");
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({
        status: "ready",
        plan: {
          describe: () => [null],
          executeNext: jasmine.createSpy("executeNext"),
          dispose,
        },
      }),
    });

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { kind: "create", uri: C.pathToUri(path.join(tempDir, "invalid-plan.txt")) },
      ],
    });

    expect(result).toEqual({
      applied: false,
      failureReason: "File operation service returned an invalid plan description.",
      failedChange: 0,
    });
    expect(dispose).toHaveBeenCalled();
  });

  it("reports an earlier invalid text change before a later resource failure", async () => {
    const prepare = jasmine.createSpy("prepare").and.resolveTo({
      status: "failed",
      failedOperation: 0,
      reason: "later resource failed",
    });
    manager.setFileOperationsExecutor({ prepare });

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { textDocument: { uri: C.pathToUri(path.join(tempDir, "invalid.txt")) } },
        { kind: "delete", uri: C.pathToUri(path.join(tempDir, "missing.txt")) },
      ],
    });

    expect(result).toEqual({
      applied: false,
      failureReason: "Invalid TextDocumentEdit",
      failedChange: 0,
    });
    expect(prepare).toHaveBeenCalled();
  });

  it("reports an earlier missing text path before a later resource failure", async () => {
    const missingText = path.join(tempDir, "missing-before-resource.txt");
    manager.setFileOperationsExecutor({
      inspect: jasmine
        .createSpy("inspect")
        .and.resolveTo([{ path: missingText, status: "missing" }]),
      prepare: jasmine.createSpy("prepare").and.resolveTo({
        status: "failed",
        failedOperation: 0,
        reason: "later resource failed",
      }),
    });

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { textDocument: { uri: C.pathToUri(missingText), version: null }, edits: [] },
        { kind: "delete", uri: C.pathToUri(path.join(tempDir, "also-missing.txt")) },
      ],
    });

    expect(result.failureReason).toContain("does not exist");
    expect(result.failedChange).toBe(0);
  });

  it("reports an earlier stale text change before a later resource failure", async () => {
    const filePath = path.join(tempDir, "already-stale.txt");
    fs.writeFileSync(filePath, "stale");
    const editor = await lumine.workspace.open(filePath);
    const uri = C.pathToUri(filePath);
    const document = { editor, uri, version: 2 };
    const session = { documents: new Map([[C.uriKey(uri), document]]) };
    const prepare = jasmine.createSpy("prepare").and.resolveTo({
      status: "failed",
      failedOperation: 0,
      reason: "later resource failed",
    });
    manager.setFileOperationsExecutor({ prepare });

    const result = await manager.applyWorkspaceEditDetailed(
      {
        documentChanges: [
          { textDocument: { uri, version: 1 }, edits: [] },
          { kind: "delete", uri: C.pathToUri(path.join(tempDir, "missing.txt")) },
        ],
      },
      undefined,
      session,
    );

    expect(result).toEqual({
      applied: false,
      failureReason: `Refusing a stale workspace edit for '${uri}': document version changed`,
      failedChange: 0,
    });
    expect(prepare).toHaveBeenCalled();
  });

  it("prevalidates stale text untouched by an earlier resource operation", async () => {
    const filePath = path.join(tempDir, "unrelated-stale.txt");
    fs.writeFileSync(filePath, "stale");
    const editor = await lumine.workspace.open(filePath);
    const uri = C.pathToUri(filePath);
    const document = { editor, uri, version: 2 };
    const session = { documents: new Map([[C.uriKey(uri), document]]) };
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({
        status: "failed",
        failedOperation: 1,
        reason: "last resource failed",
      }),
    });

    const result = await manager.applyWorkspaceEditDetailed(
      {
        documentChanges: [
          { kind: "create", uri: C.pathToUri(path.join(tempDir, "created-first.txt")) },
          { textDocument: { uri, version: 1 }, edits: [] },
          { kind: "delete", uri: C.pathToUri(path.join(tempDir, "missing-last.txt")) },
        ],
      },
      undefined,
      session,
    );

    expect(result.failureReason).toContain("stale workspace edit");
    expect(result.failedChange).toBe(1);
  });

  it("stops a prepared edit if the file operation service disappears", async () => {
    installFileOperationsExecutor();
    const source = path.join(tempDir, "service-source.js");
    const target = path.join(tempDir, "service-target.js");
    fs.writeFileSync(source, "source\n");
    spyOn(lumine.window, "confirm").and.callFake(async () => {
      manager.setFileOperationsExecutor(null);
      return 0;
    });

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { kind: "rename", oldUri: C.pathToUri(source), newUri: C.pathToUri(target) },
      ],
    });

    expect(result).toEqual({
      applied: false,
      failureReason: "File operation service became unavailable.",
      failedChange: 0,
    });
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("rechecks a versioned text step after an awaited file operation", async () => {
    let releaseExecution;
    let markExecuting;
    const executing = new Promise((resolve) => (markExecuting = resolve));
    const gate = new Promise((resolve) => (releaseExecution = resolve));
    const plan = {
      describe: () => [{ status: "apply" }],
      executeNext: jasmine.createSpy("executeNext").and.callFake(async () => {
        markExecuting();
        await gate;
        return { status: "skipped", effects: [] };
      }),
      dispose: jasmine.createSpy("dispose"),
    };
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({ status: "ready", plan }),
    });
    const filePath = path.join(tempDir, "version-during-resource.js");
    fs.writeFileSync(filePath, "current\n");
    const editor = await lumine.workspace.open(filePath);
    const uri = C.pathToUri(filePath);
    const document = { editor, uri, version: 1 };
    const session = { documents: new Map([[C.uriKey(uri), document]]) };

    const applying = manager.applyWorkspaceEditDetailed(
      {
        documentChanges: [
          { kind: "create", uri: C.pathToUri(path.join(tempDir, "unrelated.js")) },
          {
            textDocument: { uri, version: 1 },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
                newText: "stale",
              },
            ],
          },
        ],
      },
      undefined,
      session,
    );
    await executing;
    document.version = 2;
    releaseExecution();

    expect(await applying).toEqual({
      applied: false,
      failureReason: `Refusing a stale workspace edit for '${uri}': document version changed`,
      failedChange: 1,
    });
    expect(editor.getText()).toBe("current\n");
    expect(plan.dispose).toHaveBeenCalled();
  });

  it("reports the stale documentChanges index after confirmation", async () => {
    installFileOperationsExecutor();
    const filePath = path.join(tempDir, "version-during-confirm.js");
    const renamedPath = path.join(tempDir, "renamed-during-confirm.js");
    fs.writeFileSync(filePath, "current\n");
    const editor = await lumine.workspace.open(filePath);
    const uri = C.pathToUri(filePath);
    const document = { editor, uri, version: 1 };
    const session = { documents: new Map([[C.uriKey(uri), document]]) };
    spyOn(lumine.window, "confirm").and.callFake(async () => {
      document.version = 2;
      return 0;
    });

    const result = await manager.applyWorkspaceEditDetailed(
      {
        documentChanges: [
          {
            textDocument: { uri, version: 1 },
            edits: [],
          },
          { kind: "rename", oldUri: uri, newUri: C.pathToUri(renamedPath) },
        ],
      },
      undefined,
      session,
    );

    expect(result).toEqual({
      applied: false,
      failureReason: "A document changed while the workspace edit was waiting.",
      failedChange: 0,
    });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(renamedPath)).toBe(false);
  });

  it("detects an edit while the renamed buffer watcher is stabilizing", async () => {
    installFileOperationsExecutor();
    const source = path.join(tempDir, "watch-gate-source.txt");
    const target = path.join(tempDir, "watch-gate-target.txt");
    fs.writeFileSync(source, "before");
    const editor = await lumine.workspace.open(source);
    manager.watchEditor(editor);
    const sourceUri = C.pathToUri(source);
    const targetUri = C.pathToUri(target);
    const document = { editor, uri: sourceUri, version: 1 };
    const session = { documents: new Map([[C.uriKey(sourceUri), document]]) };
    let enterGate;
    let releaseGate;
    const gateEntered = new Promise((resolve) => (enterGate = resolve));
    const gate = new Promise((resolve) => (releaseGate = resolve));
    spyOn(editor.getBuffer(), "getFileWatchStartPromise").and.callFake(() => {
      enterGate();
      return gate;
    });
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    const applying = manager.applyWorkspaceEditDetailed(
      {
        documentChanges: [
          { kind: "rename", oldUri: sourceUri, newUri: targetUri },
          {
            textDocument: { uri: targetUri, version: 1 },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                newText: "server",
              },
            ],
          },
        ],
      },
      undefined,
      session,
    );
    await gateEntered;
    editor.setText("user");
    releaseGate();

    expect(await applying).toEqual({
      applied: false,
      failureReason: `Refusing a stale workspace edit for '${targetUri}': document version changed`,
      failedChange: 1,
    });
    expect(editor.getText()).toBe("user");
    expect(editor.getPath()).toBe(target);
  });

  it("publishes durable executor effects to every interested session", async () => {
    const source = path.join(tempDir, "effect-source.js");
    const target = path.join(tempDir, "effect-target.js");
    const cleanup = path.join(tempDir, ".effect-recovery");
    const plan = {
      describe: () => [{ status: "apply" }],
      executeNext: jasmine.createSpy("executeNext").and.resolveTo({
        status: "applied",
        effects: [{ kind: "rename", oldPath: source, newPath: target, isDirectory: false }],
        cleanupPaths: [cleanup],
      }),
      dispose() {},
    };
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({ status: "ready", plan }),
    });
    const didRename = spyOn(manager, "didRenameFiles");
    const warning = spyOn(lumine.notifications, "addWarning");
    const session = { documents: new Map() };
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    expect(
      await manager.applyWorkspaceEdit(
        {
          documentChanges: [
            { kind: "rename", oldUri: C.pathToUri(source), newUri: C.pathToUri(target) },
          ],
        },
        undefined,
        session,
      ),
    ).toBe(true);
    expect(didRename).toHaveBeenCalledWith({
      files: [{ oldPath: source, newPath: target, isDirectory: false }],
    });
    expect(warning).toHaveBeenCalledWith("A file operation left recovery paths", {
      detail: cleanup,
      dismissable: true,
    });
  });

  it("publishes lifecycle effects once and gates private watcher events", async () => {
    const source = path.join(tempDir, "lifecycle-source.txt");
    const target = path.join(tempDir, "lifecycle-target.txt");
    const internal = path.join(tempDir, ".lifecycle-target.txt.lumine-copy-1-test");
    const external = path.join(tempDir, "external.txt");
    fs.writeFileSync(source, "source");
    let willListener;
    let didListener;
    const executor = {
      onWillExecuteStep(listener) {
        willListener = listener;
        return { dispose: () => (willListener = null) };
      },
      onDidExecuteStep(listener) {
        didListener = listener;
        return { dispose: () => (didListener = null) };
      },
      async prepare(operations) {
        const plan = {
          describe: () => [{ status: "apply" }],
          async executeNext() {
            const lifecycle = { id: 1, operationIndex: 0, operation: operations[0] };
            willListener(lifecycle);
            fs.renameSync(source, target);
            manager.routeFileEvents([
              { action: "created", path: internal },
              { action: "deleted", path: source },
              { action: "updated", path: external },
            ]);
            const result = {
              status: "applied",
              effects: [{ kind: "rename", oldPath: source, newPath: target, isDirectory: false }],
            };
            await didListener({
              ...lifecycle,
              result,
              eventTrace: {
                internalRoots: [{ path: internal, recursive: false }],
                coveredRoots: [
                  { path: source, recursive: false },
                  { path: target, recursive: false },
                ],
              },
            });
            return result;
          },
          dispose() {},
        };
        return { status: "ready", plan };
      },
    };
    manager.setFileOperationsExecutor(executor);
    const publish = spyOn(manager, "publishFileOperationEffects").and.callThrough();
    const watched = spyOn(manager, "notifyWatchedFileEvents").and.callThrough();
    const deliver = spyOn(manager, "deliverFileEvents").and.callThrough();
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    expect(
      await manager.applyWorkspaceEdit({
        documentChanges: [
          { kind: "rename", oldUri: C.pathToUri(source), newUri: C.pathToUri(target) },
        ],
      }),
    ).toBe(true);
    expect(publish.calls.count()).toBe(1);
    expect(publish).toHaveBeenCalledWith(
      [{ kind: "rename", oldPath: source, newPath: target, isDirectory: false }],
      { suppressProjectEvents: false },
    );
    expect(watched.calls.argsFor(0)[0]).toEqual([
      { action: "deleted", path: source },
      { action: "created", path: target },
    ]);
    expect(deliver).toHaveBeenCalledOnceWith([{ action: "updated", path: external }]);

    manager.routeFileEvents([{ action: "created", path: internal }]);
    expect(deliver.calls.count()).toBe(1);
  });

  it("returns a lifecycle coordination failure after a durable step", async () => {
    let willListener;
    let didListener;
    const target = path.join(tempDir, "lifecycle-error.txt");
    const executor = {
      onWillExecuteStep(listener) {
        willListener = listener;
        return { dispose() {} };
      },
      onDidExecuteStep(listener) {
        didListener = listener;
        return { dispose() {} };
      },
      async prepare(operations) {
        return {
          status: "ready",
          plan: {
            describe: () => [{ status: "apply" }],
            async executeNext() {
              const lifecycle = { id: 9, operationIndex: 0, operation: operations[0] };
              const result = {
                status: "applied",
                effects: [{ kind: "create", path: target, isDirectory: false }],
              };
              willListener(lifecycle);
              await didListener({
                ...lifecycle,
                result,
                eventTrace: { internalRoots: [], coveredRoots: [{ path: target }] },
              });
              return result;
            },
            dispose() {},
          },
        };
      },
    };
    manager.setFileOperationsExecutor(executor);
    spyOn(manager, "updateEditorsForFileEffects").and.throwError("retarget failed");

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [{ kind: "create", uri: C.pathToUri(target) }],
    });

    expect(result).toEqual({
      applied: false,
      failureReason: "retarget failed",
      failedChange: 0,
    });
  });

  it("finishes an active lifecycle gate after its service is removed", async () => {
    const source = path.join(tempDir, "removed-service-source.txt");
    const target = path.join(tempDir, "removed-service-target.txt");
    const internal = path.join(tempDir, ".removed-service.lumine-move-1-test");
    fs.writeFileSync(source, "source");
    let willListener;
    let didListener;
    const executor = {
      onWillExecuteStep(listener) {
        willListener = listener;
        return { dispose: () => (willListener = null) };
      },
      onDidExecuteStep(listener) {
        didListener = listener;
        return { dispose: () => (didListener = null) };
      },
      async prepare(operations) {
        return {
          status: "ready",
          plan: {
            describe: () => [{ status: "apply" }],
            async executeNext() {
              const lifecycle = { id: 21, operationIndex: 0, operation: operations[0] };
              willListener(lifecycle);
              manager.routeFileEvents([{ action: "created", path: internal }]);
              manager.setFileOperationsExecutor(null);
              fs.renameSync(source, target);
              fs.writeFileSync(internal, "recovery");
              const result = {
                status: "applied",
                effects: [{ kind: "rename", oldPath: source, newPath: target, isDirectory: false }],
                cleanupPaths: [internal],
              };
              await didListener({
                ...lifecycle,
                result,
                eventTrace: {
                  internalRoots: [{ path: internal, recursive: false }],
                  coveredRoots: [
                    { path: source, recursive: false },
                    { path: target, recursive: false },
                  ],
                },
              });
              return result;
            },
            dispose() {},
          },
        };
      },
    };
    manager.setFileOperationsExecutor(executor);
    const publish = spyOn(manager, "publishFileOperationEffects").and.callThrough();
    const deliver = spyOn(manager, "deliverFileEvents").and.callThrough();
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { kind: "rename", oldUri: C.pathToUri(source), newUri: C.pathToUri(target) },
      ],
    });

    expect(result).toEqual({
      applied: false,
      failureReason: `File operation service became unavailable.\n\nRecovery paths:\n${internal}`,
      failedChange: 0,
    });
    expect(publish.calls.count()).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("source");
  });

  it("applies covered roots only to each gate's own event window", async () => {
    const first = path.join(tempDir, "first-gate");
    const second = path.join(tempDir, "second-gate");
    const child = path.join(first, "child.ts");
    const deliver = spyOn(manager, "deliverFileEvents").and.callThrough();
    manager.beginFileOperationEventGate({
      id: "first",
      operation: { kind: "create", path: first },
    });
    manager.beginFileOperationEventGate({
      id: "second",
      operation: { kind: "create", path: second },
    });
    manager.routeFileEvents([
      { action: "created", path: first },
      { action: "updated", path: child },
    ]);

    await manager.finishFileOperationEventGate({
      id: "first",
      result: { status: "applied", effects: [{ kind: "create", path: first }] },
      eventTrace: { internalRoots: [], coveredRoots: [{ path: first, recursive: true }] },
    });
    manager.routeFileEvents([{ action: "created", path: first }]);
    await manager.finishFileOperationEventGate({
      id: "second",
      result: { status: "skipped", effects: [] },
      eventTrace: { internalRoots: [], coveredRoots: [{ path: second, recursive: true }] },
    });

    expect(deliver).toHaveBeenCalledOnceWith([
      { action: "updated", path: child },
      { action: "created", path: first },
    ]);
  });

  it("honors overwrite and ignore options for workspace file operations", async () => {
    const executor = installFileOperationsExecutor();
    const confirm = spyOn(lumine.window, "confirm").and.resolveTo(0);
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
    expect(confirm.calls.count()).toBe(2);
    expect(confirm.calls.first().args[0].detail).toContain(created);
    expect(executor.prepare.calls.allArgs().flatMap(([operations]) => operations)).toEqual([
      {
        kind: "create",
        path: created,
        options: { overwrite: true, ignoreIfExists: true },
      },
      {
        kind: "rename",
        oldPath: source,
        newPath: target,
        options: { overwrite: true, ignoreIfExists: true },
      },
      {
        kind: "rename",
        oldPath: target,
        newPath: ignored,
        options: { ignoreIfExists: true },
      },
    ]);
  });

  it("deletes an empty directory without requiring recursive deletion", async () => {
    installFileOperationsExecutor();
    const directory = path.join(tempDir, "empty-directory");
    fs.mkdirSync(directory);
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [{ kind: "delete", uri: C.pathToUri(directory) }],
    });

    expect(result).toEqual({ applied: true });
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("applies text edits after creating their target", async () => {
    installFileOperationsExecutor();
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

  it("rejects text for a missing target before a later create", async () => {
    const executor = installFileOperationsExecutor();
    const filePath = path.join(tempDir, "edited-before-create.txt");
    const uri = C.pathToUri(filePath);

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        {
          textDocument: { uri, version: null },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "must not be staged",
            },
          ],
        },
        { kind: "create", uri },
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("does not exist");
    expect(result.failedChange).toBe(0);
    expect(executor.plans[0].executeNext).not.toHaveBeenCalled();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(lumine.workspace.getTextEditors().some((editor) => editor.getPath() === filePath)).toBe(
      false,
    );
  });

  it("opens a rename target only after the source has moved", async () => {
    installFileOperationsExecutor();
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

  it("retargets an open buffer after the executor renames its file", async () => {
    installFileOperationsExecutor();
    const source = path.join(tempDir, "open-source.txt");
    const target = path.join(tempDir, "open-target.txt");
    fs.writeFileSync(source, "open text");
    const editor = await lumine.workspace.open(source);
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    expect(
      await manager.applyWorkspaceEdit({
        documentChanges: [
          { kind: "rename", oldUri: C.pathToUri(source), newUri: C.pathToUri(target) },
        ],
      }),
    ).toBe(true);
    expect(editor.getPath()).toBe(target);
    expect(lumine.workspace.getTextEditors().filter((item) => item.getPath() === target)).toEqual([
      editor,
    ]);
  });

  it("interleaves prepared resource steps with text edits in documentChanges order", async () => {
    const executor = installFileOperationsExecutor();
    const created = path.join(tempDir, "ordered-created.txt");
    const renamed = path.join(tempDir, "ordered-renamed.txt");
    const createdUri = C.pathToUri(created);
    const renamedUri = C.pathToUri(renamed);
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    const applied = await manager.applyWorkspaceEdit({
      documentChanges: [
        { kind: "create", uri: createdUri },
        {
          textDocument: { uri: createdUri, version: null },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "one",
            },
          ],
        },
        { kind: "rename", oldUri: createdUri, newUri: renamedUri },
        {
          textDocument: { uri: renamedUri, version: null },
          edits: [
            {
              range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
              newText: " two",
            },
          ],
        },
      ],
    });

    const editor = lumine.workspace.getTextEditors().find((item) => item.getPath() === renamed);
    expect(applied).toBe(true);
    expect(editor.getText()).toBe("one two");
    expect(executor.prepare.calls.mostRecent().args[0].map(({ kind }) => kind)).toEqual([
      "create",
      "rename",
    ]);
    expect(executor.plans[0].dispose).toHaveBeenCalled();
  });

  it("maps a text target through a preceding directory rename", async () => {
    installFileOperationsExecutor();
    const sourceDirectory = path.join(tempDir, "source-directory");
    const targetDirectory = path.join(tempDir, "target-directory");
    const sourceFile = path.join(sourceDirectory, "nested", "file.txt");
    const targetFile = path.join(targetDirectory, "nested", "file.txt");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "before");
    const editor = await lumine.workspace.open(sourceFile);
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        {
          kind: "rename",
          oldUri: C.pathToUri(sourceDirectory),
          newUri: C.pathToUri(targetDirectory),
        },
        {
          textDocument: { uri: C.pathToUri(targetFile), version: null },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
              newText: "after",
            },
          ],
        },
      ],
    });

    expect(result).toEqual({ applied: true });
    expect(editor.getPath()).toBe(targetFile);
    expect(editor.getText()).toBe("after");
    expect(
      lumine.workspace.getTextEditors().filter((candidate) => candidate.getPath() === targetFile),
    ).toEqual([editor]);
  });

  it("validates a versioned rename target against its open source document", async () => {
    installFileOperationsExecutor();
    const source = path.join(tempDir, "versioned-source.txt");
    const target = path.join(tempDir, "versioned-target.txt");
    fs.writeFileSync(source, "before");
    const editor = await lumine.workspace.open(source);
    manager.watchEditor(editor);
    const sourceUri = C.pathToUri(source);
    const targetUri = C.pathToUri(target);
    const document = { editor, uri: sourceUri, version: 7 };
    const session = { documents: new Map([[C.uriKey(sourceUri), document]]) };
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    const result = await manager.applyWorkspaceEditDetailed(
      {
        documentChanges: [
          { kind: "rename", oldUri: sourceUri, newUri: targetUri },
          {
            textDocument: { uri: targetUri, version: 7 },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                newText: "after",
              },
            ],
          },
        ],
      },
      undefined,
      session,
    );

    expect(result).toEqual({ applied: true });
    expect(editor.getPath()).toBe(target);
    expect(editor.getText()).toBe("after");
  });

  it("reattaches a renamed document before sending its following text change", async () => {
    const session = await startSession({
      capabilities: {
        textDocumentSync: 2,
        workspace: {
          fileOperations: {
            didRename: { filters: [{ scheme: "file", pattern: { glob: "**/*" } }] },
          },
        },
      },
    });
    const source = path.join(tempDir, "wire-source.txt");
    const target = path.join(tempDir, "wire-target.txt");
    fs.writeFileSync(source, "before");
    const editor = await lumine.workspace.open(source);
    await session.openEditor(editor);
    manager.sessions.set("workspace-edit-wire-order", session);
    spyOn(manager, "attachEditor").and.callFake((candidate) => session.openEditor(candidate));
    manager.watchEditor(editor);
    installFileOperationsExecutor();
    spyOn(lumine.window, "confirm").and.resolveTo(0);
    const sourceUri = C.pathToUri(source);
    const targetUri = C.pathToUri(target);

    const result = await manager.applyWorkspaceEditDetailed(
      {
        documentChanges: [
          { kind: "rename", oldUri: sourceUri, newUri: targetUri },
          {
            textDocument: { uri: targetUri, version: 1 },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                newText: "after",
              },
            ],
          },
        ],
      },
      undefined,
      session,
    );
    const protocol = (await receivedMessages(session))
      .filter((message) =>
        [
          "workspace/didRenameFiles",
          "textDocument/didClose",
          "textDocument/didOpen",
          "textDocument/didChange",
        ].includes(message.method),
      )
      .slice(-4);

    expect(result).toEqual({ applied: true });
    expect(protocol.map(({ method }) => method)).toEqual([
      "workspace/didRenameFiles",
      "textDocument/didClose",
      "textDocument/didOpen",
      "textDocument/didChange",
    ]);
    expect(protocol[0].params.files).toEqual([{ oldUri: sourceUri, newUri: targetUri }]);
    expect(protocol[1].params.textDocument.uri).toBe(sourceUri);
    expect(protocol[2].params.textDocument.uri).toBe(targetUri);
    expect(protocol[3].params.textDocument.uri).toBe(targetUri);
  });

  it("carries a version guard across a rename into another session", async () => {
    const sourceSession = await startSession(
      { capabilities: { textDocumentSync: 2 } },
      { id: "same-language" },
    );
    const competingSession = await startSession(
      { capabilities: { textDocumentSync: 2 } },
      { id: "other-language" },
    );
    const targetSession = await startSession(
      { capabilities: { textDocumentSync: 2 } },
      { id: "same-language" },
    );
    const source = path.join(tempDir, "root-a", "cross-root.txt");
    const target = path.join(tempDir, "root-b", "cross-root.txt");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, "before");
    const editor = await lumine.workspace.open(source);
    await sourceSession.openEditor(editor);
    manager.sessions.set("workspace-edit-root-a", sourceSession);
    manager.sessions.set("workspace-edit-other-language", competingSession);
    manager.sessions.set("workspace-edit-root-b", targetSession);
    spyOn(manager, "attachEditor").and.callFake(async (candidate) => {
      await Promise.all([
        competingSession.openEditor(candidate),
        targetSession.openEditor(candidate),
      ]);
      [...competingSession.documents.values()].find(
        (document) => document.editor === candidate,
      ).version = 9;
    });
    manager.watchEditor(editor);
    installFileOperationsExecutor();
    spyOn(lumine.window, "confirm").and.resolveTo(0);
    const sourceUri = C.pathToUri(source);
    const targetUri = C.pathToUri(target);

    const result = await manager.applyWorkspaceEditDetailed(
      {
        documentChanges: [
          { kind: "rename", oldUri: sourceUri, newUri: targetUri },
          {
            textDocument: { uri: targetUri, version: 1 },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                newText: "after",
              },
            ],
          },
        ],
      },
      undefined,
      sourceSession,
    );
    const sourceChanges = (await receivedMessages(sourceSession)).filter(
      ({ method }) => method === "textDocument/didChange",
    );
    const targetChanges = (await receivedMessages(targetSession)).filter(
      ({ method }) => method === "textDocument/didChange",
    );

    expect(result).toEqual({ applied: true });
    expect(sourceChanges).toEqual([]);
    expect(targetChanges.at(-1).params.textDocument.uri).toBe(targetUri);
  });

  it("rejects text for a missing path after a skipped delete", async () => {
    const missing = path.join(tempDir, "already-missing.txt");
    const plan = {
      describe: () => [{ status: "skip" }],
      executeNext: jasmine.createSpy("executeNext"),
      dispose: jasmine.createSpy("dispose"),
    };
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({ status: "ready", plan }),
    });

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        {
          kind: "delete",
          uri: C.pathToUri(missing),
          options: { ignoreIfNotExists: true },
        },
        {
          textDocument: { uri: C.pathToUri(missing), version: null },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "must not be created",
            },
          ],
        },
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("will no longer exist");
    expect(result.failedChange).toBe(1);
    expect(plan.executeNext).not.toHaveBeenCalled();
    expect(fs.existsSync(missing)).toBe(false);
    expect(lumine.workspace.getTextEditors().some((editor) => editor.getPath() === missing)).toBe(
      false,
    );
  });

  it("refuses to overwrite a path that already has an open buffer", async () => {
    const executor = installFileOperationsExecutor();
    const source = path.join(tempDir, "overwrite-source.txt");
    const target = path.join(tempDir, "overwrite-target.txt");
    fs.writeFileSync(source, "source");
    fs.writeFileSync(target, "target");
    await lumine.workspace.open(target);

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        {
          kind: "rename",
          oldUri: C.pathToUri(source),
          newUri: C.pathToUri(target),
          options: { overwrite: true },
        },
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("while it is open in the workspace");
    expect(result.failedChange).toBe(0);
    expect(executor.plans[0].executeNext).not.toHaveBeenCalled();
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.readFileSync(target, "utf8")).toBe("target");
  });

  it("refuses a new resource target already held by an unsaved buffer", async () => {
    const executor = installFileOperationsExecutor();
    const source = path.join(tempDir, "unsaved-target-source.txt");
    const target = path.join(tempDir, "unsaved-target.txt");
    fs.writeFileSync(source, "source");
    await lumine.workspace.open(target);

    const createResult = await manager.applyWorkspaceEditDetailed({
      documentChanges: [{ kind: "create", uri: C.pathToUri(target) }],
    });
    const renameResult = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { kind: "rename", oldUri: C.pathToUri(source), newUri: C.pathToUri(target) },
      ],
    });

    expect(createResult.failedChange).toBe(0);
    expect(renameResult.failedChange).toBe(0);
    expect(createResult.failureReason).toContain("while it is open in the workspace");
    expect(renameResult.failureReason).toContain("while it is open in the workspace");
    expect(executor.plans.every((plan) => plan.executeNext.calls.count() === 0)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(source, "utf8")).toBe("source");
  });

  it("retargets an editor from an executor's private rename path", async () => {
    const source = path.join(tempDir, "private-rename-source.txt");
    const target = path.join(tempDir, "private-rename-target.txt");
    const recovery = path.join(tempDir, ".lumine-move-private");
    fs.writeFileSync(source, "source");
    const editor = await lumine.workspace.open(source);
    manager.watchEditor(editor);
    const reattach = spyOn(manager, "reattachEditor").and.callThrough();
    const plan = {
      describe: () => [{ status: "apply" }],
      executeNext: jasmine.createSpy("executeNext").and.callFake(async () => {
        editor.getBuffer().setPath(recovery);
        fs.renameSync(source, target);
        return {
          status: "applied",
          effects: [{ kind: "rename", oldPath: source, newPath: target, isDirectory: false }],
        };
      }),
      dispose() {},
    };
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({ status: "ready", plan }),
    });
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    expect(
      await manager.applyWorkspaceEdit({
        documentChanges: [
          { kind: "rename", oldUri: C.pathToUri(source), newUri: C.pathToUri(target) },
        ],
      }),
    ).toBe(true);
    expect(editor.getPath()).toBe(target);
    expect(reattach.calls.count()).toBe(1);
  });

  it("restores an open editor's logical path after executor-private deletion", async () => {
    const source = path.join(tempDir, "private-delete-source.txt");
    const recovery = path.join(tempDir, ".lumine-delete-private");
    fs.writeFileSync(source, "source");
    const editor = await lumine.workspace.open(source);
    manager.watchEditor(editor);
    const reattach = spyOn(manager, "reattachEditor").and.callThrough();
    const plan = {
      describe: () => [{ status: "apply" }],
      executeNext: jasmine.createSpy("executeNext").and.callFake(async () => {
        editor.getBuffer().setPath(recovery);
        fs.rmSync(source);
        return {
          status: "applied",
          effects: [{ kind: "delete", path: source, isDirectory: false }],
        };
      }),
      dispose() {},
    };
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({ status: "ready", plan }),
    });
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    expect(
      await manager.applyWorkspaceEdit({
        documentChanges: [{ kind: "delete", uri: C.pathToUri(source) }],
      }),
    ).toBe(true);
    expect(editor.getPath()).toBe(source);
    expect(reattach.calls.count()).toBe(1);
  });

  it("restores an editor path after a private move rolls back without effects", async () => {
    const source = path.join(tempDir, "rolled-back-source.txt");
    const recovery = path.join(tempDir, ".lumine-move-rolled-back");
    fs.writeFileSync(source, "source");
    const editor = await lumine.workspace.open(source);
    manager.watchEditor(editor);
    const reattach = spyOn(manager, "reattachEditor").and.callThrough();
    const plan = {
      describe: () => [{ status: "apply" }],
      executeNext: jasmine.createSpy("executeNext").and.callFake(async () => {
        editor.getBuffer().setPath(recovery);
        return { status: "failed", reason: "copy failed and rolled back", effects: [] };
      }),
      dispose() {},
    };
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({ status: "ready", plan }),
    });
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { kind: "rename", oldUri: C.pathToUri(source), newUri: C.pathToUri(`${source}.new`) },
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toBe("copy failed and rolled back");
    expect(editor.getPath()).toBe(source);
    expect(reattach.calls.count()).toBe(1);
  });

  it("rechecks an overwrite target immediately before the resource step", async () => {
    const executor = installFileOperationsExecutor();
    const target = path.join(tempDir, "late-open-target.txt");
    const source = path.join(tempDir, "late-open-source.txt");
    const targetUri = C.pathToUri(target);
    fs.writeFileSync(source, "source");
    spyOn(lumine.window, "confirm").and.resolveTo(0);

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { kind: "create", uri: targetUri },
        {
          textDocument: { uri: targetUri, version: null },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "open target",
            },
          ],
        },
        {
          kind: "rename",
          oldUri: C.pathToUri(source),
          newUri: targetUri,
          options: { overwrite: true },
        },
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("while it is open in the workspace");
    expect(result.failedChange).toBe(2);
    expect(executor.plans[0].executeNext.calls.count()).toBe(1);
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.readFileSync(target, "utf8")).toBe("");
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
