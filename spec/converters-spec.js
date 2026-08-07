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
