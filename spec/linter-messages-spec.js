const path = require("path");
const C = require("../lib/converters");
const { toLinterMessages, toNotebookLinterMessages } = require("../lib/linter-messages");

describe("LSP diagnostics linter mapping", () => {
  it("maps diagnostics to linter.registry messages", () => {
    const filePath = path.resolve("project", "main.ts");
    const result = toLinterMessages(C.pathToUri(filePath), [
      {
        range: { start: { line: 2, character: 3 }, end: { line: 2, character: 7 } },
        severity: 1,
        message: "Unknown name",
        source: "typescript",
        code: 2304,
        codeDescription: { href: "https://example.test/2304" },
      },
    ]);
    expect(result.filePath).toBe(filePath);
    expect(result.messages[0]).toEqual(
      jasmine.objectContaining({
        severity: "error",
        excerpt: "Unknown name",
        description: "typescript: 2304",
        url: "https://example.test/2304",
        location: {
          file: filePath,
          position: [
            [2, 3],
            [2, 7],
          ],
        },
      }),
    );
  });

  describe("severity", () => {
    const mapped = (diagnostic) => {
      const filePath = path.resolve("project", "main.ts");
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      const { messages } = toLinterMessages(C.pathToUri(filePath), [
        { range, message: "m", ...diagnostic },
      ]);
      return messages[0];
    };

    it("maps every LSP severity onto its linter tier", () => {
      expect([1, 2, 3, 4].map((severity) => mapped({ severity }).severity)).toEqual([
        "error",
        "warning",
        "info",
        "hint",
      ]);
    });

    // LSP leaves an omitted severity to the client, and a server that says
    // nothing is not saying "minor".
    it("treats a diagnostic with no severity as an error", () => {
      expect(mapped({}).severity).toBe("error");
    });

    // Guards a future protocol addition from silently arriving as a hint.
    it("treats an unknown severity as an error", () => {
      expect(mapped({ severity: 5 }).severity).toBe("error");
    });
  });

  describe("tags", () => {
    const tagsOf = (tags) => {
      const filePath = path.resolve("project", "main.ts");
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      const { messages } = toLinterMessages(C.pathToUri(filePath), [
        { range, message: "m", severity: 4, tags },
      ]);
      return messages[0].tags;
    };

    it("maps LSP DiagnosticTag onto the contract names", () => {
      expect(tagsOf([1])).toEqual(["unnecessary"]);
      expect(tagsOf([2])).toEqual(["deprecated"]);
      expect(tagsOf([1, 2])).toEqual(["unnecessary", "deprecated"]);
    });

    it("omits the field when there is nothing to say", () => {
      expect(tagsOf(undefined)).toBeUndefined();
      expect(tagsOf([])).toBeUndefined();
      expect(tagsOf([99])).toBeUndefined();
    });

    it("keeps the known tags when an unknown one rides along", () => {
      expect(tagsOf([2, 99])).toEqual(["deprecated"]);
    });
  });

  it("returns an empty batch to clear stale messages", () => {
    const filePath = path.resolve("project", "main.py");
    expect(toLinterMessages(C.pathToUri(filePath), [])).toEqual({
      filePath,
      messages: [],
    });
  });

  describe("the path handed to the linter", () => {
    // Everything downstream compares it against `editor.getPath()`: the panel
    // filtering to the active file, the gutter choosing an editor. A server
    // that spells the same file differently is not a different file, but it
    // was a different string, so nothing was ever shown for it.
    it("is the editor's spelling, not the server's", () => {
      const fromServer = "file:///c%3A/Users/asiloisad/project/main.py";
      const fromEditor = "file:///C:/Users/asiloisad/project/main.py";
      expect(fromServer).not.toBe(fromEditor);
      expect(toLinterMessages(fromServer, []).filePath).toBe(
        toLinterMessages(fromEditor, []).filePath,
      );
    });

    it("drops a URI that belongs to no file rather than inventing one", () => {
      expect(toLinterMessages("untitled:Untitled-1", []).filePath).toBeNull();
      expect(toLinterMessages(undefined, []).filePath).toBeNull();
    });

    // Cell diagnostics come through their own conversion — the generic one
    // must not resolve a cell URI to a path it does not have.
    it("drops a cell URI on the generic path", () => {
      const uri = C.cellUri(path.resolve("proj", "nb.ipynb"), "c1");
      expect(toLinterMessages(uri, []).filePath).toBeNull();
    });
  });

  describe("notebook cell messages", () => {
    it("lands on the notebook with a full-list 1-based cell and cell-relative position", () => {
      const notebookPath = path.resolve("proj", "nb.ipynb");
      const { filePath, messages } = toNotebookLinterMessages({ notebookPath, cellIndex: 2 }, [
        {
          range: { start: { line: 1, character: 4 }, end: { line: 1, character: 9 } },
          severity: 2,
          message: "unused",
          source: "ruff",
          code: "F401",
        },
      ]);
      expect(filePath).toBe(notebookPath);
      expect(messages[0]).toEqual(
        jasmine.objectContaining({
          severity: "warning",
          excerpt: "unused",
          description: "ruff: F401",
          location: {
            file: notebookPath,
            cell: 3,
            position: [
              [1, 4],
              [1, 9],
            ],
          },
        }),
      );
      // Deliberately no buffer: split views give one cell different buffers.
      expect(messages[0].location.buffer).toBeUndefined();
    });
  });
});
