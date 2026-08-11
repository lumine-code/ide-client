// Client capabilities advertised to language servers. The base covers only what
// the protocol core itself implements; feature modules contribute fragments for
// the requests they issue, so no capability is advertised without an
// implementation behind it. Fragments must be registered before a session
// starts — they are merged once, at initialize time.

exports.baseCapabilities = () => ({
  workspace: {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
    },
    workspaceFolders: true,
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: true },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    diagnostics: { refreshSupport: true },
    executeCommand: {},
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: true,
      didSave: true,
    },
    publishDiagnostics: {
      relatedInformation: true,
      tagSupport: { valueSet: [1, 2] },
      versionSupport: true,
      codeDescriptionSupport: true,
      dataSupport: true,
    },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
    // These generic document queries are exposed through the service's raw
    // request API even though no built-in pane consumes them. Some servers
    // inspect the corresponding client capability while answering (the YAML
    // server reads `lineFoldingOnly` unconditionally), so omitting the shape
    // makes an otherwise supported request fail inside the server.
    documentLink: { dynamicRegistration: true, tooltipSupport: true },
    colorProvider: { dynamicRegistration: true },
    foldingRange: {
      dynamicRegistration: true,
      lineFoldingOnly: false,
      rangeLimit: 5000,
    },
    selectionRange: { dynamicRegistration: true },
    linkedEditingRange: { dynamicRegistration: true },
    // Consumed by the hierarchy-view companion package through the
    // ide-client request API; external packages cannot contribute
    // fragments, so the hub advertises these on their behalf.
    callHierarchy: { dynamicRegistration: true },
    typeHierarchy: { dynamicRegistration: true },
  },
  notebookDocument: {
    synchronization: { dynamicRegistration: false, executionSummarySupport: true },
  },
  window: {
    workDoneProgress: true,
    showMessage: { messageActionItem: { additionalPropertiesSupport: true } },
    showDocument: { support: true },
  },
  general: {
    positionEncodings: ["utf-16"],
    staleRequestSupport: { cancel: true, retryOnContentModified: [] },
    markdown: { parser: "markdown-it", version: "15" },
    regularExpressions: { engine: "ECMAScript", version: "ES2024" },
  },
});

exports.mergeCapabilities = (target, ...fragments) => {
  for (const fragment of fragments) {
    for (const [key, value] of Object.entries(fragment || {})) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key]))
          target[key] = {};
        exports.mergeCapabilities(target[key], value);
      } else {
        target[key] = value;
      }
    }
  }
  return target;
};

// Maps a request method to the server-capability field that enables it, for
// session.supports() checks when no dynamic registration governs the method.
//
// Only the method a server actually registers belongs here. Both hierarchies
// are registered by their `prepare` method alone — `dynamicSupport` matches a
// registration by `item.method`, so listing `callHierarchy/incomingCalls` here
// would make supports() deny it for exactly the servers that register
// dynamically. The follow-up requests are governed by their feature instead.
exports.STATIC_CAPABILITIES = {
  "textDocument/completion": "completionProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/declaration": "declarationProvider",
  "textDocument/definition": "definitionProvider",
  "textDocument/typeDefinition": "typeDefinitionProvider",
  "textDocument/implementation": "implementationProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/documentHighlight": "documentHighlightProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
  "workspace/symbol": "workspaceSymbolProvider",
  "textDocument/codeAction": "codeActionProvider",
  "textDocument/codeLens": "codeLensProvider",
  "textDocument/diagnostic": "diagnosticProvider",
  "textDocument/formatting": "documentFormattingProvider",
  "textDocument/rangeFormatting": "documentRangeFormattingProvider",
  "textDocument/onTypeFormatting": "documentOnTypeFormattingProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/foldingRange": "foldingRangeProvider",
  "textDocument/selectionRange": "selectionRangeProvider",
  "textDocument/inlayHint": "inlayHintProvider",
  "textDocument/semanticTokens": "semanticTokensProvider",
  "textDocument/prepareCallHierarchy": "callHierarchyProvider",
  "textDocument/prepareTypeHierarchy": "typeHierarchyProvider",
  "textDocument/linkedEditingRange": "linkedEditingRangeProvider",
};
