const C = require("./converters");
const { CompositeDisposable, Emitter } = require("lumine");

const SYMBOL_CAPABILITIES = {
  workspace: {
    symbol: {
      dynamicRegistration: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
  },
  textDocument: {
    documentSymbol: {
      dynamicRegistration: true,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
    declaration: { dynamicRegistration: true, linkSupport: true },
    definition: { dynamicRegistration: true, linkSupport: true },
    references: { dynamicRegistration: true },
  },
};

module.exports = class LspSymbolProvider {
  static capabilities = SYMBOL_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(SYMBOL_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide-client";
    this.isExclusive = true;
    this.emitter = new Emitter();
    this.pendingInvalidations = new Set();
    this.invalidationScheduled = false;
    this.destroyed = false;
    this.subscriptions = new CompositeDisposable(
      manager.onDidChangeSession(({ session, state }) => {
        if (state === "starting") return;
        this.invalidateEditors(manager.editorsForSession(session));
      }),
      manager.onDidChangeFeatures(({ adapter }) => {
        this.invalidateEditors(manager.editorsForAdapter(adapter));
      }),
      manager.onDidChangeCapabilities(({ session }) => {
        if (session.state !== "running") return;
        this.invalidateEditors(manager.editorsForSession(session));
      }),
    );
  }
  invalidateEditors(editors) {
    for (const editor of editors || []) this.pendingInvalidations.add(editor);
    if (!this.pendingInvalidations.size || this.invalidationScheduled) return;
    this.invalidationScheduled = true;
    queueMicrotask(() => {
      this.invalidationScheduled = false;
      if (this.destroyed) return;
      const pending = [...this.pendingInvalidations];
      this.pendingInvalidations.clear();
      for (const editor of pending) {
        this.emitter.emit("should-clear-cache", { editor });
      }
    });
  }
  onShouldClearCache(callback) {
    return this.emitter.on("should-clear-cache", callback);
  }
  destroy() {
    if (!this.subscriptions) return;
    this.destroyed = true;
    this.pendingInvalidations.clear();
    this.subscriptions.dispose();
    this.subscriptions = null;
    this.emitter.dispose();
  }
  async canProvideSymbols(meta) {
    return !!(await this.sessionFor(meta));
  }
  // The request a symbol query turns into, and the feature that governs it.
  // `documentSymbol` feeds every document-symbol consumer through one switch.
  requestFor(meta) {
    if (meta.type === "project") return { method: "workspace/symbol", feature: "symbols" };
    if (meta.type === "reference")
      return { method: "textDocument/references", feature: "references" };
    if (meta.type === "project-find" || meta.type === "declaration")
      return { method: "textDocument/definition", feature: "definition" };
    return { method: "textDocument/documentSymbol", feature: "symbols" };
  }
  // One symbol source per editor: merging two servers' symbol lists would show
  // every symbol twice, so the first server that can serve this particular
  // query answers. Matched against the request the query will actually make —
  // a server that only has references must not be picked to list symbols.
  async sessionFor(meta) {
    const { method, feature } = this.requestFor(meta);
    const sessions = await this.manager.activeSessionsForEditor(meta.editor);
    return sessions.find((session) => session.supports(method, meta.editor, feature)) || null;
  }
  async getSymbols(meta) {
    const session = await this.sessionFor(meta);
    if (!session) return [];
    const options = { signal: meta.signal };
    if (meta.type === "project")
      return this.convert(
        await session.request("workspace/symbol", { query: meta.query || "" }, options),
      );
    if (meta.type === "reference")
      return this.locations(
        await session.request(
          "textDocument/references",
          this.positionParams(meta, { context: { includeDeclaration: true } }),
          options,
        ),
      );
    if (meta.type === "project-find" || meta.type === "declaration")
      return this.locations(
        await session.request("textDocument/definition", this.positionParams(meta), options),
      );
    return this.convert(
      await session.request(
        "textDocument/documentSymbol",
        { textDocument: { uri: this.manager.uriForEditor(meta.editor) } },
        options,
      ),
      this.manager.uriForEditor(meta.editor),
    );
  }
  positionParams(meta, extra = {}) {
    const point = meta.range?.start || meta.editor.getLastCursor().getBufferPosition();
    return {
      textDocument: { uri: this.manager.uriForEditor(meta.editor) },
      position: C.pointToPosition(point),
      ...extra,
    };
  }
  // What a result URI names on this side of the wire. A cell resolves to its
  // notebook's path with a 1-based cell number; positions stay cell-relative,
  // which is what the notebook's own reveal takes.
  resolveResultUri(uri) {
    const resolved = this.manager.resolveUri(uri);
    if (resolved?.kind === "cell")
      return { path: resolved.notebookPath, cell: resolved.cellIndex + 1, uri };
    return { path: resolved?.kind === "file" ? resolved.path : null };
  }
  locations(items) {
    return (Array.isArray(items) ? items : items ? [items] : []).map((item) => {
      const location = item.targetUri
        ? { uri: item.targetUri, range: item.targetSelectionRange || item.targetRange }
        : item;
      const target = this.resolveResultUri(location.uri);
      return {
        name: target.path?.split(/[\\/]/).pop() || "Result",
        ...target,
        position: C.positionToPoint(location.range.start),
      };
    });
  }
  convert(items, defaultUri) {
    const output = [];
    const visit = (item, containerName) => {
      const navigationRange = item.selectionRange || item.location?.range || item.range;
      const structuralRange = item.range || item.location?.range || item.selectionRange;
      const location = item.location || { uri: defaultUri, range: navigationRange };
      const target = this.resolveResultUri(location.uri);
      output.push({
        name: item.name,
        tag: C.symbolKind(item.kind),
        ...target,
        position: C.positionToPoint(navigationRange.start),
        range: C.rangeFromLsp(structuralRange),
        context: item.containerName || containerName,
      });
      item.children?.forEach((child) => visit(child, item.name));
    };
    (items || []).forEach((item) => visit(item));
    return output;
  }
};
