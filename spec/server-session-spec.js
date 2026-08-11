const fs = require("fs");
const os = require("os");
const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const ServerSession = require("../lib/server-session");

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

  const startSession = async (config = {}, adapterExtras = {}) => {
    const launch = {
      command: process.execPath,
      args: [FIXTURE, JSON.stringify(config)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const adapter = {
      id: "fake",
      displayName: "Fake Server",
      grammarScopes: ["source.js"],
      resolveServer: () => launch,
      ...adapterExtras,
    };
    const session = new ServerSession(manager, adapter, tempDir, launch);
    sessions.push(session);
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
    expect(initialize.params.capabilities.textDocument.diagnostic).toEqual({
      dynamicRegistration: false,
      relatedDocumentSupport: true,
    });
    expect(initialize.params.capabilities.workspace.diagnostics.refreshSupport).toBe(true);
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

  it("lets the server exit on its own rather than killing it mid-frame", async () => {
    const session = await startSession();
    const child = session.process;
    await session.stop();
    expect(session.state).toBe("stopped");
    // `exit` was read and acted on: a killed process reports its signal here.
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
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
});
