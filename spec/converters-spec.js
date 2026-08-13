const path = require("path");
const C = require("../lib/converters");

describe("ide-client converters", () => {
  it("round trips file paths through encoded file URIs", () => {
    const filePath = path.resolve("a folder", "file #1.ts");
    expect(C.uriToPath(C.pathToUri(filePath))).toBe(filePath);
  });
  it("converts editor and protocol ranges", () => {
    const range = { start: { row: 1, column: 2 }, end: { row: 3, column: 4 } };
    expect(C.rangeFromLsp(C.rangeToLsp(range))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
  describe("uriKey", () => {
    // The same file has more than one correct URI. Pyright echoes back
    // `file:///c%3A/…ASILOI~1/…` for the `file:///C:/…ASILOI%7E1/…` it was
    // given, and as raw strings those are two different map keys.
    it("agrees across the spellings a server may choose", () => {
      const client = "file:///C:/Users/ASILOI%7E1/AppData/Local/project/greeter.py";
      const server = "file:///c%3A/Users/ASILOI~1/AppData/Local/project/greeter.py";
      expect(client).not.toBe(server);
      expect(C.uriKey(client)).toBe(C.uriKey(server));
    });
    it("folds only the drive letter", () => {
      // Everything after it is a path the filesystem may well distinguish.
      expect(C.uriKey("file:///c:/Project/File.py")).toBe(C.uriKey("file:///C:/Project/File.py"));
      expect(C.uriKey("file:///C:/Project/File.py")).not.toBe(
        C.uriKey("file:///C:/project/file.py"),
      );
    });
    it("agrees whichever platform decoded the URI", () => {
      // A Windows file URI decodes to `C:\…` on Windows and to `/C:/…`
      // everywhere else. Both shapes have to fold the same way, or the key
      // matches a server's spelling on one platform and not the other — which
      // is exactly what the first version of this did.
      expect(C.uriKey("file:///c:/x.py")).toBe(C.uriKey("file:///C:/x.py"));
      // A path that merely starts with a letter is not a drive.
      expect(C.uriKey("file:///home/user/x.py")).toBe(C.uriKey("file:///home/user/x.py"));
      expect(C.uriKey("file:///c/data/x.py")).not.toBe(C.uriKey("file:///C/data/x.py"));
    });
    it("keeps a non-file URI as it is, and never returns undefined", () => {
      expect(C.uriKey("untitled:Untitled-1")).toBe("untitled:Untitled-1");
      expect(C.uriKey(undefined)).toBe("");
    });
    it("is idempotent, so a key can be re-keyed harmlessly", () => {
      const key = C.uriKey("file:///C:/Project/File.py");
      expect(C.uriKey(key)).toBe(key);
    });
    it("agrees across the spellings a server may choose for a cell URI", () => {
      // Cell URIs are re-spelled the same way file URIs are: the key is
      // rebuilt from the decoded notebook path plus the fragment.
      const client = "vscode-notebook-cell:///C:/Users/ASILOI%7E1/project/nb.ipynb#cell-1";
      const server = "vscode-notebook-cell:///c%3A/Users/ASILOI~1/project/nb.ipynb#cell-1";
      expect(client).not.toBe(server);
      expect(C.uriKey(client)).toBe(C.uriKey(server));
      // Different cells of one notebook stay different keys.
      expect(C.uriKey(`${client.slice(0, -1)}2`)).not.toBe(C.uriKey(client));
    });
  });

  describe("cell URIs", () => {
    it("round trips a notebook path and cell id", () => {
      const notebookPath = path.resolve("a folder", "note book #1.ipynb");
      const uri = C.cellUri(notebookPath, "1f3a-b2");
      expect(uri.startsWith("vscode-notebook-cell:")).toBe(true);
      expect(C.parseCellUri(uri)).toEqual({ notebookPath, cellId: "1f3a-b2" });
    });
    it("declines anything that is not a cell URI", () => {
      expect(C.parseCellUri("file:///C:/x.ipynb")).toBeNull();
      expect(C.parseCellUri("vscode-notebook-cell:///C:/x.ipynb")).toBeNull();
      expect(C.parseCellUri(undefined)).toBeNull();
    });
    it("keeps the notebook's own path component so servers can resolve it", () => {
      const notebookPath = path.resolve("proj", "nb.ipynb");
      const fileHalf = C.pathToUri(notebookPath).slice("file:".length);
      expect(C.cellUri(notebookPath, "c1")).toBe(`vscode-notebook-cell:${fileHalf}#c1`);
    });
  });

  it("maps every LSP completion kind, unshifted", () => {
    // The kinds that used to be shifted by one: 20 read as "constant",
    // 21 as "struct", 22 as "event".
    expect(C.completionKind(20)).toBe("enum-member");
    expect(C.completionKind(21)).toBe("constant");
    expect(C.completionKind(22)).toBe("struct");
    expect(C.completionKind(23)).toBe("event");
    expect(C.completionKind(25)).toBe("type-parameter");
    // And the seven that were missing entirely.
    for (const kind of [1, 11, 16, 18, 19, 24]) {
      expect(C.completionKind(kind)).not.toBe("value");
    }
    // Every kind in the 3.17 table resolves to a distinct name.
    const names = [];
    for (let kind = 1; kind <= 25; kind++) names.push(C.completionKind(kind));
    expect(new Set(names).size).toBe(25);
  });
});
