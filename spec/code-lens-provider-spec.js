const path = require("path");
const os = require("os");
const { Emitter } = require("lumine");
const CodeLensProvider = require("../lib/code-lens-provider");

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const makeManager = (session) => {
  const emitter = new Emitter();
  return {
    fragments: [],
    addCapabilityFragment(fragment) {
      this.fragments.push(fragment);
    },
    allGrammarScopes: () => ["source.js"],
    uriForEditor: (editor) => {
      const editorPath = editor.getPath?.();
      return editorPath ? require("../lib/converters").pathToUri(editorPath) : null;
    },
    activeSessionForFeature: async () => session,
    onDidRequestRefresh: (fn) => emitter.on("refresh", fn),
    onDidChangeSession: (fn) => emitter.on("session", fn),
    onDidChangeFeatures: (fn) => emitter.on("features", fn),
    onDidChangeCapabilities: (fn) => emitter.on("capabilities", fn),
    requestRefresh: (refreshSession, kind) =>
      emitter.emit("refresh", { session: refreshSession, kind }),
    changeSession: (changed, state) => emitter.emit("session", { session: changed, state }),
  };
};

const makeSession = (respond, capabilities = {}) => ({
  state: "running",
  capabilities,
  supports: () => true,
  capabilityOptions: () => capabilities.codeLensProvider,
  requests: [],
  request(method, params) {
    this.requests.push({ method, params });
    return Promise.resolve(respond(method, params));
  },
});

const lspLens = (row, title, extra = {}) => ({
  range: { start: { line: row, character: 0 }, end: { line: row, character: 1 } },
  ...(title ? { command: { title, command: "test.command", arguments: [row] } } : {}),
  ...extra,
});

describe("CodeLensProvider", () => {
  let editor, provider;

  beforeEach(async () => {
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "code-lens-provider-example.js"));
    editor.setText("function one() {}\nfunction two() {}\n");
  });

  afterEach(() => provider?.dispose());

  it("advertises the code lens client capabilities to every session", () => {
    const manager = makeManager(null);
    provider = new CodeLensProvider(manager);
    expect(manager.fragments).toEqual([
      {
        textDocument: { codeLens: { dynamicRegistration: true } },
        workspace: { codeLens: { refreshSupport: true } },
      },
    ]);
    expect(provider.grammarScopes).toEqual(["source.js"]);
    expect(provider.priority).toBe(2);
  });

  it("translates the server's lenses into the contract shape", async () => {
    const session = makeSession((method) =>
      method === "textDocument/codeLens" ? [lspLens(0, "3 references"), lspLens(1, null)] : null,
    );
    provider = new CodeLensProvider(makeManager(session));

    const lenses = await provider.codeLenses(editor);
    expect(lenses.length).toBe(2);
    // The contract takes a point-pair array as readily as a Range.
    expect(lenses[0].range).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(lenses[0].title).toBe("3 references");
    expect(typeof lenses[0].execute).toBe("function");
    // An unresolved lens carries no title, which is what makes it a placeholder.
    expect(lenses[1].title).toBeUndefined();
    expect(lenses[1].execute).toBeUndefined();

    const [request] = session.requests;
    expect(request.method).toBe("textDocument/codeLens");
    expect(request.params.textDocument.uri).toContain("code-lens-provider-example.js");
  });

  it("gives no execute to a lens whose command names nothing to run", async () => {
    const session = makeSession((method) =>
      method === "textDocument/codeLens"
        ? [{ ...lspLens(0, null), command: { title: "1 reference" } }]
        : null,
    );
    provider = new CodeLensProvider(makeManager(session));

    const [lens] = await provider.codeLenses(editor);
    expect(lens.title).toBe("1 reference");
    expect(lens.execute).toBeUndefined();
  });

  it("executes the lens command through the session that produced it", async () => {
    const session = makeSession((method) =>
      method === "textDocument/codeLens" ? [lspLens(0, "run test")] : null,
    );
    provider = new CodeLensProvider(makeManager(session));

    const [lens] = await provider.codeLenses(editor);
    await lens.execute();
    const executed = session.requests.find(({ method }) => method === "workspace/executeCommand");
    expect(executed.params).toEqual({ command: "test.command", arguments: [0] });
  });

  it("resolves a placeholder by sending back the payload the server produced", async () => {
    const session = makeSession(
      (method, params) => {
        if (method === "textDocument/codeLens") return [lspLens(1, null, { data: 7 })];
        if (method === "codeLens/resolve")
          return { ...params, command: { title: "Resolved", command: "test.resolved" } };
        return null;
      },
      { codeLensProvider: { resolveProvider: true } },
    );
    provider = new CodeLensProvider(makeManager(session));

    const [placeholder] = await provider.codeLenses(editor);
    const resolved = await provider.resolveCodeLens(placeholder);
    expect(resolved.title).toBe("Resolved");
    expect(resolved.range).toEqual([
      [1, 0],
      [1, 1],
    ]);

    const sent = session.requests.find(({ method }) => method === "codeLens/resolve");
    // The opaque `data` is only meaningful to the server that produced it, so
    // it must travel back untouched.
    expect(sent.params.data).toBe(7);
  });

  it("resolves a lens whose capability was registered dynamically", async () => {
    const session = makeSession((method, params) => {
      if (method === "textDocument/codeLens") return [lspLens(0, null, { data: 9 })];
      if (method === "codeLens/resolve")
        return { ...params, command: { title: "Dynamic", command: "test.dynamic" } };
      return null;
    });
    session.capabilityOptions = () => ({ resolveProvider: true });
    provider = new CodeLensProvider(makeManager(session));

    const [placeholder] = await provider.codeLenses(editor);
    const resolved = await provider.resolveCodeLens(placeholder);

    expect(resolved.title).toBe("Dynamic");
    expect(session.requests.some(({ method }) => method === "codeLens/resolve")).toBe(true);
  });

  it("does not resolve against a server that never offered to", async () => {
    const session = makeSession((method) =>
      method === "textDocument/codeLens" ? [lspLens(0, null)] : null,
    );
    provider = new CodeLensProvider(makeManager(session));

    const [placeholder] = await provider.codeLenses(editor);
    expect(await provider.resolveCodeLens(placeholder)).toBeNull();
    expect(session.requests.some(({ method }) => method === "codeLens/resolve")).toBe(false);
  });

  it("declines when no session serves the request", async () => {
    provider = new CodeLensProvider(makeManager(null));
    expect(await provider.codeLenses(editor)).toBeNull();
  });

  it("keeps the last answer when a request fails, rather than blanking the row", async () => {
    let fail = false;
    const session = makeSession((method) => {
      if (method !== "textDocument/codeLens") return null;
      if (fail) throw new Error("ContentModified");
      return [lspLens(0, "2 references")];
    });
    provider = new CodeLensProvider(makeManager(session));

    const first = await provider.codeLenses(editor);
    expect(first.length).toBe(1);

    fail = true;
    const second = await provider.codeLenses(editor);
    expect(second.map(({ title }) => title)).toEqual(["2 references"]);
  });

  it("invalidates when the server asks for a refresh and when a session starts", async () => {
    const manager = makeManager(makeSession(() => []));
    provider = new CodeLensProvider(manager);
    const invalidated = jasmine.createSpy("invalidated");
    provider.onDidInvalidate(invalidated);

    manager.requestRefresh({}, "semanticTokens");
    expect(invalidated).not.toHaveBeenCalled();

    manager.requestRefresh({}, "codeLens");
    expect(invalidated.calls.count()).toBe(1);

    manager.changeSession({}, "stopped");
    expect(invalidated.calls.count()).toBe(2);

    manager.changeSession({}, "running");
    expect(invalidated.calls.count()).toBe(3);
    await flush();
  });
});
