const path = require("path");
const os = require("os");
const { Emitter } = require("lumine");
const InlayHints = require("../lib/inlay-hints");
const ViewportTracker = require("../lib/viewport-tracker");

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const makeTracker = () => {
  const emitter = new Emitter();
  return {
    onDidBecomeStale: (fn) => emitter.on("stale", fn),
    rangeForEditor: (editor) => [0, editor.getBuffer().getLastRow()],
    emitStale: (editor, range) => emitter.emit("stale", { editor, range }),
  };
};

const makeManager = (session) => {
  const emitter = new Emitter();
  return {
    addCapabilityFragment() {},
    activeSessionForEditor: async () => session,
    activeSessionsForEditor: async () => (session ? [session] : []),
    activeSessionForFeature: async () => session,
    onDidRequestRefresh: (fn) => emitter.on("refresh", fn),
    onDidChangeSession: (fn) => emitter.on("session", fn),
    onDidChangeFeatures: (fn) => emitter.on("features", fn),
    onDidChangeCapabilities: (fn) => emitter.on("capabilities", fn),
    registerCapabilities: (target, registrations) => {
      emitter.emit("capabilities", { session: target, registrations });
    },
    requestRefresh: (refreshSession, kind) =>
      emitter.emit("refresh", { session: refreshSession, kind }),
  };
};

const makeSession = (respond, capabilities = {}) => ({
  state: "running",
  capabilities,
  supports: () => true,
  capabilityOptions: (method) =>
    ({
      "textDocument/completion": capabilities.completionProvider,
      "textDocument/signatureHelp": capabilities.signatureHelpProvider,
      "textDocument/semanticTokens": capabilities.semanticTokensProvider,
      "textDocument/onTypeFormatting": capabilities.documentOnTypeFormattingProvider,
      "textDocument/codeAction": capabilities.codeActionProvider,
      "textDocument/rename": capabilities.renameProvider,
    })[method],
  requests: [],
  request(method, params) {
    this.requests.push({ method, params });
    return Promise.resolve(respond(method, params));
  },
});

describe("InlayHints", () => {
  let editor, inlayHints, tracker;

  // The spec harness renders editors synchronously, so decorations are in the
  // DOM as soon as the fetch chain settles — no update promise to await.
  const attach = async (hints) => {
    const session = makeSession((method) => (method === "textDocument/inlayHint" ? hints() : null));
    inlayHints = new InlayHints(makeManager(session), tracker);
    await flush();
    return session;
  };

  beforeEach(async () => {
    lumine.config.set("ide-client.inlayHints.enabled", true);
    lumine.config.set("ide-client.inlayHints.maxLabelLength", 48);
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "inlay-hints-example.js"));
    editor.setText("const sum = add(first, second);\n\nlet x = 5;\n");
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    tracker = makeTracker();
  });

  afterEach(() => inlayHints?.dispose());

  it("renders labels through the CSS custom property, skipping empty lines", async () => {
    await attach(() => [
      { position: { line: 0, character: 11 }, label: ": number", paddingLeft: true },
      { position: { line: 1, character: 0 }, label: "skipped" },
    ]);
    const span = editor.getElement().querySelector(".line .ide-client-inlay-hint");
    expect(span).not.toBeNull();
    expect(span.style.getPropertyValue("--ide-inlay-text")).toBe('": number"');
    expect(span.classList.contains("ide-client-inlay-hint-pad-left")).toBe(true);
    expect(span.classList.contains("ide-client-inlay-hint-pad-right")).toBe(false);
    // The hint on the empty line cannot span a character and is dropped.
    expect(inlayHints.states.get(editor).hints.size).toBe(1);
  });

  it("uses the ::after variant for hints at the end of a line", async () => {
    await attach(() => [{ position: { line: 2, character: 10 }, label: " -> int" }]);
    const span = editor.getElement().querySelector(".line .ide-client-inlay-hint-after");
    expect(span).not.toBeNull();
    expect(span.style.getPropertyValue("--ide-inlay-text")).toBe('" -> int"');
    const [entry] = [...inlayHints.states.get(editor).hints.values()];
    expect(entry.marker.getBufferRange().toString()).toBe("[(2, 9) - (2, 10)]");
  });

  it("truncates labels beyond maxLabelLength and joins label parts", async () => {
    lumine.config.set("ide-client.inlayHints.maxLabelLength", 5);
    await attach(() => [
      { position: { line: 0, character: 6 }, label: [{ value: "abc" }, { value: "defgh" }] },
    ]);
    const [entry] = [...inlayHints.states.get(editor).hints.values()];
    expect(entry.properties.style["--ide-inlay-text"]).toBe(JSON.stringify("abcde…"));
  });

  it("reuses markers and decoration properties across identical refetches", async () => {
    const session = await attach(() => [
      { position: { line: 0, character: 11 }, label: ": number" },
      { position: { line: 2, character: 4 }, label: "x:" },
    ]);
    const state = inlayHints.states.get(editor);
    const before = new Map([...state.hints].map(([key, entry]) => [key, entry]));
    expect(before.size).toBe(2);
    tracker.emitStale(editor, [0, editor.getBuffer().getLastRow()]);
    await flush();
    expect(
      session.requests.filter(({ method }) => method === "textDocument/inlayHint").length,
    ).toBe(2);
    expect(state.hints.size).toBe(2);
    for (const [key, entry] of state.hints) {
      expect(entry).toBe(before.get(key));
      expect(entry.marker.isDestroyed()).toBe(false);
    }
  });

  it("destroys stale hints inside the fetched range only", async () => {
    let hints = [
      { position: { line: 0, character: 11 }, label: ": number" },
      { position: { line: 2, character: 4 }, label: "x:" },
    ];
    await attach(() => hints);
    const state = inlayHints.states.get(editor);
    const keep = [...state.hints.values()].find(
      (entry) => entry.marker.getStartBufferPosition().row === 2,
    );
    hints = [];
    tracker.emitStale(editor, [0, 1]);
    await flush();
    expect(state.hints.size).toBe(1);
    expect([...state.hints.values()][0]).toBe(keep);
  });

  // The renderer resolves a point on a label to the column the label decorates
  // all by itself: `screenPositionForPixelPosition` asks `caretRangeFromPoint`,
  // which lands in a real text node on the line. So this package installs no
  // mousedown handling of its own, and pressing on a label starts an ordinary
  // drag-selection like pressing anywhere else does.
  it("leaves a press on a hint label to the renderer, which resolves it to the anchor", async () => {
    // The labels are pseudo-element content and occupy no space until this
    // package's own stylesheet is loaded.
    const styles = lumine.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "ide-client.css"),
    );
    try {
      await attach(() => [
        { position: { line: 0, character: 11 }, label: ": number" },
        { position: { line: 2, character: 10 }, label: " -> int" },
      ]);
      const element = editor.getElement();
      const { component } = element;
      const linesRect = component.refs.lineTiles.getBoundingClientRect();
      const cases = [
        { selector: ".ide-client-inlay-hint", row: 0, column: 11, atEnd: false },
        { selector: ".ide-client-inlay-hint-after", row: 2, column: 10, atEnd: true },
      ];
      for (const { selector, row, column, atEnd } of cases) {
        const span = element.querySelector(`.line ${selector}`);
        expect(span).not.toBeNull();
        // The label occupies the side of the decorated span the character does
        // not: ::before runs from the span's left edge up to the character,
        // ::after from the character's right edge to the span's.
        const spanRect = span.getBoundingClientRect();
        const anchor = component.pixelPositionForScreenPosition({ row, column });
        const charEdge = linesRect.left + anchor.left;
        const from = atEnd ? charEdge : spanRect.left;
        const to = atEnd ? spanRect.right : charEdge;
        const clientY = linesRect.top + anchor.top + component.getLineHeight() / 2;
        // Pixels the label draws that no character occupies...
        expect(to - from).toBeGreaterThan(component.getBaseCharacterWidth());
        // ...every one of which names the column the hint is anchored to.
        for (const clientX of [from + 1, (from + to) / 2, to - 1]) {
          const pixelPosition = component.pixelPositionForMouseEvent({ clientX, clientY });
          expect(component.screenPositionForPixelPosition(pixelPosition).toArray()).toEqual([
            row,
            column,
          ]);
        }

        editor.setCursorBufferPosition([1, 0]);
        const event = new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 1,
          clientX: (from + to) / 2,
          clientY,
        });
        span.dispatchEvent(event);
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        expect(editor.getCursorBufferPosition().toArray()).toEqual([row, column]);
        // Nothing swallows the press, so it still begins a drag-selection.
        expect(event.defaultPrevented).toBe(false);
      }
    } finally {
      styles.dispose();
    }
  });

  it("honors a per-language scoped disable", async () => {
    const rootScope = editor.getRootScopeDescriptor().getScopesArray()[0];
    lumine.config.set("ide-client.inlayHints.enabled", false, { scopeSelector: `.${rootScope}` });
    const session = await attach(() => [{ position: { line: 0, character: 11 }, label: ": n" }]);
    expect(session.requests.length).toBe(0);
    expect(inlayHints.states.get(editor).hints.size).toBe(0);
  });
});

describe("ViewportTracker", () => {
  let editor, viewportTracker;

  beforeEach(async () => {
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "viewport-tracker-example.js"));
    editor.setText("x\n".repeat(300));
  });

  afterEach(() => viewportTracker?.dispose());

  it("emits a clamped buffer-row range once scrolling settles", async () => {
    viewportTracker = new ViewportTracker();
    const events = [];
    viewportTracker.onDidBecomeStale((event) => events.push(event));
    const element = editor.getElement();
    element.setScrollTop(100 * element.component.getLineHeight());
    expect(events.length).toBe(0);
    advanceClock(150);
    expect(events.length).toBe(1);
    expect(events[0].editor).toBe(editor);
    const [start, end] = events[0].range;
    expect(start).toBe(Math.max(0, editor.getFirstVisibleScreenRow() - 50));
    expect(end).toBe(Math.min(300, editor.getLastVisibleScreenRow() + 50));
    expect(start).toBeGreaterThan(0);
  });

  it("reports the top of the buffer for an editor that has never been rendered", async () => {
    viewportTracker = new ViewportTracker();
    // An editor opened in a background tab reports no visible rows, and
    // converting that to a screen position throws on an invalid Point.
    const hidden = await lumine.workspace.buildTextEditor();
    hidden.setText("x\n".repeat(300));
    expect(hidden.getFirstVisibleScreenRow()).not.toBeGreaterThan(0);
    const [start, end] = viewportTracker.rangeForEditor(hidden);
    expect(start).toBe(0);
    expect(Number.isFinite(end)).toBe(true);
    expect(end).toBeGreaterThan(0);
    hidden.destroy();
  });

  it("emits when the buffer stops changing", async () => {
    viewportTracker = new ViewportTracker();
    const events = [];
    viewportTracker.onDidBecomeStale((event) => events.push(event));
    editor.setTextInBufferRange(
      [
        [0, 0],
        [0, 0],
      ],
      "y",
    );
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    expect(events.length).toBe(1);
    expect(events[0].range[0]).toBe(0);
  });
});
