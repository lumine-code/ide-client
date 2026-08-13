const { CompositeDisposable } = require("lumine");
const C = require("./converters");
const { languageIdForEditor } = require("./language-ids");

// LSP 3.17 notebook document sync. A notebook opens once per capable session:
// the notebook document plus one text document per synced cell, each under a
// `vscode-notebook-cell:` URI. Cells are their own documents, so positions on
// both sides of the wire are cell-relative — identity, no mapping layer.
//
// Only code cells whose language matches the server's `notebookSelector` are
// synced (mirroring vscode-languageclient); markup cells stay in the bridge
// descriptor because the 1-based cell numbers diagnostics carry count the
// notebook's full cell list, but they never reach a server. A session whose
// server advertises no `notebookDocumentSync` never sees the notebook at all —
// and `sessionsForEditor` only answers with sessions holding the cell
// document, which is what keeps such servers from ever being asked about one.

const NOTEBOOK_CELL_KIND = { markup: 1, code: 2 };

// Whether these sync options cover a notebook of this type with any of these
// cell languages. Handles both published shapes: ruff's cells-only selector
// and basedpyright's notebook-plus-cells selector.
function notebookSyncMatches(syncOptions, { notebookType, cellLanguageIds }) {
  const selectors = syncOptions?.notebookSelector;
  if (!Array.isArray(selectors) || !selectors.length) return false;
  return selectors.some((entry) => {
    if (entry.notebook !== undefined) {
      const filter = entry.notebook;
      if (typeof filter === "string") {
        if (filter !== "*" && filter !== notebookType) return false;
      } else {
        if (filter.notebookType && filter.notebookType !== notebookType) return false;
        // The notebook document itself is a file: URI.
        if (filter.scheme && filter.scheme !== "file" && filter.scheme !== "*") return false;
      }
    }
    const cells = entry.cells;
    if (!cells?.length) return entry.notebook !== undefined;
    return cells.some((cell) => !cell.language || cellLanguageIds.includes(cell.language));
  });
}

// The languages a selector accepts, or null for "every cell of the notebook".
function selectorLanguages(syncOptions) {
  const languages = new Set();
  for (const entry of syncOptions?.notebookSelector || []) {
    if (!entry.cells?.length) return null;
    for (const cell of entry.cells) {
      if (!cell.language) return null;
      languages.add(cell.language);
    }
  }
  return languages;
}

// One contiguous splice covering the difference between two id orders, plus
// which ids entered and left. A type flip falls out naturally: the id leaves
// one projection and enters the other.
function diffCellOrder(previousIds, nextIds) {
  const previousSet = new Set(previousIds);
  const nextSet = new Set(nextIds);
  const added = nextIds.filter((id) => !previousSet.has(id));
  const removed = previousIds.filter((id) => !nextSet.has(id));
  let start = 0;
  const shortest = Math.min(previousIds.length, nextIds.length);
  while (start < shortest && previousIds[start] === nextIds[start]) start++;
  let previousEnd = previousIds.length;
  let nextEnd = nextIds.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousIds[previousEnd - 1] === nextIds[nextEnd - 1]
  ) {
    previousEnd--;
    nextEnd--;
  }
  const changed = previousEnd > start || nextEnd > start;
  return {
    changed,
    splice: { start, deleteCount: previousEnd - start, ids: nextIds.slice(start, nextEnd) },
    added,
    removed,
  };
}

class NotebookRecord {
  constructor(manager, { filePath, notebookType, metadata, show }) {
    this.manager = manager;
    this.filePath = filePath;
    this.notebookType = notebookType;
    this.metadata = metadata;
    this.show = show;
    this.uri = C.pathToUri(filePath);
    this.version = 1;
    this.cells = [];
    this.cellVersions = new Map();
    this.cellUris = new Map();
    // cellId -> { editor, subscription } for the buffer driving content sync.
    this.contentSync = new Map();
    // cellId -> the editors registered for routing.
    this.routedEditors = new Map();
    // session -> { ids: Set<cellId>, save: boolean }
    this.sessionState = new Map();
    this.disposed = false;
  }

  cellVersion(cellId) {
    return this.cellVersions.get(cellId) ?? 1;
  }

  cellIndexOf(cellId) {
    return this.cells.findIndex((cell) => cell.id === cellId);
  }

  uriForCell(cellId) {
    let uri = this.cellUris.get(cellId);
    if (!uri) {
      uri = C.cellUri(this.filePath, cellId);
      this.cellUris.set(cellId, uri);
    }
    return uri;
  }

  primaryEditor(cell) {
    return cell.editors?.[0] ?? cell.editor ?? null;
  }

  cellText(cell) {
    return this.primaryEditor(cell)?.getText() ?? cell.text ?? "";
  }

  languageIdOf(cell, adapter) {
    const shim = this.primaryEditor(cell) ?? {
      getGrammar: () => ({ scopeName: cell.scopeName }),
    };
    return languageIdForEditor(adapter, shim);
  }

  // The cells a session syncs: code cells whose language its selector takes.
  syncedCells(session) {
    const languages = selectorLanguages(session.capabilities.notebookDocumentSync);
    return this.cells.filter((cell) => {
      if (cell.kind !== "code") return false;
      if (!languages) return true;
      return languages.has(this.languageIdOf(cell, session.adapter));
    });
  }

  toTextDocumentItem(cell, session) {
    return {
      uri: this.uriForCell(cell.id),
      languageId: this.languageIdOf(cell, session.adapter),
      version: this.cellVersion(cell.id),
      text: this.cellText(cell),
    };
  }

  toNotebookCell(cell) {
    return { kind: NOTEBOOK_CELL_KIND[cell.kind] ?? 2, document: this.uriForCell(cell.id) };
  }
}

module.exports = class NotebookDocuments {
  constructor(manager) {
    this.manager = manager;
    this.records = new Set();
    this.subscriptions = new CompositeDisposable(
      manager.onDidChangeSession(({ session, state }) => {
        if (state !== "stopped" && state !== "failed") return;
        for (const record of this.records) record.sessionState.delete(session);
      }),
    );
  }

  // Opens a notebook for language servers. Returns a bridge, or null for a
  // notebook that has no path yet — an untitled notebook attaches on first
  // save, by being opened again. The bridge is path-immutable: a save-as is a
  // dispose and a fresh open, matching how servers treat a renamed notebook.
  open({ filePath, notebookType = "jupyter-notebook", cells = [], metadata, show }) {
    if (!filePath) return null;
    const record = new NotebookRecord(this.manager, { filePath, notebookType, metadata, show });
    this.records.add(record);
    this.applyCells(record, cells);
    const attach = this.ensureAttached(record);
    attach.catch(() => {});
    return {
      notebookUri: record.uri,
      uriForCell: (cellId) => record.uriForCell(cellId),
      attached: attach,
      updateCells: (nextCells) => this.updateCells(record, nextCells),
      didSave: () => this.didSave(record),
      dispose: () => this.disposeRecord(record),
    };
  }

  async reattachAll() {
    for (const record of [...this.records]) {
      await this.ensureAttached(record).catch(() => {});
    }
  }

  dispose() {
    for (const record of [...this.records]) this.disposeRecord(record);
    this.subscriptions.dispose();
  }

  // Reconciles the record to a new ordered cell list: routing registrations,
  // content-sync subscriptions, and the per-session structure deltas.
  applyCells(record, nextCells) {
    const previous = record.cells;
    const previousById = new Map(previous.map((cell) => [cell.id, cell]));
    record.cells = nextCells.map((cell) => ({ ...cell }));
    const nextById = new Map(record.cells.map((cell) => [cell.id, cell]));

    // Routing: every live editor of a code cell answers to the cell URI. The
    // first editor is the binding's face — the buffer edits apply to.
    for (const [cellId, editors] of [...record.routedEditors]) {
      const cell = nextById.get(cellId);
      const keep = cell?.kind === "code" ? new Set(this.editorsOf(cell)) : new Set();
      for (const editor of editors) {
        if (!keep.has(editor)) this.manager.unregisterExternalDocument(editor);
      }
      if (!keep.size) record.routedEditors.delete(cellId);
    }
    for (const cell of record.cells) {
      if (cell.kind !== "code") continue;
      const editors = this.editorsOf(cell);
      const binding = {
        editor: editors[0] ?? null,
        uri: record.uriForCell(cell.id),
        cellId: cell.id,
        record,
      };
      for (const editor of editors) this.manager.registerExternalDocument(editor, binding);
      if (!editors.length) this.manager.externalUris.set(C.uriKey(binding.uri), binding);
      record.routedEditors.set(cell.id, editors);
      if (!record.cellVersions.has(cell.id)) record.cellVersions.set(cell.id, 1);
    }

    // Content sync follows the primary editor's buffer. A cell whose editor
    // just appeared (or changed identity) gets one full-text change so the
    // server's copy is grounded in the buffer before increments resume.
    for (const [cellId, entry] of [...record.contentSync]) {
      const cell = nextById.get(cellId);
      const editor = cell?.kind === "code" ? record.primaryEditor(cell) : null;
      if (entry.editor !== editor) {
        entry.subscription.dispose();
        record.contentSync.delete(cellId);
      }
    }
    for (const cell of record.cells) {
      if (cell.kind !== "code") continue;
      const editor = record.primaryEditor(cell);
      if (!editor || record.contentSync.has(cell.id)) continue;
      const subscription = editor.getBuffer().onDidChangeText((event) => {
        this.cellContentDidChange(record, cell.id, event);
      });
      record.contentSync.set(cell.id, { editor, subscription });
      // Ground the server's copy, unless the cell is brand new — its didOpen
      // below carries this very text.
      if (previousById.has(cell.id)) this.sendFullCellText(record, cell.id, editor);
    }

    // Structure deltas, per session over its own projection.
    for (const [session, state] of record.sessionState) {
      const synced = record.syncedCells(session);
      const nextIds = synced.map((cell) => cell.id);
      const diff = diffCellOrder([...state.ids], nextIds);
      if (!diff.changed && !diff.added.length && !diff.removed.length) continue;
      record.version++;
      const syncedById = new Map(synced.map((cell) => [cell.id, cell]));
      session.changeNotebook(
        { uri: record.uri, version: record.version },
        {
          cells: {
            structure: {
              array: {
                start: diff.splice.start,
                deleteCount: diff.splice.deleteCount,
                cells: diff.splice.ids.map((id) => record.toNotebookCell(syncedById.get(id))),
              },
              didOpen: diff.added.map((id) =>
                record.toTextDocumentItem(syncedById.get(id), session),
              ),
              didClose: diff.removed.map((id) => ({ uri: record.uriForCell(id) })),
            },
          },
        },
      );
      for (const id of diff.added) {
        const cell = syncedById.get(id);
        session.adoptNotebookCell({
          record,
          cellId: id,
          editor: record.primaryEditor(cell),
          uri: record.uriForCell(id),
        });
      }
      for (const id of diff.removed) session.releaseNotebookCell(record.uriForCell(id));
      state.ids = new Set(nextIds);
      // The same stored diagnostics name different cells now; re-project them.
      this.manager.republishStoredDiagnostics(
        session,
        nextIds.map((id) => C.uriKey(record.uriForCell(id))),
      );
    }
  }

  editorsOf(cell) {
    if (Array.isArray(cell.editors)) return cell.editors.filter(Boolean);
    return cell.editor ? [cell.editor] : [];
  }

  updateCells(record, nextCells) {
    if (record.disposed) return;
    this.applyCells(record, nextCells);
    const attach = this.ensureAttached(record);
    attach.catch(() => {});
    return attach;
  }

  cellContentDidChange(record, cellId, event) {
    if (record.disposed) return;
    record.cellVersions.set(cellId, record.cellVersion(cellId) + 1);
    record.version++;
    const uri = record.uriForCell(cellId);
    const contentChanges = event.changes.toReversed().map((change) => ({
      range: C.rangeToLsp(change.oldRange),
      rangeLength: change.oldText?.length,
      text: change.newText,
    }));
    this.sendCellChange(record, cellId, uri, contentChanges);
  }

  sendFullCellText(record, cellId, editor) {
    record.cellVersions.set(cellId, record.cellVersion(cellId) + 1);
    record.version++;
    this.sendCellChange(record, cellId, record.uriForCell(cellId), [{ text: editor.getText() }]);
  }

  sendCellChange(record, cellId, uri, contentChanges) {
    for (const [session, state] of record.sessionState) {
      if (!state.ids.has(cellId)) continue;
      session.changeNotebook(
        { uri: record.uri, version: record.version },
        {
          cells: {
            textContent: [
              {
                document: { uri, version: record.cellVersion(cellId) },
                changes: contentChanges,
              },
            ],
          },
        },
      );
      const document = session.documents.get(C.uriKey(uri));
      if (document) session.scheduleDiagnostics(document);
    }
  }

  // Finds or starts a capable session per adapter covering the notebook's
  // cells, and opens the notebook on each one that has not seen it yet.
  async ensureAttached(record) {
    if (record.disposed) return;
    const adapters = new Map();
    for (const cell of record.cells) {
      if (cell.kind !== "code") continue;
      const editor = record.primaryEditor(cell);
      if (!editor) continue;
      for (const adapter of this.manager.adaptersForEditor(editor))
        adapters.set(adapter.id, adapter);
    }
    for (const adapter of adapters.values()) {
      const rootPath = this.manager.rootForPath(record.filePath, adapter);
      let session;
      try {
        session = await this.manager.ensureSession(adapter, rootPath);
      } catch (error) {
        this.manager.reportStartFailure(adapter, rootPath, error);
        continue;
      }
      if (!session) continue;
      try {
        await session.ready;
      } catch {
        continue;
      }
      if (record.disposed) return;
      if (this.manager.sessions.get(this.manager.keyFor(adapter, rootPath)) !== session) continue;
      if (record.sessionState.has(session)) continue;
      const syncOptions = session.capabilities.notebookDocumentSync;
      const cellLanguageIds = record.cells
        .filter((cell) => cell.kind === "code")
        .map((cell) => record.languageIdOf(cell, adapter));
      if (!notebookSyncMatches(syncOptions, { notebookType: record.notebookType, cellLanguageIds }))
        continue;
      this.openNotebookOn(record, session, syncOptions);
    }
  }

  openNotebookOn(record, session, syncOptions) {
    const synced = record.syncedCells(session);
    record.sessionState.set(session, {
      ids: new Set(synced.map((cell) => cell.id)),
      save: !!syncOptions.save,
    });
    session.openNotebook(
      {
        uri: record.uri,
        notebookType: record.notebookType,
        version: record.version,
        ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
        cells: synced.map((cell) => record.toNotebookCell(cell)),
      },
      synced.map((cell) => record.toTextDocumentItem(cell, session)),
    );
    for (const cell of synced) {
      session.adoptNotebookCell({
        record,
        cellId: cell.id,
        editor: record.primaryEditor(cell),
        uri: record.uriForCell(cell.id),
      });
    }
  }

  didSave(record) {
    if (record.disposed) return;
    for (const [session, state] of record.sessionState) {
      if (state.save) session.saveNotebook({ uri: record.uri });
    }
  }

  disposeRecord(record) {
    if (record.disposed) return;
    record.disposed = true;
    for (const [session, state] of record.sessionState) {
      session.closeNotebook(
        { uri: record.uri },
        [...state.ids].map((id) => ({ uri: record.uriForCell(id) })),
      );
      // Releasing publishes empty diagnostics per cell, which is what evicts
      // the notebook's messages from the linter.
      for (const id of state.ids) session.releaseNotebookCell(record.uriForCell(id));
    }
    record.sessionState.clear();
    for (const entry of record.contentSync.values()) entry.subscription.dispose();
    record.contentSync.clear();
    for (const editors of record.routedEditors.values()) {
      for (const editor of editors) this.manager.unregisterExternalDocument(editor);
    }
    for (const uri of record.cellUris.values()) {
      const binding = this.manager.externalUris.get(C.uriKey(uri));
      if (binding?.record === record) this.manager.externalUris.delete(C.uriKey(uri));
    }
    record.routedEditors.clear();
    this.records.delete(record);
  }
};

module.exports.notebookSyncMatches = notebookSyncMatches;
module.exports.selectorLanguages = selectorLanguages;
module.exports.diffCellOrder = diffCellOrder;
