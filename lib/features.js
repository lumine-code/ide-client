// What an adapter can turn off for its own server.
//
// More than one server per editor is normal — a type checker beside a linter —
// and for the features that cannot merge two answers the hub has to pick one.
// Left to itself it picks whichever adapter registered first, which is package
// activation order and says nothing about which server the user wants. A
// feature switched off is how that choice is expressed: the disabled server is
// skipped, and the next one that can serve the request answers instead.
//
// Every adapter with a config namespace declares the subset its server actually
// implements under `features` in its `package.json`, so no switch is offered
// for a capability the server never had.

// The vocabulary. Names are what the user sees in the settings view, not
// protocol methods — one switch covers the three formatting requests, and
// `symbols` and `outline` split one request between two consumers.
exports.FEATURES = [
  "diagnostics",
  "autocomplete",
  "hover",
  "signature",
  "definition",
  "references",
  "symbols",
  "outline",
  "format",
  "rename",
  "codeActions",
  "inlayHints",
  "codeLens",
  "semanticTokens",
];

// Which feature governs a request. `textDocument/documentSymbol` is absent on
// purpose: it serves both the outline panel and go-to-symbol, so its two
// callers name the feature themselves rather than letting the method decide.
exports.METHOD_FEATURES = {
  "textDocument/completion": "autocomplete",
  "completionItem/resolve": "autocomplete",
  "textDocument/hover": "hover",
  "textDocument/signatureHelp": "signature",
  "textDocument/declaration": "definition",
  "textDocument/definition": "definition",
  "textDocument/typeDefinition": "definition",
  "textDocument/implementation": "definition",
  "textDocument/references": "references",
  "workspace/symbol": "symbols",
  "textDocument/formatting": "format",
  "textDocument/rangeFormatting": "format",
  "textDocument/onTypeFormatting": "format",
  "textDocument/willSaveWaitUntil": "format",
  "textDocument/rename": "rename",
  "textDocument/prepareRename": "rename",
  "textDocument/codeAction": "codeActions",
  "codeAction/resolve": "codeActions",
  "textDocument/inlayHint": "inlayHints",
  "inlayHint/resolve": "inlayHints",
  "textDocument/codeLens": "codeLens",
  "codeLens/resolve": "codeLens",
  "textDocument/semanticTokens": "semanticTokens",
  "textDocument/semanticTokens/full": "semanticTokens",
  "textDocument/semanticTokens/full/delta": "semanticTokens",
  "textDocument/semanticTokens/range": "semanticTokens",
};

// The config key an adapter's switches live under. Custom servers from
// language-servers.json have a colon in their id, which is not a key path, so
// they have no namespace and carry the object itself instead.
exports.featuresKeyPath = (adapter) =>
  adapter?.id && !adapter.id.includes(":") ? `${adapter.id}.features` : null;

// Read through the editor's scope so every switch can be overridden per
// language, the way the hub's own inlay-hint and code-lens switches are.
// Unknown to both the config and the adapter means on: an adapter that names
// no features at all keeps everything its server offers.
exports.featureEnabled = (adapter, feature, editor) => {
  if (!feature) return true;
  const keyPath = exports.featuresKeyPath(adapter);
  if (keyPath) {
    const value = atom.config.get(`${keyPath}.${feature}`, {
      scope: editor?.getRootScopeDescriptor?.(),
    });
    if (typeof value === "boolean") return value;
  }
  const declared = adapter?.features?.[feature];
  return typeof declared === "boolean" ? declared : true;
};
