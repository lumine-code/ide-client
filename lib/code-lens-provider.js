const { Emitter, CompositeDisposable } = require("lumine");
const C = require("./converters");

const CODE_LENS_CAPABILITIES = {
  textDocument: { codeLens: { dynamicRegistration: true } },
  workspace: { codeLens: { refreshSupport: true } },
};

// Serves the code-lens.provider contract from textDocument/codeLens. The
// package that consumes it owns the rendering; this owns the protocol — which
// session answers, how a lens is resolved, and what a click executes.
module.exports = class CodeLensProvider {
  static capabilities = CODE_LENS_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(CODE_LENS_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide-client";
    this.priority = 2;
    // The LSP payload behind each lens handed out, so a resolve can send back
    // the object the server produced rather than a translation of it.
    this.sources = new WeakMap();
    // What was last served for an editor, so a request that fails transiently
    // leaves the lenses on screen instead of blanking them.
    this.lastResults = new WeakMap();
    this.emitter = new Emitter();
    const invalidate = () => this.emitter.emit("invalidate", {});
    this.subscriptions = new CompositeDisposable(
      manager.onDidRequestRefresh(({ kind }) => {
        if (kind === "codeLens") invalidate();
      }),
      manager.onDidChangeSession(({ state }) => {
        if (state !== "starting") invalidate();
      }),
      // Which server answers can change without any server changing.
      manager.onDidChangeFeatures(invalidate),
      // A capability registered after the session came up was absent when the
      // consumer last looked, so it concluded the server could not serve it.
      manager.onDidChangeCapabilities(invalidate),
    );
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  onDidInvalidate(fn) {
    return this.emitter.on("invalidate", fn);
  }
  async codeLenses(editor) {
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/codeLens");
    if (!session) {
      this.lastResults.delete(editor);
      return null;
    }
    const uri = this.manager.uriForEditor(editor);
    if (!uri) return null;
    let lenses;
    try {
      lenses = await session.request("textDocument/codeLens", { textDocument: { uri } });
    } catch {
      // A server reindexing rejects with ContentModified often enough that
      // clearing the row on every failure would read as flicker.
      return this.lastResults.get(editor) ?? null;
    }
    const canResolve = !!session.capabilityOptions("textDocument/codeLens", editor)
      ?.resolveProvider;
    const result = (lenses || [])
      .map((lens) => this.toCodeLens(lens, session, canResolve))
      .filter(Boolean);
    this.lastResults.set(editor, result);
    return result;
  }
  async resolveCodeLens(lens) {
    const source = this.sources.get(lens);
    if (!source) return null;
    const { lsp, session, canResolve } = source;
    if (!canResolve) return null;
    const resolved = await session.request("codeLens/resolve", lsp);
    if (!resolved?.command) return null;
    // A server may answer without echoing the range back; the one it was asked
    // about is still the right place for the lens.
    return this.toCodeLens(
      { ...resolved, range: resolved.range || lsp.range },
      session,
      canResolve,
    );
  }
  toCodeLens(lsp, session, canResolve = false) {
    if (!lsp?.range) return null;
    const lens = { range: C.rangeFromLsp(lsp.range) };
    const { command } = lsp;
    if (command) {
      lens.title = command.title ?? "";
      // A lens whose command names nothing is a label the server wants shown,
      // not something to run.
      if (command.command)
        lens.execute = () =>
          session.request("workspace/executeCommand", {
            command: command.command,
            arguments: command.arguments,
          });
    }
    this.sources.set(lens, { lsp, session, canResolve });
    return lens;
  }
  dispose() {
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
};
