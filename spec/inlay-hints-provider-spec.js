const path = require("path");
const os = require("os");
const { Emitter } = require("lumine");
const InlayHintsProvider = require("../lib/inlay-hints-provider");

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
    registerCapabilities: (target) => emitter.emit("capabilities", { session: target }),
  };
};

const makeSession = (respond) => ({
  state: "running",
  capabilities: {},
  supports: () => true,
  requests: [],
  request(method, params) {
    this.requests.push({ method, params });
    return Promise.resolve(respond(method, params));
  },
});

const lspHint = (row, character, label, extra = {}) => ({
  position: { line: row, character },
  label,
  ...extra,
});

describe("InlayHintsProvider", () => {
  let editor, provider;

  beforeEach(async () => {
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "inlay-hints-provider-example.js"));
    editor.setText("const sum = add(first, second);\n\nlet x = 5;\n");
  });

  afterEach(() => provider?.dispose());

  it("advertises the inlay hint client capabilities to every session", () => {
    const manager = makeManager(null);
    provider = new InlayHintsProvider(manager);
    expect(manager.fragments).toEqual([
      {
        textDocument: {
          inlayHint: {
            dynamicRegistration: true,
            resolveSupport: {
              properties: ["tooltip", "textEdits", "label.tooltip", "label.command"],
            },
          },
        },
        workspace: { inlayHint: { refreshSupport: true } },
      },
    ]);
    expect(provider.grammarScopes).toEqual(["source.js"]);
    expect(provider.priority).toBe(2);
  });

  it("translates the server's hints into the contract shape", async () => {
    const session = makeSession((method) =>
      method === "textDocument/inlayHint"
        ? [
            lspHint(0, 11, ": number", { paddingLeft: true }),
            lspHint(2, 4, "x:", { kind: 2, tooltip: "ignored" }),
          ]
        : null,
    );
    provider = new InlayHintsProvider(makeManager(session));

    const hints = await provider.inlayHints(editor, [0, 2]);
    expect(hints).toEqual([
      { position: [0, 11], label: ": number", paddingLeft: true, paddingRight: false },
      { position: [2, 4], label: "x:", paddingLeft: false, paddingRight: false },
    ]);

    const [request] = session.requests;
    expect(request.method).toBe("textDocument/inlayHint");
    expect(request.params.textDocument.uri).toContain("inlay-hints-provider-example.js");
  });

  it("asks for the row range as an LSP range ending past the last row", async () => {
    const session = makeSession(() => []);
    provider = new InlayHintsProvider(makeManager(session));

    await provider.inlayHints(editor, [4, 9]);
    expect(session.requests[0].params.range).toEqual({
      start: { line: 4, character: 0 },
      end: { line: 10, character: 0 },
    });
  });

  it("joins the parts of a label a server splits, dropping what nothing renders", async () => {
    const session = makeSession((method) =>
      method === "textDocument/inlayHint"
        ? [
            lspHint(0, 11, [
              { value: ": " },
              { value: "number", tooltip: "the inferred type", command: { title: "go" } },
            ]),
          ]
        : null,
    );
    provider = new InlayHintsProvider(makeManager(session));

    const [hint] = await provider.inlayHints(editor, [0, 2]);
    expect(hint.label).toBe(": number");
  });

  it("drops a hint with no position and one whose label is empty", async () => {
    const session = makeSession((method) =>
      method === "textDocument/inlayHint"
        ? [lspHint(0, 11, ""), { label: "nowhere" }, lspHint(2, 4, "x:")]
        : null,
    );
    provider = new InlayHintsProvider(makeManager(session));

    const hints = await provider.inlayHints(editor, [0, 2]);
    expect(hints.map(({ label }) => label)).toEqual(["x:"]);
  });

  it("declines when no session serves the request", async () => {
    provider = new InlayHintsProvider(makeManager(null));
    expect(await provider.inlayHints(editor, [0, 2])).toBeNull();
  });

  // The renderer reads a rejection as "keep what is on screen", which a caught
  // error would turn into "there are no hints here" — every label blanking
  // whenever a server reindexes.
  it("lets a failed request reject rather than reporting an empty answer", async () => {
    const session = makeSession(() => {
      throw new Error("ContentModified");
    });
    provider = new InlayHintsProvider(makeManager(session));

    await expectAsync(provider.inlayHints(editor, [0, 2])).toBeRejectedWithError("ContentModified");
  });

  it("invalidates when the server asks for a refresh and when a session starts", async () => {
    const manager = makeManager(makeSession(() => []));
    provider = new InlayHintsProvider(manager);
    const invalidated = jasmine.createSpy("invalidated");
    provider.onDidInvalidate(invalidated);

    manager.requestRefresh({}, "semanticTokens");
    expect(invalidated).not.toHaveBeenCalled();

    manager.requestRefresh({}, "inlayHint");
    expect(invalidated.calls.count()).toBe(1);

    manager.changeSession({}, "stopped");
    expect(invalidated.calls.count()).toBe(1);

    manager.changeSession({}, "running");
    expect(invalidated.calls.count()).toBe(2);

    // A capability registered after startup was absent when the consumer last
    // asked, so it concluded the server could not serve hints at all.
    manager.registerCapabilities({});
    expect(invalidated.calls.count()).toBe(3);
    await flush();
  });
});
