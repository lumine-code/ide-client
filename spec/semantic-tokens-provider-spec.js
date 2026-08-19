const path = require("path");
const os = require("os");
const { Emitter } = require("lumine");
const SemanticTokensProvider = require("../lib/semantic-tokens-provider");

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const LEGEND = {
  tokenTypes: ["keyword", "variable", "string"],
  tokenModifiers: ["declaration", "deprecated"],
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

const makeSession = (
  respond,
  options = { legend: LEGEND, full: { delta: true }, range: true },
) => ({
  state: "running",
  capabilities: {},
  supports: () => true,
  capabilityOptions: (method) => (method === "textDocument/semanticTokens" ? options : undefined),
  requests: [],
  request(method, params) {
    this.requests.push({ method, params });
    return Promise.resolve(respond(method, params));
  },
});

describe("SemanticTokensProvider", () => {
  let editor, provider;

  beforeEach(async () => {
    editor = await lumine.workspace.open(
      path.join(os.tmpdir(), "semantic-tokens-provider-example.js"),
    );
    editor.setText("const sum = add(first, second);\nlet x = 5;\n");
  });

  afterEach(() => provider?.dispose());

  it("advertises the semantic token client capabilities to every session", () => {
    const manager = makeManager(null);
    provider = new SemanticTokensProvider(manager);
    const [fragment] = manager.fragments;
    const advertised = fragment.textDocument.semanticTokens;
    expect(advertised.requests).toEqual({ full: { delta: true }, range: true });
    expect(advertised.formats).toEqual(["relative"]);
    expect(advertised.augmentsSyntaxTokens).toBe(true);
    // The standard names, so a server knows which of its classifications this
    // client can name back.
    expect(advertised.tokenTypes).toContain("enumMember");
    expect(advertised.tokenTypes.length).toBe(23);
    expect(advertised.tokenModifiers).toContain("defaultLibrary");
    expect(advertised.tokenModifiers.length).toBe(10);
    expect(fragment.workspace).toEqual({ semanticTokens: { refreshSupport: true } });
    expect(provider.grammarScopes).toEqual(["source.js"]);
    expect(provider.priority).toBe(2);
  });

  it("decodes the packed array into absolute tokens named by the legend", async () => {
    // Two tokens on row 0 and one on row 1, relative-encoded.
    const data = [0, 0, 5, 0, 0, 0, 6, 3, 1, 2, 1, 4, 1, 2, 0];
    const session = makeSession((method) =>
      method === "textDocument/semanticTokens/full" ? { data, resultId: "r1" } : null,
    );
    provider = new SemanticTokensProvider(makeManager(session));

    expect(await provider.semanticTokens(editor)).toEqual([
      { row: 0, column: 0, length: 5, type: "keyword", modifiers: [] },
      { row: 0, column: 6, length: 3, type: "variable", modifiers: ["deprecated"] },
      { row: 1, column: 4, length: 1, type: "string", modifiers: [] },
    ]);
    expect(session.requests[0].params.textDocument.uri).toContain(
      "semantic-tokens-provider-example.js",
    );
  });

  it("leaves a type the legend does not name unclassified", async () => {
    const session = makeSession((method) =>
      method === "textDocument/semanticTokens/full" ? { data: [0, 0, 5, 9, 0] } : null,
    );
    provider = new SemanticTokensProvider(makeManager(session));

    const [token] = await provider.semanticTokens(editor);
    expect(token.type).toBeNull();
  });

  it("asks for a delta against the previous result and applies the edits", async () => {
    let answer = { data: [0, 0, 5, 0, 0], resultId: "r1" };
    const session = makeSession((method) => {
      if (method === "textDocument/semanticTokens/full") return answer;
      if (method === "textDocument/semanticTokens/full/delta") return answer;
      return null;
    });
    provider = new SemanticTokensProvider(makeManager(session));

    await provider.semanticTokens(editor);
    // The type index changes from keyword to string, as one edit.
    answer = { resultId: "r2", edits: [{ start: 3, deleteCount: 1, data: [2] }] };
    const tokens = await provider.semanticTokens(editor);

    const delta = session.requests.find(
      ({ method }) => method === "textDocument/semanticTokens/full/delta",
    );
    expect(delta.params.previousResultId).toBe("r1");
    expect(tokens).toEqual([{ row: 0, column: 0, length: 5, type: "string", modifiers: [] }]);
  });

  it("sends a plain full request when the server offers no delta", async () => {
    const session = makeSession(
      (method) =>
        method === "textDocument/semanticTokens/full"
          ? { data: [0, 0, 5, 0, 0], resultId: "r1" }
          : null,
      { legend: LEGEND, full: true, range: true },
    );
    provider = new SemanticTokensProvider(makeManager(session));

    await provider.semanticTokens(editor);
    await provider.semanticTokens(editor);
    expect(
      session.requests.every(({ method }) => method === "textDocument/semanticTokens/full"),
    ).toBe(true);
  });

  it("asks for a row range as an LSP range ending past the last row", async () => {
    const session = makeSession((method) =>
      method === "textDocument/semanticTokens/range" ? { data: [0, 0, 5, 0, 0] } : null,
    );
    provider = new SemanticTokensProvider(makeManager(session));

    const tokens = await provider.semanticTokensInRange(editor, [4, 9]);
    expect(session.requests[0].params.range).toEqual({
      start: { line: 4, character: 0 },
      end: { line: 10, character: 0 },
    });
    expect(tokens).toEqual([{ row: 0, column: 0, length: 5, type: "keyword", modifiers: [] }]);
  });

  // A range request means the consumer gave up on whole-document rendering for
  // that editor, so the result a delta would be computed against is worthless.
  it("drops the delta cache once a range is asked for", async () => {
    const session = makeSession((method) => {
      if (method === "textDocument/semanticTokens/full")
        return { data: [0, 0, 5, 0, 0], resultId: "r1" };
      if (method === "textDocument/semanticTokens/range") return { data: [] };
      return null;
    });
    provider = new SemanticTokensProvider(makeManager(session));

    await provider.semanticTokens(editor);
    await provider.semanticTokensInRange(editor, [0, 1]);
    await provider.semanticTokens(editor);

    expect(session.requests.map(({ method }) => method)).toEqual([
      "textDocument/semanticTokens/full",
      "textDocument/semanticTokens/range",
      "textDocument/semanticTokens/full",
    ]);
  });

  it("declines a mode the server does not serve, and an editor with no session", async () => {
    const fullOnly = makeSession(() => ({ data: [] }), { legend: LEGEND, full: true });
    provider = new SemanticTokensProvider(makeManager(fullOnly));
    expect(await provider.semanticTokensInRange(editor, [0, 1])).toBeNull();
    // Nothing reached the wire: the capability said so before the request.
    expect(fullOnly.requests.length).toBe(0);
    provider.dispose();

    const rangeOnly = makeSession(() => ({ data: [] }), { legend: LEGEND, range: true });
    provider = new SemanticTokensProvider(makeManager(rangeOnly));
    expect(await provider.semanticTokens(editor)).toBeNull();
    provider.dispose();

    // A server that registered no legend can name nothing, so there is nothing
    // to serve however it answers.
    const legendless = makeSession(() => ({ data: [] }), { full: true, range: true });
    provider = new SemanticTokensProvider(makeManager(legendless));
    expect(await provider.semanticTokens(editor)).toBeNull();
    provider.dispose();

    provider = new SemanticTokensProvider(makeManager(null));
    expect(await provider.semanticTokens(editor)).toBeNull();
  });

  // The renderer reads a rejection as "keep what is on screen", which a caught
  // error would turn into "this file has no tokens".
  it("lets a failed request reject rather than reporting an empty answer", async () => {
    const session = makeSession(() => {
      throw new Error("ContentModified");
    });
    provider = new SemanticTokensProvider(makeManager(session));

    await expectAsync(provider.semanticTokens(editor)).toBeRejectedWithError("ContentModified");
  });

  it("does not father a delta from a result the server declared void", async () => {
    const session = makeSession(() => ({ data: [0, 0, 5, 0, 0], resultId: "r1" }));
    const manager = makeManager(session);
    provider = new SemanticTokensProvider(manager);

    await provider.semanticTokens(editor);
    manager.requestRefresh({}, "semanticTokens");
    await provider.semanticTokens(editor);

    expect(session.requests.map(({ method }) => method)).toEqual([
      "textDocument/semanticTokens/full",
      "textDocument/semanticTokens/full",
    ]);
  });

  it("invalidates when the server asks for a refresh and when a session starts", async () => {
    const manager = makeManager(makeSession(() => ({ data: [] })));
    provider = new SemanticTokensProvider(manager);
    const invalidated = jasmine.createSpy("invalidated");
    provider.onDidInvalidate(invalidated);

    manager.requestRefresh({}, "inlayHint");
    expect(invalidated).not.toHaveBeenCalled();

    manager.requestRefresh({}, "semanticTokens");
    expect(invalidated.calls.count()).toBe(1);

    manager.changeSession({}, "stopped");
    expect(invalidated.calls.count()).toBe(1);

    manager.changeSession({}, "running");
    expect(invalidated.calls.count()).toBe(2);

    // A capability registered after startup was absent when the consumer last
    // asked, so it concluded the server could not classify this file at all.
    manager.registerCapabilities({});
    expect(invalidated.calls.count()).toBe(3);
    await flush();
  });
});
