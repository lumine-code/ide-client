const path = require("path");
const ServerSession = require("../lib/server-session");
const SymbolProvider = require("../lib/symbol-provider");
const CodeFormatProvider = require("../lib/code-format-provider");
const HoverProvider = require("../lib/hover-provider");
const C = require("../lib/converters");
const { FEATURES, METHOD_FEATURES, featuresKeyPath, featureEnabled } = require("../lib/features");

const FILE = path.join(__dirname, "example.js");

const stubEditor = (scopeName = "source.js") => ({
  getPath: () => FILE,
  getGrammar: () => ({ scopeName, name: "JavaScript" }),
  // Config accepts a plain array of scope names wherever a ScopeDescriptor
  // goes, which keeps the stub honest without reaching into src/.
  getRootScopeDescriptor: () => [scopeName],
  getTabLength: () => 2,
  getSoftTabs: () => true,
  isDestroyed: () => false,
});

const adapterFor = (id, extra = {}) => ({
  id,
  displayName: id,
  grammarScopes: ["source.js"],
  resolveServer: async () => null,
  ...extra,
});

// A session with a real `supports()` — the gate under test lives there, and a
// stub would prove nothing about it.
const sessionFor = (adapter, capabilities, result) => {
  const session = new ServerSession({ dynamicSupport: () => undefined }, adapter, "/root", {});
  session.state = "running";
  session.capabilities = capabilities;
  session.request = jasmine.createSpy("request").and.callFake(async () => result);
  return session;
};

const managerWith = (...sessions) => ({
  addCapabilityFragment() {},
  onDidChangeSession: () => ({ dispose() {} }),
  onDidChangeFeatures: () => ({ dispose() {} }),
  onDidChangeCapabilities: () => ({ dispose() {} }),
  uriForEditor: (editor) => {
    const editorPath = editor.getPath?.();
    return editorPath ? require("../lib/converters").pathToUri(editorPath) : null;
  },
  resolveUri: (uri) => {
    const resolvedPath = require("../lib/converters").uriToPath(uri);
    return resolvedPath ? { kind: "file", path: resolvedPath } : null;
  },
  allGrammarScopes: () => ["source.js"],
  activeSessionsForEditor: async () => sessions,
  activeSessionForFeature: async (editor, method, feature) =>
    sessions.find((session) => session.supports(method, editor, feature)) || null,
});

describe("feature switches", () => {
  afterEach(() => {
    for (const id of ["ide-a", "ide-b"])
      for (const feature of FEATURES) lumine.config.unset(`${id}.features.${feature}`);
  });

  describe("featureEnabled", () => {
    it("is on for a feature nobody has an opinion about", () => {
      expect(featureEnabled(adapterFor("ide-a"), "hover", stubEditor())).toBe(true);
    });
    it("reads the adapter's own config namespace", () => {
      lumine.config.set("ide-a.features.hover", false);
      expect(featureEnabled(adapterFor("ide-a"), "hover", stubEditor())).toBe(false);
      expect(featureEnabled(adapterFor("ide-b"), "hover", stubEditor())).toBe(true);
    });
    it("honours a scoped override", () => {
      lumine.config.set("ide-a.features.inlayHints", true);
      lumine.config.set("ide-a.features.inlayHints", false, { scopeSelector: ".source.js" });
      expect(featureEnabled(adapterFor("ide-a"), "inlayHints", stubEditor("source.js"))).toBe(
        false,
      );
      expect(featureEnabled(adapterFor("ide-a"), "inlayHints", stubEditor("source.py"))).toBe(true);
      lumine.config.unset("ide-a.features.inlayHints", { scopeSelector: ".source.js" });
    });
    it("falls back to what the adapter declared", () => {
      const adapter = adapterFor("ide-a", { features: { hover: false } });
      expect(featureEnabled(adapter, "hover", stubEditor())).toBe(false);
      // The user's setting is the one they can change, so it wins.
      lumine.config.set("ide-a.features.hover", true);
      expect(featureEnabled(adapter, "hover", stubEditor())).toBe(true);
    });
    it("gives a custom server no config namespace", () => {
      // `config:gopls` is not a key path, so reading one would silently create
      // a setting under a package that does not exist.
      const adapter = adapterFor("config:gopls", { features: { hover: false } });
      expect(featuresKeyPath(adapter)).toBeNull();
      expect(featureEnabled(adapter, "hover", stubEditor())).toBe(false);
    });
    it("covers every feature in the vocabulary with a method", () => {
      const mapped = new Set(Object.values(METHOD_FEATURES));
      const unmapped = FEATURES.filter((feature) => !mapped.has(feature));
      expect(unmapped).toEqual([]);
    });
  });

  describe("ServerSession#supports", () => {
    it("refuses a disabled feature the server does implement", () => {
      const session = sessionFor(adapterFor("ide-a"), { hoverProvider: true });
      expect(session.supports("textDocument/hover", stubEditor())).toBe(true);
      lumine.config.set("ide-a.features.hover", false);
      expect(session.supports("textDocument/hover", stubEditor())).toBe(false);
    });
    it("uses one symbols switch for every document-symbol consumer", () => {
      const session = sessionFor(adapterFor("ide-a"), { documentSymbolProvider: true });
      const editor = stubEditor();
      lumine.config.set("ide-a.features.symbols", false);
      expect(session.supports("textDocument/documentSymbol", editor)).toBe(false);
    });
    it("gates each hierarchy on its own switch", () => {
      // A server that offers both is normal, and wanting only one of them is
      // too — clangd's subtypes need an index its caller may not want built.
      const session = sessionFor(adapterFor("ide-a"), {
        callHierarchyProvider: true,
        typeHierarchyProvider: true,
      });
      const editor = stubEditor();
      lumine.config.set("ide-a.features.callHierarchy", false);
      expect(session.supports("textDocument/prepareCallHierarchy", editor)).toBe(false);
      expect(session.supports("textDocument/prepareTypeHierarchy", editor)).toBe(true);
    });
    it("switches off a hierarchy's follow-up requests with it", () => {
      // Half a hierarchy is worse than none: the root would open and every
      // expansion would come back empty.
      const session = sessionFor(adapterFor("ide-a"), { typeHierarchyProvider: true });
      const editor = stubEditor();
      // On, they pass through: a follow-up request carries no capability field
      // of its own, which is deliberate — it is what a server registering
      // dynamically registers under, and mapping it would deny that server.
      expect(session.supports("typeHierarchy/supertypes", editor)).toBe(true);
      lumine.config.set("ide-a.features.typeHierarchy", false);
      expect(session.supports("typeHierarchy/supertypes", editor)).toBe(false);
      expect(session.supports("typeHierarchy/subtypes", editor)).toBe(false);
    });
    it("checks the server provider behind generic raw routes", () => {
      const editor = stubEditor();
      const absent = sessionFor(adapterFor("ide-a"), {});
      const links = sessionFor(adapterFor("ide-b"), { documentLinkProvider: {} });
      const colors = sessionFor(adapterFor("ide-c"), { colorProvider: true });
      expect(absent.supports("textDocument/documentLink", editor)).toBe(false);
      expect(links.supports("textDocument/documentLink", editor)).toBe(true);
      expect(absent.supports("textDocument/documentColor", editor)).toBe(false);
      expect(colors.supports("textDocument/colorPresentation", editor)).toBe(true);
    });
  });

  describe("routing between two servers", () => {
    // The point of the switches: with two servers on one grammar the hub takes
    // whichever adapter registered first, and turning the feature off is how
    // the other one is chosen.
    const twoFormatters = () => {
      const first = sessionFor(adapterFor("ide-a"), { documentFormattingProvider: true }, [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          newText: "a",
        },
      ]);
      const second = sessionFor(adapterFor("ide-b"), { documentFormattingProvider: true }, [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          newText: "b",
        },
      ]);
      return [first, second];
    };

    it("hands formatting to the next server when the first has it switched off", async () => {
      const [first, second] = twoFormatters();
      const provider = new CodeFormatProvider(managerWith(first, second));
      expect((await provider.formatFile(stubEditor()))[0].newText).toBe("a");

      lumine.config.set("ide-a.features.format", false);
      expect((await provider.formatFile(stubEditor()))[0].newText).toBe("b");
      // Not merely filtered afterwards — the disabled server is never asked.
      expect(first.request.calls.count()).toBe(1);
    });

    it("drops one server's hover from the stacked tooltip", async () => {
      const first = sessionFor(
        adapterFor("ide-a"),
        { hoverProvider: true },
        {
          contents: "the type",
        },
      );
      const second = sessionFor(
        adapterFor("ide-b"),
        { hoverProvider: true },
        {
          contents: "the lint rule",
        },
      );
      const provider = new HoverProvider(managerWith(first, second));
      const both = await provider.hover(stubEditor(), { row: 0, column: 0 });
      expect(both.contents.value).toBe("the type\n\n---\n\nthe lint rule");

      lumine.config.set("ide-b.features.hover", false);
      const one = await provider.hover(stubEditor(), { row: 0, column: 0 });
      expect(one.contents.value).toBe("the type");
      expect(second.request.calls.count()).toBe(1);
    });

    it("keeps the navigation point and structural range of document symbols", async () => {
      const symbols = [
        {
          name: "thing",
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      ];
      const session = sessionFor(adapterFor("ide-a"), { documentSymbolProvider: true }, symbols);
      const found = await new SymbolProvider(managerWith(session)).getSymbols({
        editor: stubEditor(),
      });
      expect(found.map(({ name }) => name)).toEqual(["thing"]);
      expect(found[0].position).toEqual([0, 0]);
      expect(found[0].range).toEqual([
        [0, 0],
        [0, 5],
      ]);
    });

    it("coalesces symbol invalidations for only the editors a server can affect", async () => {
      const callbacks = {};
      const manager = managerWith();
      const editor = stubEditor();
      const otherEditor = stubEditor();
      const adapter = adapterFor("ide-a");
      const session = { adapter, state: "running" };
      manager.editorsForSession = (candidate) => (candidate === session ? [editor] : []);
      manager.editorsForAdapter = (candidate) => (candidate === adapter ? [editor] : []);
      manager.onDidChangeSession = (callback) => {
        callbacks.session = callback;
        return { dispose() {} };
      };
      manager.onDidChangeFeatures = (callback) => {
        callbacks.features = callback;
        return { dispose() {} };
      };
      manager.onDidChangeCapabilities = (callback) => {
        callbacks.capabilities = callback;
        return { dispose() {} };
      };
      const provider = new SymbolProvider(manager);
      const invalidate = jasmine.createSpy("invalidate");
      provider.onShouldClearCache(invalidate);

      callbacks.session({ session, state: "starting" });
      expect(invalidate).not.toHaveBeenCalled();
      callbacks.session({ session, state: "running" });
      callbacks.features({ adapter });
      callbacks.capabilities({ session });
      await Promise.resolve();

      expect(invalidate).toHaveBeenCalledOnceWith({ editor });
      expect(invalidate).not.toHaveBeenCalledWith({ editor: otherEditor });
      provider.destroy();
    });

    it("picks the server that can serve the query the symbol type will make", async () => {
      // A server with only references must not be picked to list symbols.
      const referencesOnly = sessionFor(adapterFor("ide-a"), { referencesProvider: true }, []);
      const symbolsOnly = sessionFor(adapterFor("ide-b"), { documentSymbolProvider: true }, []);
      const provider = new SymbolProvider(managerWith(referencesOnly, symbolsOnly));
      const editor = stubEditor();
      expect(await provider.sessionFor({ editor })).toBe(symbolsOnly);
      expect(await provider.sessionFor({ editor, type: "reference" })).toBe(referencesOnly);
    });
  });
});

describe("diagnostics switch", () => {
  let manager;
  let main;
  let adapter;
  let session;
  let messages;
  let registration;

  const push = (excerpt) =>
    manager.publishDiagnostics(session, {
      uri: C.pathToUri(FILE),
      diagnostics: [
        {
          severity: 1,
          message: excerpt,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
    });

  beforeEach(async () => {
    await lumine.packages.activatePackage("ide-client");
    main = lumine.packages.getActivePackage("ide-client").mainModule;
    manager = main.manager;
    adapter = adapterFor("ide-a");
    manager.registerAdapter(adapter);
    session = { adapter, state: "running", documents: new Map() };
    messages = new Map();
    // The real consumer, so the subscription under test is the one the linter
    // package actually installs.
    registration = main.consumeLinterRegistry(() => ({
      setMessages: (filePath, batch) => messages.set(filePath, batch),
      dispose() {},
    }));
  });

  afterEach(async () => {
    registration.dispose();
    lumine.config.unset("ide-a.features.diagnostics");
    await lumine.packages.deactivatePackage("ide-client");
  });

  it("publishes what a server reports", () => {
    push("broken");
    expect(messages.get(FILE).map(({ excerpt }) => excerpt)).toEqual(["broken"]);
  });

  it("clears and restores without restarting the server", () => {
    push("broken");
    lumine.config.set("ide-a.features.diagnostics", false);
    expect(messages.get(FILE)).toEqual([]);

    // Still stored, so switching back on does not need the server to say it
    // again — nothing in LSP can ask it to.
    lumine.config.set("ide-a.features.diagnostics", true);
    expect(messages.get(FILE).map(({ excerpt }) => excerpt)).toEqual(["broken"]);
  });

  it("ignores what arrives while it is off", () => {
    lumine.config.set("ide-a.features.diagnostics", false);
    push("broken");
    expect(messages.get(FILE)).toBeUndefined();
    lumine.config.set("ide-a.features.diagnostics", true);
    expect(messages.get(FILE).map(({ excerpt }) => excerpt)).toEqual(["broken"]);
  });

  it("refreshes pull diagnostics when their feature switch changes", () => {
    session.refreshDiagnostics = jasmine.createSpy("refreshDiagnostics");
    manager.sessions.set("ide-a:root", session);

    lumine.config.set("ide-a.features.diagnostics", false);
    lumine.config.set("ide-a.features.diagnostics", true);

    manager.sessions.clear();
    expect(session.refreshDiagnostics.calls.count()).toBe(2);
  });
});
