const fs = require("fs");
const os = require("os");
const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const NotebookDocuments = require("../lib/notebook-documents");
const ServerSession = require("../lib/server-session");
const {
  notebookSyncMatches,
  selectorLanguages,
  diffCellOrder,
} = require("../lib/notebook-documents");
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

// The two selector shapes verified against real servers.
const RUFF_SYNC = { notebookSelector: [{ cells: [{ language: "python" }] }], save: false };
const BASEDPYRIGHT_SYNC = {
  notebookSelector: [
    {
      notebook: { scheme: "file", notebookType: "jupyter-notebook" },
      cells: [{ language: "python" }],
    },
  ],
  save: true,
};

describe("notebook sync selectors", () => {
  const jupyterPython = {
    notebookType: "jupyter-notebook",
    cellLanguageIds: ["python"],
  };
  it("matches the cells-only shape ruff advertises", () => {
    expect(notebookSyncMatches(RUFF_SYNC, jupyterPython)).toBe(true);
    expect(notebookSyncMatches(RUFF_SYNC, { ...jupyterPython, cellLanguageIds: ["r"] })).toBe(
      false,
    );
  });
  it("matches the notebook-plus-cells shape basedpyright advertises", () => {
    expect(notebookSyncMatches(BASEDPYRIGHT_SYNC, jupyterPython)).toBe(true);
    expect(
      notebookSyncMatches(BASEDPYRIGHT_SYNC, {
        ...jupyterPython,
        notebookType: "other-notebook",
      }),
    ).toBe(false);
  });
  it("declines a server that advertises no notebook sync at all", () => {
    expect(notebookSyncMatches(undefined, jupyterPython)).toBe(false);
    expect(notebookSyncMatches({}, jupyterPython)).toBe(false);
  });
  it("honors notebook globs and wildcard filters", () => {
    const wildcard = {
      notebookSelector: [
        {
          notebook: { notebookType: "*", scheme: "*", pattern: "**/books/**" },
          cells: [{ language: "*" }],
        },
      ],
    };
    expect(
      notebookSyncMatches(wildcard, {
        ...jupyterPython,
        filePath: path.join("C:", "work", "books", "one.ipynb"),
      }),
    ).toBe(true);
    expect(
      notebookSyncMatches(wildcard, {
        ...jupyterPython,
        filePath: path.join("C:", "work", "notes", "one.ipynb"),
      }),
    ).toBe(false);
  });
  it("unites cell languages only across selectors matching this notebook", () => {
    const options = {
      notebookSelector: [
        { notebook: "jupyter-notebook", cells: [{ language: "python" }] },
        { notebook: "jupyter-notebook", cells: [{ language: "javascript" }] },
        { notebook: "quarto", cells: [{ language: "r" }] },
      ],
    };
    const context = {
      notebookType: "jupyter-notebook",
      filePath: path.join("C:", "work", "one.ipynb"),
      cellLanguageIds: ["javascript"],
    };
    expect(notebookSyncMatches(options, context)).toBe(true);
    expect([...selectorLanguages(options, context)]).toEqual(["python", "javascript"]);
    expect(notebookSyncMatches(options, { ...context, cellLanguageIds: ["r"] })).toBe(false);
  });
});

describe("diffCellOrder", () => {
  it("reports no change for identical orders", () => {
    const diff = diffCellOrder(["a", "b"], ["a", "b"]);
    expect(diff.changed).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
  it("expresses an append as a tail splice", () => {
    const diff = diffCellOrder(["a"], ["a", "b"]);
    expect(diff.splice).toEqual({ start: 1, deleteCount: 0, ids: ["b"] });
    expect(diff.added).toEqual(["b"]);
  });
  it("expresses a removal as a deleting splice", () => {
    const diff = diffCellOrder(["a", "b", "c"], ["a", "c"]);
    expect(diff.splice).toEqual({ start: 1, deleteCount: 1, ids: [] });
    expect(diff.removed).toEqual(["b"]);
  });
  it("expresses a reorder without opening or closing anything", () => {
    const diff = diffCellOrder(["a", "b", "c"], ["c", "a", "b"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toBe(true);
    expect(diff.splice.start).toBe(0);
    expect(diff.splice.deleteCount).toBe(3);
    expect(diff.splice.ids).toEqual(["c", "a", "b"]);
  });
});

describe("NotebookDocuments against a fake server", () => {
  let manager, notebooks, tempDir, editors, notebookPath;

  const buildCellEditor = (text) => {
    const editor = lumine.workspace.buildTextEditor();
    editor.setText(text);
    editors.push(editor);
    return editor;
  };

  const registerFakeAdapter = (config = {}, extras = {}) => {
    const launch = {
      command: process.execPath,
      args: [FIXTURE, JSON.stringify(config)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const adapter = {
      id: "fake",
      displayName: "Fake Server",
      // buildTextEditor's default grammar, so adaptersForEditor matches.
      grammarScopes: ["text.plain.null-grammar"],
      languageId: "python",
      resolveServer: () => launch,
      ...extras,
    };
    manager.registerAdapter(adapter);
    return adapter;
  };

  const theSession = () => manager.allSessions()[0];
  const received = async () => theSession().request("test/getReceived");
  const ofMethod = async (method) =>
    (await received()).filter((message) => message.method === method);

  beforeEach(() => {
    jasmine.useRealClock();
    manager = new LanguageServerManager();
    notebooks = new NotebookDocuments(manager);
    manager.setNotebookDocuments(notebooks);
    editors = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-client-nb-"));
    notebookPath = path.join(tempDir, "nb.ipynb");
  });

  afterEach(async () => {
    notebooks.dispose();
    for (const editor of editors) editor.destroy();
    await manager.deactivate();
  });

  it("forgets a failed initial session so a later notebook attach can start fresh", async () => {
    let attempts = 0;
    let failedSession;
    spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      attempts++;
      if (attempts === 1) {
        failedSession = this;
        throw new Error("initial notebook start failed");
      }
      this.capabilities = { notebookDocumentSync: RUFF_SYNC };
      this.connection = { notify: jasmine.createSpy("notify") };
      this.setState("running");
    });
    const stop = spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.setState("stopped");
    });
    const report = spyOn(manager, "reportStartFailure");
    registerFakeAdapter();
    const editor = buildCellEditor("x = 1\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor, scopeName: "text.plain.null-grammar" }],
    });

    await bridge.attached;

    expect(report.calls.count()).toBe(1);
    expect(report.calls.mostRecent().args[2].message).toBe("initial notebook start failed");
    expect(stop).toHaveBeenCalled();
    expect(manager.allSessions()).toEqual([]);
    expect(manager.controllers.size).toBe(0);

    await notebooks.reattachAll();

    const replacement = manager.allSessions()[0];
    expect(attempts).toBe(2);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(failedSession);
    expect(replacement.state).toBe("running");
    expect(report.calls.count()).toBe(1);
  });

  it("reports a notebook resolver failure once through the shared ensure operation", async () => {
    const adapter = {
      id: "fake",
      displayName: "Fake Server",
      grammarScopes: ["text.plain.null-grammar"],
      languageId: "python",
      resolveServer: jasmine
        .createSpy("resolveServer")
        .and.rejectWith(new Error("notebook resolve failed")),
    };
    manager.registerAdapter(adapter);
    const report = spyOn(manager, "reportStartFailure").and.callThrough();
    const notification = spyOn(lumine.notifications, "addError");
    const editor = buildCellEditor("x = 1\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor, scopeName: "text.plain.null-grammar" }],
    });

    await bridge.attached;

    expect(adapter.resolveServer.calls.count()).toBe(1);
    expect(report.calls.count()).toBe(1);
    expect(notification.calls.count()).toBe(1);
    expect(manager.allSessions()).toEqual([]);
  });

  it("opens the notebook once, with cell documents and never textDocument/didOpen", async () => {
    registerFakeAdapter({ capabilities: { notebookDocumentSync: RUFF_SYNC } });
    const a = buildCellEditor("import os\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [
        { id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" },
        { id: "m1", kind: "markup", scopeName: "source.gfm" },
      ],
    });
    await bridge.attached;

    const opens = await ofMethod("notebookDocument/didOpen");
    expect(opens.length).toBe(1);
    const open = opens[0].params;
    expect(open.notebookDocument.notebookType).toBe("jupyter-notebook");
    expect(open.notebookDocument.uri).toBe(C.pathToUri(notebookPath));
    // Only the code cell is synced; the markup cell never reaches the wire.
    expect(open.notebookDocument.cells.length).toBe(1);
    expect(open.notebookDocument.cells[0].kind).toBe(2);
    expect(open.cellTextDocuments).toEqual([
      {
        uri: bridge.uriForCell("c1"),
        languageId: "python",
        version: 1,
        text: "import os\n",
      },
    ]);
    expect(await ofMethod("textDocument/didOpen")).toEqual([]);
    // The cell document keeps the session alive and routes the cell editor.
    expect(theSession().documents.has(C.uriKey(bridge.uriForCell("c1")))).toBe(true);
    expect(manager.sessionsForEditor(a)).toEqual([theSession()]);
  });

  it("syncs typing as incremental cell text changes", async () => {
    registerFakeAdapter({ capabilities: { notebookDocumentSync: RUFF_SYNC } });
    const a = buildCellEditor("x = 1\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;

    a.getBuffer().append("y = 2\n");
    await until(async () => (await ofMethod("notebookDocument/didChange")).length > 0);
    const change = (await ofMethod("notebookDocument/didChange"))[0].params;
    expect(change.notebookDocument.uri).toBe(C.pathToUri(notebookPath));
    const textContent = change.change.cells.textContent;
    expect(textContent.length).toBe(1);
    expect(textContent[0].document.uri).toBe(bridge.uriForCell("c1"));
    expect(textContent[0].document.version).toBe(2);
    expect(textContent[0].changes[0].text).toBe("y = 2\n");
    expect(textContent[0].changes[0].range).toBeDefined();
  });

  it("transforms notebook text on open and sends transformed full changes", async () => {
    registerFakeAdapter(
      { capabilities: { notebookDocumentSync: RUFF_SYNC } },
      { transformDocumentText: (text) => text.replaceAll("secret", "hidden") },
    );
    const editor = buildCellEditor("secret = 1\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;

    const open = (await ofMethod("notebookDocument/didOpen"))[0].params;
    expect(open.cellTextDocuments[0].text).toBe("hidden = 1\n");

    editor.setText("secret = 2\n");
    await until(async () => (await ofMethod("notebookDocument/didChange")).length > 0);
    const textContent = (await ofMethod("notebookDocument/didChange"))[0].params.change.cells
      .textContent[0];
    expect(textContent.changes).toEqual([{ text: "hidden = 2\n" }]);
  });

  it("expresses structure changes as splices with cell open and close", async () => {
    registerFakeAdapter({ capabilities: { notebookDocumentSync: RUFF_SYNC } });
    const a = buildCellEditor("a\n");
    const b = buildCellEditor("b\n");
    const cellA = { id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" };
    const cellB = { id: "c2", kind: "code", editor: b, scopeName: "text.plain.null-grammar" };
    const bridge = notebooks.open({ filePath: notebookPath, cells: [cellA] });
    await bridge.attached;

    await bridge.updateCells([cellA, cellB]);
    let changes = await ofMethod("notebookDocument/didChange");
    const insert = changes[changes.length - 1].params.change.cells.structure;
    expect(insert.array).toEqual({
      start: 1,
      deleteCount: 0,
      cells: [{ kind: 2, document: bridge.uriForCell("c2") }],
    });
    expect(insert.didOpen.length).toBe(1);
    expect(insert.didOpen[0].text).toBe("b\n");
    expect(insert.didClose).toEqual([]);
    expect(theSession().documents.has(C.uriKey(bridge.uriForCell("c2")))).toBe(true);

    // A reorder splices without opening or closing any document.
    await bridge.updateCells([cellB, cellA]);
    changes = await ofMethod("notebookDocument/didChange");
    const reorder = changes[changes.length - 1].params.change.cells.structure;
    expect(reorder.didOpen).toEqual([]);
    expect(reorder.didClose).toEqual([]);
    expect(reorder.array.deleteCount).toBe(2);

    // A removal closes the cell document and evicts its diagnostics.
    const published = [];
    const subscription = manager.onDidPublishDiagnostics((params) => published.push(params));
    await bridge.updateCells([cellB]);
    changes = await ofMethod("notebookDocument/didChange");
    const removal = changes[changes.length - 1].params.change.cells.structure;
    expect(removal.didClose).toEqual([{ uri: bridge.uriForCell("c1") }]);
    expect(theSession().documents.has(C.uriKey(bridge.uriForCell("c1")))).toBe(false);
    expect(
      published.some(
        (params) => params.uri === bridge.uriForCell("c1") && params.diagnostics.length === 0,
      ),
    ).toBe(true);
    subscription.dispose();
  });

  it("versions one logical structure change once across two server projections", async () => {
    const scopes = ["text.plain.null-grammar", "source.js"];
    registerFakeAdapter(
      { capabilities: { notebookDocumentSync: RUFF_SYNC } },
      { id: "fake-python", displayName: "Python Server", grammarScopes: scopes },
    );
    registerFakeAdapter(
      {
        capabilities: {
          notebookDocumentSync: {
            notebookSelector: [{ cells: [{ language: "*" }] }],
            save: false,
          },
        },
      },
      { id: "fake-all", displayName: "All Cells Server", grammarScopes: scopes },
    );
    const a = buildCellEditor("a\n");
    const b = buildCellEditor("b\n");
    const c = buildCellEditor("c\n");
    spyOn(b, "getGrammar").and.returnValue({ scopeName: "source.js" });
    const cellA = { id: "c1", kind: "code", editor: a };
    const cellB = { id: "c2", kind: "code", editor: b };
    const cellC = { id: "c3", kind: "code", editor: c };
    const bridge = notebooks.open({ filePath: notebookPath, cells: [cellA] });
    await bridge.attached;
    const byId = (id) => manager.allSessions().find((session) => session.adapter.id === id);
    const python = byId("fake-python");
    const all = byId("fake-all");
    const record = [...notebooks.records][0];

    // JavaScript is outside the Python server's projection, but adding it is
    // still one logical notebook change. Only the all-cells server advances.
    await bridge.updateCells([cellA, cellB]);
    await until(async () =>
      (await all.request("test/getReceived")).some(
        ({ method }) => method === "notebookDocument/didChange",
      ),
    );
    expect(record.version).toBe(2);
    expect(record.versionFor(python)).toBe(1);
    expect(record.versionFor(all)).toBe(2);

    // Adding a Python cell changes both projections. Both notifications carry
    // the same next version rather than advancing once per session.
    await bridge.updateCells([cellA, cellB, cellC]);
    await until(async () => {
      const messages = await Promise.all(
        [python, all].map((session) => session.request("test/getReceived")),
      );
      return messages.every((items) =>
        items.some(
          ({ method, params }) =>
            method === "notebookDocument/didChange" &&
            params.notebookDocument.version === record.version,
        ),
      );
    });
    expect(record.version).toBe(3);
    expect(record.versionFor(python)).toBe(3);
    expect(record.versionFor(all)).toBe(3);

    const uri = bridge.uriForCell("c1");
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "problem",
    };
    expect(manager.publishDiagnostics(python, { uri, version: 3, diagnostics: [diagnostic] })).toBe(
      true,
    );
    expect(manager.publishDiagnostics(all, { uri, version: 3, diagnostics: [diagnostic] })).toBe(
      true,
    );
    expect(manager.diagnosticsFor(python, uri)).toEqual([diagnostic]);
    expect(manager.diagnosticsFor(all, uri)).toEqual([diagnostic]);
  });

  it("sends didSave only to servers whose sync options ask for it", async () => {
    registerFakeAdapter({
      capabilities: { notebookDocumentSync: { ...RUFF_SYNC, save: false } },
    });
    const a = buildCellEditor("a\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;
    bridge.didSave();
    expect(await ofMethod("notebookDocument/didSave")).toEqual([]);
  });

  it("sends didSave to a server that declared save support", async () => {
    registerFakeAdapter({
      capabilities: { notebookDocumentSync: BASEDPYRIGHT_SYNC },
    });
    const a = buildCellEditor("a\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;
    bridge.didSave();
    await until(async () => (await ofMethod("notebookDocument/didSave")).length === 1);
    const saves = await ofMethod("notebookDocument/didSave");
    expect(saves[0].params.notebookDocument.uri).toBe(C.pathToUri(notebookPath));
  });

  it("closes the notebook and its cell documents on dispose", async () => {
    registerFakeAdapter({ capabilities: { notebookDocumentSync: RUFF_SYNC } });
    const a = buildCellEditor("a\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;
    const cellUri = bridge.uriForCell("c1");

    bridge.dispose();
    await until(async () => (await ofMethod("notebookDocument/didClose")).length === 1);
    const close = (await ofMethod("notebookDocument/didClose"))[0].params;
    expect(close.cellTextDocuments).toEqual([{ uri: cellUri }]);
    expect(theSession().documents.size).toBe(0);
    expect(manager.sessionsForEditor(a)).toEqual([]);
  });

  it("never shows the notebook to a server without notebook sync", async () => {
    registerFakeAdapter({ capabilities: { textDocumentSync: 2 } });
    const a = buildCellEditor("a\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;

    // The session exists — the adapter matched — but the notebook was never
    // opened on it, and the cell editor routes to no session.
    expect(manager.allSessions().length).toBe(1);
    expect(await ofMethod("notebookDocument/didOpen")).toEqual([]);
    expect(manager.sessionsForEditor(a)).toEqual([]);
  });

  it("skips untitled notebooks until they have a path", () => {
    expect(notebooks.open({ filePath: null, cells: [] })).toBeNull();
  });

  it("attaches when the cells arrive after an empty open", async () => {
    // A restored notebook's document registers before it loads, so the bridge
    // legitimately opens with no cells; the arrival must do the attaching.
    registerFakeAdapter({ capabilities: { notebookDocumentSync: RUFF_SYNC } });
    const bridge = notebooks.open({ filePath: notebookPath, cells: [] });
    await bridge.attached;
    expect(manager.allSessions().length).toBe(0);

    const a = buildCellEditor("import os\n");
    await bridge.updateCells([
      { id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" },
    ]);

    const opens = await ofMethod("notebookDocument/didOpen");
    expect(opens.length).toBe(1);
    expect(opens[0].params.cellTextDocuments[0].text).toBe("import os\n");
    expect(manager.sessionsForEditor(a)).toEqual([theSession()]);
  });

  it("hands a late-built editor to the session's cell document", async () => {
    registerFakeAdapter({ capabilities: { notebookDocumentSync: RUFF_SYNC } });
    const a = buildCellEditor("a\n");
    const cellA = { id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" };
    const cellB = { id: "c2", kind: "code", text: "b\n", scopeName: "text.plain.null-grammar" };
    const bridge = notebooks.open({ filePath: notebookPath, cells: [cellA, cellB] });
    await bridge.attached;
    const key = C.uriKey(bridge.uriForCell("c2"));
    expect(theSession().documents.get(key).editor).toBeNull();

    // etch built the cell's editor after the didOpen shipped the model text.
    const b = buildCellEditor("b\n");
    await bridge.updateCells([cellA, { ...cellB, editor: b }]);

    expect(theSession().documents.get(key).editor).toBe(b);
    // The arrival grounded the server's copy in the buffer.
    const changes = await ofMethod("notebookDocument/didChange");
    const grounding = changes.find((message) =>
      message.params.change.cells?.textContent?.some(
        (content) => content.document.uri === bridge.uriForCell("c2"),
      ),
    );
    expect(grounding).toBeDefined();
  });

  it("clears an editor-less cell's routing entry when the cell goes", async () => {
    registerFakeAdapter({ capabilities: { notebookDocumentSync: RUFF_SYNC } });
    const a = buildCellEditor("a\n");
    const cellA = { id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" };
    const cellB = { id: "c2", kind: "code", text: "b\n", scopeName: "text.plain.null-grammar" };
    const bridge = notebooks.open({ filePath: notebookPath, cells: [cellA, cellB] });
    await bridge.attached;
    const key = C.uriKey(bridge.uriForCell("c2"));
    expect(manager.externalUris.has(key)).toBe(true);

    await bridge.updateCells([cellA]);
    expect(manager.externalUris.has(key)).toBe(false);
  });

  it("accepts cell diagnostics stamped with either the cell or the notebook version", async () => {
    // Servers disagree on which counter a cell publish carries: basedpyright
    // stamps the cell text document's version, ruff the notebook document's.
    // Insisting on the cell's dropped every ruff cell publish as stale.
    registerFakeAdapter({ capabilities: { notebookDocumentSync: RUFF_SYNC } });
    const a = buildCellEditor("import os\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;
    const record = [...notebooks.records][0];
    const session = theSession();
    const uri = bridge.uriForCell("c1");
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
      message: "unused",
    };

    manager.publishDiagnostics(session, {
      uri,
      version: record.version,
      diagnostics: [diagnostic],
    });
    expect(manager.diagnosticsFor(session, uri).length).toBe(1);

    manager.publishDiagnostics(session, {
      uri,
      version: record.cellVersion("c1"),
      diagnostics: [diagnostic, diagnostic],
    });
    expect(manager.diagnosticsFor(session, uri).length).toBe(2);

    // A version that is neither counter is still stale and still dropped.
    manager.publishDiagnostics(session, { uri, version: 999, diagnostics: [] });
    expect(manager.diagnosticsFor(session, uri).length).toBe(2);
  });

  it("never pulls diagnostics for notebook cells", async () => {
    // Cell diagnostics ride the notebook push channel. A server that also
    // offers pull can answer a cell pull with an empty full report that
    // contradicts its own pushes — ruff does exactly that, which wiped the
    // cell's messages the moment typing paused.
    registerFakeAdapter({
      capabilities: {
        notebookDocumentSync: RUFF_SYNC,
        diagnosticProvider: { identifier: "fake" },
      },
    });
    const a = buildCellEditor("import os\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;

    a.getBuffer().append("x = 1\n");
    await until(async () => (await ofMethod("notebookDocument/didChange")).length > 0);
    // Past the pull debounce: the change synced, and no pull followed it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await ofMethod("textDocument/diagnostic")).toEqual([]);
  });

  it("prunes a dead session's adapter from the stand-down answer", async () => {
    const adapter = registerFakeAdapter({
      capabilities: { notebookDocumentSync: RUFF_SYNC },
    });
    const a = buildCellEditor("a\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;
    expect(notebooks.adaptersForNotebook(notebookPath)).toEqual([adapter]);

    // The server going away takes its diagnostics with it; a CLI route that
    // stood down for them has to get the notebook back.
    await manager.stopSession(theSession());
    expect(notebooks.adaptersForNotebook(notebookPath)).toEqual([]);
  });

  it("answers the stand-down question with the adapters serving the notebook", async () => {
    const adapter = registerFakeAdapter({
      capabilities: { notebookDocumentSync: RUFF_SYNC },
    });
    expect(notebooks.adaptersForNotebook(notebookPath)).toEqual([]);
    const a = buildCellEditor("a\n");
    const bridge = notebooks.open({
      filePath: notebookPath,
      cells: [{ id: "c1", kind: "code", editor: a, scopeName: "text.plain.null-grammar" }],
    });
    await bridge.attached;
    expect(notebooks.adaptersForNotebook(notebookPath)).toEqual([adapter]);
    bridge.dispose();
    expect(notebooks.adaptersForNotebook(notebookPath)).toEqual([]);
  });
});
