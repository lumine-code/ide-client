const { CompositeDisposable, Disposable } = require("lumine");

class Relay {
  constructor() {
    this.listeners = new Set();
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return new Disposable(() => this.listeners.delete(callback));
  }

  emit(value) {
    for (const callback of [...this.listeners]) callback(value);
  }

  clear() {
    this.listeners.clear();
  }
}

// Stable service objects published synchronously during package activation.
// Their shape is sufficient for consumer-side validation and registration;
// provider modules are reached only when a consumer performs real work.
module.exports = class ProviderFacades {
  constructor(main) {
    this.main = main;
    this.connections = null;
    this.relays = {
      symbols: new Relay(),
      codeLens: new Relay(),
      inlayHints: new Relay(),
      semanticTokens: new Relay(),
    };

    const provider = (name) => this.main.ensureProviders()[name];
    const grammarScopes = () => this.main.manager?.allGrammarScopes() ?? [];

    this.autocomplete = {
      scopeSelector: ".source, .text",
      inclusionPriority: 2,
      suggestionPriority: 2,
      excludeLowerPriority: false,
      filterSuggestions: true,
      get triggerCharacters() {
        return provider("completionProvider").triggerCharacters;
      },
      getSuggestions: (...args) => provider("completionProvider").getSuggestions(...args),
      getSuggestionDetailsOnSelect: (...args) =>
        provider("completionProvider").getSuggestionDetailsOnSelect(...args),
      onDidInsertSuggestion: (...args) =>
        provider("completionProvider").onDidInsertSuggestion(...args),
    };

    this.symbol = {
      name: "Language Server",
      packageName: "ide-client",
      isExclusive: true,
      onShouldClearCache: (callback) => this.relays.symbols.subscribe(callback),
      canProvideSymbols: (...args) => provider("symbolProvider").canProvideSymbols(...args),
      getSymbols: (...args) => provider("symbolProvider").getSymbols(...args),
    };

    this.hover = {
      name: "Language Server",
      packageName: "ide-client",
      priority: 2,
      get grammarScopes() {
        return grammarScopes();
      },
      hover: (...args) => provider("hoverProvider").hover(...args),
    };

    this.signature = {
      name: "Language Server",
      packageName: "ide-client",
      priority: 2,
      get grammarScopes() {
        return grammarScopes();
      },
      get triggerCharacters() {
        return provider("signatureProvider").triggerCharacters;
      },
      get retriggerCharacters() {
        return provider("signatureProvider").retriggerCharacters;
      },
      getSignature: (...args) => provider("signatureProvider").getSignature(...args),
    };

    this.codeFormatRange = this.codeFormatFacade("formatRange", "formatCode", grammarScopes);
    this.codeFormatFile = this.codeFormatFacade("formatFile", "formatEntireFile", grammarScopes);
    this.codeFormatOnType = this.codeFormatFacade(
      "formatOnType",
      "formatAtPosition",
      grammarScopes,
      { keepCursorPosition: false },
    );
    this.codeFormatOnSave = this.codeFormatFacade("formatOnSave", "formatOnSave", grammarScopes);

    this.references = {
      name: "Language Server",
      packageName: "ide-client",
      get grammarScopes() {
        return grammarScopes();
      },
      isEditorSupported: (editor) => !!this.main.manager?.adapterForEditor(editor),
      findReferences: (...args) => provider("referencesProvider").findReferences(...args),
    };

    this.refactor = {
      priority: 2,
      packageName: "ide-client",
      get grammarScopes() {
        return grammarScopes();
      },
      rename: (...args) => provider("refactorProvider").rename(...args),
      prepareRename: (...args) => provider("refactorProvider").prepareRename(...args),
    };

    this.intentions = {
      get grammarScopes() {
        return grammarScopes();
      },
      getIntentions: (...args) => provider("intentionsProvider").getIntentions(...args),
    };

    this.codeLens = this.invalidatingFacade({
      relay: this.relays.codeLens,
      providerName: "codeLensProvider",
      operation: "codeLenses",
      grammarScopes,
      extraMethods: ["resolveCodeLens"],
    });
    this.inlayHints = this.invalidatingFacade({
      relay: this.relays.inlayHints,
      providerName: "inlayHintsProvider",
      operation: "inlayHints",
      grammarScopes,
    });
    this.semanticTokens = this.invalidatingFacade({
      relay: this.relays.semanticTokens,
      providerName: "semanticTokensProvider",
      operation: "semanticTokens",
      grammarScopes,
      extraMethods: ["semanticTokensInRange"],
    });

    this.hyperclick = {
      priority: 2,
      providerName: "ide-client",
      getSuggestionForWord: (...args) =>
        provider("documentFeatures").hyperclickProvider.getSuggestionForWord(...args),
    };
  }

  codeFormatFacade(providerMethod, serviceMethod, grammarScopes, extra = {}) {
    const main = this.main;
    return {
      priority: 2,
      packageName: "ide-client",
      get grammarScopes() {
        return grammarScopes();
      },
      [serviceMethod]: (...args) =>
        main.ensureProviders().codeFormatProvider[providerMethod](...args),
      ...extra,
    };
  }

  invalidatingFacade({ relay, providerName, operation, grammarScopes, extraMethods = [] }) {
    const main = this.main;
    const facade = {
      name: "Language Server",
      packageName: "ide-client",
      priority: 2,
      get grammarScopes() {
        return grammarScopes();
      },
      onDidInvalidate: (callback) => relay.subscribe(callback),
      [operation]: (...args) => main.ensureProviders()[providerName][operation](...args),
    };
    for (const method of extraMethods) {
      facade[method] = (...args) => main.ensureProviders()[providerName][method](...args);
    }
    return facade;
  }

  connect(main = this.main) {
    this.disconnect();
    this.connections = new CompositeDisposable(
      main.symbolProvider.onShouldClearCache((event) => this.relays.symbols.emit(event)),
      main.codeLensProvider.onDidInvalidate((event) => this.relays.codeLens.emit(event)),
      main.inlayHintsProvider.onDidInvalidate((event) => this.relays.inlayHints.emit(event)),
      main.semanticTokensProvider.onDidInvalidate((event) =>
        this.relays.semanticTokens.emit(event),
      ),
    );
  }

  disconnect() {
    this.connections?.dispose();
    this.connections = null;
  }

  dispose() {
    this.disconnect();
    for (const relay of Object.values(this.relays)) relay.clear();
    this.main = null;
  }
};
