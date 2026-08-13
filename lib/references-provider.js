const C = require("./converters");

const REFERENCES_CAPABILITIES = {
  textDocument: { references: { dynamicRegistration: true } },
};

module.exports = class ReferencesProvider {
  static capabilities = REFERENCES_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(REFERENCES_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide-client";
    this.abortController = null;
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  isEditorSupported(editor) {
    return !!this.manager.adapterForEditor(editor);
  }
  // Resolves to { symbolName, references: [{ path, range, name? }] }; null when
  // no session can serve references, and also when a newer request has
  // superseded this one. Genuine failures reject.
  async findReferences(editor, point) {
    const all = await this.manager.activeSessionsForEditor(editor);
    const sessions = all.filter((session) => session.supports("textDocument/references", editor));
    if (!sessions.length) return null;
    this.abortController?.abort();
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    // Servers that both index the file report overlapping locations, so the
    // merged list is deduplicated by position.
    const seen = new Set();
    const references = [];
    let responses;
    try {
      responses = await Promise.all(
        sessions.map((session) =>
          session.request(
            "textDocument/references",
            {
              textDocument: { uri: this.manager.uriForEditor(editor) },
              position: C.pointToPosition(point),
              context: { includeDeclaration: true },
            },
            { signal },
          ),
        ),
      );
    } catch (error) {
      // Cancelling our own in-flight request is not a failure: the cursor
      // moved and a newer request is already on its way. Reporting it would
      // put "the reference request failed" on screen for ordinary typing.
      if (signal.aborted) return null;
      throw error;
    }
    for (const location of responses.flat()) {
      if (!location) continue;
      const resolved = this.manager.resolveUri(location.uri);
      if (!resolved) continue;
      const range = C.rangeFromLsp(location.range);
      // A cell reference lands on its notebook, with the cell number carried
      // along; ranges stay cell-relative. Two cells share row numbers, so the
      // cell is part of the dedup key.
      const path = resolved.kind === "cell" ? resolved.notebookPath : resolved.path;
      const cell = resolved.kind === "cell" ? resolved.cellIndex + 1 : undefined;
      const key = `${path}:${cell ?? ""}:${range[0][0]}:${range[0][1]}:${range[1][0]}:${range[1][1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push(
        cell === undefined
          ? { path, range, name: null }
          : { path, cell, uri: location.uri, range, name: null },
      );
    }
    return { symbolName: this.symbolNameAt(editor, point), references };
  }
  symbolNameAt(editor, point) {
    const line = editor.getBuffer().lineForRow(point.row) || "";
    const before = /[\w$]+$/.exec(line.slice(0, point.column))?.[0] || "";
    const after = /^[\w$]+/.exec(line.slice(point.column))?.[0] || "";
    return before + after || null;
  }
};
