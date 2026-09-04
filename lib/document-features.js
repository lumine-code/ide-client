const { CompositeDisposable } = require("lumine");
const C = require("./converters");

const pointArray = (point) => [point.row ?? point[0], point.column ?? point[1]];
const rangeArray = (range) => [
  pointArray(range.start ?? range[0]),
  pointArray(range.end ?? range[1]),
];
const comparePoints = (left, right) => left[0] - right[0] || left[1] - right[1];
const rangesEqual = (left, right) =>
  comparePoints(left[0], right[0]) === 0 && comparePoints(left[1], right[1]) === 0;
const rangeContains = (outer, inner) =>
  comparePoints(outer[0], inner[0]) <= 0 && comparePoints(inner[1], outer[1]) <= 0;
const pointInRange = (point, range) =>
  comparePoints(range[0], point) <= 0 && comparePoints(point, range[1]) < 0;

module.exports = class DocumentFeatures {
  constructor(manager) {
    this.manager = manager;
    this.linkCaches = new WeakMap();
    this.editorSubscriptions = new Map();
    this.subscriptions = new CompositeDisposable(
      manager.onDidChangeSession(() => (this.linkCaches = new WeakMap())),
      manager.onDidChangeCapabilities(() => (this.linkCaches = new WeakMap())),
      manager.onDidChangeFeatures(() => (this.linkCaches = new WeakMap())),
    );
    this.hyperclickProvider = {
      priority: 2,
      providerName: "ide-client",
      getSuggestionForWord: (editor, _text, range) => this.documentLink(editor, range),
    };
  }

  ensureEditorSubscription(editor) {
    if (this.editorSubscriptions.has(editor)) return;
    const subscriptions = new CompositeDisposable(
      editor.getBuffer().onDidChangeText(() => this.linkCaches.delete(editor)),
      editor.onDidDestroy(() => {
        subscriptions.dispose();
        this.editorSubscriptions.delete(editor);
        this.linkCaches.delete(editor);
      }),
    );
    this.editorSubscriptions.set(editor, subscriptions);
  }

  async documentLinks(editor) {
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/documentLink");
    if (!session) return null;
    const cached = this.linkCaches.get(editor);
    if (cached?.session === session) return cached;
    const uri = this.manager.uriForEditor(editor);
    if (!uri) return null;
    let links;
    try {
      links = await session.request("textDocument/documentLink", { textDocument: { uri } });
    } catch {
      return null;
    }
    const value = {
      session,
      links: Array.isArray(links) ? links : [],
      canResolve: !!session.capabilityOptions("textDocument/documentLink", editor)?.resolveProvider,
    };
    this.ensureEditorSubscription(editor);
    this.linkCaches.set(editor, value);
    return value;
  }

  async documentLink(editor, wordRange) {
    const source = await this.documentLinks(editor);
    if (!source) return;
    const point = pointArray(wordRange.start ?? wordRange[0]);
    const link = source.links.find((candidate) =>
      candidate?.range ? pointInRange(point, C.rangeFromLsp(candidate.range)) : false,
    );
    if (!link || (!link.target && !source.canResolve)) return;
    return {
      range: C.rangeFromLsp(link.range),
      callback: () => this.followDocumentLink(source.session, link, source.canResolve),
    };
  }

  async followDocumentLink(session, original, canResolve) {
    let link = original;
    if (!link.target && canResolve)
      link = (await session.request("documentLink/resolve", link)) || link;
    if (!link.target) return false;
    if (this.manager.resolveUri(link.target))
      return (await this.manager.showDocument({ uri: link.target, takeFocus: true })).success;
    if (/^https?:/i.test(link.target)) {
      await lumine.shell.openExternal(link.target);
      return true;
    }
    lumine.notifications.addWarning("The language server returned an unsupported link target.", {
      detail: link.target,
      dismissable: true,
    });
    return false;
  }

  async sessionFor(editor, method) {
    const session = await this.manager.activeSessionForFeature(editor, method);
    if (session) return session;
    lumine.notifications.addWarning("No language server for this file supports this operation.");
    return null;
  }

  async foldRanges(editor) {
    const session = await this.sessionFor(editor, "textDocument/foldingRange");
    if (!session) return false;
    const result = await session.request("textDocument/foldingRange", {
      textDocument: { uri: this.manager.uriForEditor(editor) },
    });
    for (const range of result || []) {
      if (range?.startLine == null || range?.endLine == null) continue;
      editor.foldBufferRange([
        [range.startLine, range.startCharacter ?? Infinity],
        [range.endLine, range.endCharacter ?? Infinity],
      ]);
    }
    return true;
  }

  async expandSelectionRanges(editor) {
    const session = await this.sessionFor(editor, "textDocument/selectionRange");
    if (!session) return false;
    const selections = editor.getSelectedBufferRanges().map(rangeArray);
    const positions = editor.getCursorBufferPositions().map(C.pointToPosition);
    const result = await session.request("textDocument/selectionRange", {
      textDocument: { uri: this.manager.uriForEditor(editor) },
      positions,
    });
    const expanded = selections.map((current, index) => {
      let candidate = result?.[index];
      while (candidate) {
        const next = C.rangeFromLsp(candidate.range);
        if (rangeContains(next, current) && !rangesEqual(next, current)) return next;
        candidate = candidate.parent;
      }
      return current;
    });
    if (!expanded.some((range, index) => !rangesEqual(range, selections[index]))) return false;
    editor.setSelectedBufferRanges(expanded, { autoscroll: true });
    return true;
  }

  async selectLinkedRanges(editor) {
    const session = await this.sessionFor(editor, "textDocument/linkedEditingRange");
    if (!session) return false;
    const result = await session.request("textDocument/linkedEditingRange", {
      textDocument: { uri: this.manager.uriForEditor(editor) },
      position: C.pointToPosition(editor.getCursorBufferPosition()),
    });
    const ranges = (result?.ranges || []).map(C.rangeFromLsp);
    if (!ranges.length) return false;
    editor.setSelectedBufferRanges(ranges, { autoscroll: true });
    return true;
  }

  async colorPresentations(editor) {
    const session = await this.sessionFor(editor, "textDocument/documentColor");
    if (!session) return false;
    const uri = this.manager.uriForEditor(editor);
    const point = pointArray(editor.getCursorBufferPosition());
    const colors = await session.request("textDocument/documentColor", {
      textDocument: { uri },
    });
    const color = (colors || []).find((candidate) =>
      candidate?.range ? pointInRange(point, C.rangeFromLsp(candidate.range)) : false,
    );
    if (!color) {
      lumine.notifications.addInfo("No language-server color is under the cursor.");
      return false;
    }
    const presentations = await session.request("textDocument/colorPresentation", {
      textDocument: { uri },
      color: color.color,
      range: color.range,
    });
    if (!presentations?.length) return false;
    await this.showColorPresentations({ editor, session, uri, color, presentations });
    return true;
  }

  getColorList() {
    if (this.colorListHost) return this.colorListHost;
    this.colorListHost = lumine.workspace.addSelectList(
      {
        items: [],
        emptyMessage: "No color presentations",
        getItemId: (item) => item.id,
        search: { getFilterText: (item) => item.presentation.label },
        renderItem: (item, { highlight }) => ({ primary: highlight(item.presentation.label) }),
        commands: {
          "ide-client:apply-color-presentation": {
            description: "Apply the selected language-server color presentation.",
            didDispatch: (event) => this.applyColorPresentation(event.detail.item),
          },
        },
        actions: [
          {
            command: "ide-client:apply-color-presentation",
            context: "item",
            primary: true,
            disposition: "close",
            dispatch: "local",
          },
        ],
      },
      { className: "ide-client-color-presentations", crumb: "Color Presentations" },
    );
    this.colorList = this.colorListHost.getModel();
    return this.colorListHost;
  }

  async showColorPresentations(context) {
    const host = this.getColorList();
    await this.colorList.update({
      items: context.presentations.map((presentation, index) => ({
        id: `${index}:${presentation.label}`,
        presentation,
        context,
      })),
    });
    host.show();
  }

  applyColorPresentation(item) {
    const { context, presentation } = item;
    const primary = presentation.textEdit || {
      range: context.color.range,
      newText: presentation.label,
    };
    return this.manager.applyWorkspaceEdit(
      {
        changes: {
          [context.uri]: [primary, ...(presentation.additionalTextEdits || [])],
        },
      },
      `Apply ${presentation.label}`,
      context.session,
    );
  }

  destroy() {
    this.subscriptions.dispose();
    for (const subscription of this.editorSubscriptions.values()) subscription.dispose();
    this.editorSubscriptions.clear();
    this.colorListHost?.destroy();
    this.colorListHost = null;
    this.colorList = null;
  }
};

module.exports.rangeContains = rangeContains;
