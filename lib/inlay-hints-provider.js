const { Emitter, CompositeDisposable } = require("lumine");

const INLAY_HINT_CAPABILITIES = {
  textDocument: {
    inlayHint: {
      dynamicRegistration: true,
      resolveSupport: { properties: ["tooltip", "textEdits", "label.tooltip", "label.command"] },
    },
  },
  workspace: { inlayHint: { refreshSupport: true } },
};

// Serves the inlay-hints.provider contract from textDocument/inlayHint. The
// package that consumes it owns the rendering; this owns the protocol — which
// session answers, how a row range becomes an LSP range, and what a label is
// once its parts are joined.
module.exports = class InlayHintsProvider {
  static capabilities = INLAY_HINT_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(INLAY_HINT_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide-client";
    this.priority = 2;
    this.emitter = new Emitter();
    const invalidate = () => this.emitter.emit("invalidate", {});
    this.subscriptions = new CompositeDisposable(
      manager.onDidRequestRefresh(({ kind }) => {
        if (kind === "inlayHint") invalidate();
      }),
      manager.onDidChangeSession(({ state }) => {
        if (state === "running") invalidate();
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
  async inlayHints(editor, [startRow, endRow]) {
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/inlayHint");
    if (!session) return null;
    const uri = this.manager.uriForEditor(editor);
    if (!uri) return null;
    // Not caught: a request that fails transiently — a server reindexing —
    // rejects, and the contract reads that as "leave what is on screen alone".
    // Blanking the labels and repainting them a moment later is worse than
    // showing them a moment stale.
    const hints = await session.request("textDocument/inlayHint", {
      textDocument: { uri },
      range: { start: { line: startRow, character: 0 }, end: { line: endRow + 1, character: 0 } },
    });
    return (hints || []).map((hint) => this.toHint(hint)).filter(Boolean);
  }
  toHint(lsp) {
    const position = lsp?.position;
    if (!position) return null;
    // A label arrives either as a string or as the parts a server can attach a
    // tooltip or a command to; nothing renders those, so they are joined here
    // and the extras dropped.
    const label = Array.isArray(lsp.label)
      ? lsp.label.map((part) => part?.value || "").join("")
      : lsp.label || "";
    if (!label) return null;
    return {
      position: [position.line, position.character],
      label,
      paddingLeft: !!lsp.paddingLeft,
      paddingRight: !!lsp.paddingRight,
    };
  }
  dispose() {
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
};
