const { pathToFileURL, fileURLToPath } = require("url");

exports.pathToUri = (filePath) => pathToFileURL(filePath).href;
exports.uriToPath = (uri) => (uri?.startsWith("file:") ? fileURLToPath(uri) : null);

// Notebook cells are their own text documents on the wire. The scheme is the
// one VS Code coined — servers with notebook support are battle-tested against
// it, and basedpyright resolves a cell's execution environment from the path
// component — so the path carries the notebook and the fragment names the cell.
const CELL_SCHEME = "vscode-notebook-cell";
exports.CELL_SCHEME = CELL_SCHEME;

exports.cellUri = (notebookPath, cellId) => {
  const fileUri = pathToFileURL(notebookPath).href;
  return `${CELL_SCHEME}:${fileUri.slice("file:".length)}#${encodeURIComponent(cellId)}`;
};

exports.parseCellUri = (uri) => {
  if (!uri?.startsWith(`${CELL_SCHEME}:`)) return null;
  const rest = uri.slice(CELL_SCHEME.length + 1);
  const hash = rest.indexOf("#");
  if (hash === -1) return null;
  let notebookPath;
  try {
    notebookPath = fileURLToPath(`file:${rest.slice(0, hash)}`);
  } catch {
    return null;
  }
  let cellId = rest.slice(hash + 1);
  try {
    cellId = decodeURIComponent(cellId);
  } catch {
    /* A fragment that is not percent-encoded is its own name. */
  }
  return { notebookPath, cellId };
};

// A key both sides agree on, for the maps where a URI the server sent has to
// find an entry the client made. The same file has more than one correct
// spelling — Pyright echoes `file:///c%3A/Users/ASILOI~1/…` for the
// `file:///C:/Users/ASILOI%7E1/…` it was given — and as raw strings those are
// two different keys, which silently empties every lookup between them.
//
// Decoding is most of the answer; the drive letter is the rest, since servers
// disagree on its case and Windows does not. Nothing else in the path is folded:
// only the drive letter is case-insensitive on every Windows filesystem, and a
// URI that is not a file URI is already its own canonical form.
// Total by construction: this keys the map every published diagnostic lands in,
// so a URI it cannot decode — `fileURLToPath` rejects a drive-less file URI on
// Windows — has to fall back to the raw string rather than throw and take the
// batch with it.
const foldDrive = (filePath) =>
  filePath.replace(/^(\/?)([a-zA-Z])(?=:)/, (_, slash, letter) => slash + letter.toUpperCase());

exports.uriKey = (uri) => {
  // Servers re-spell cell URIs the way they re-spell file URIs — percent
  // escapes, drive-letter case — so a cell key is rebuilt from the decoded
  // notebook path plus the fragment rather than taken as a raw string.
  const cell = exports.parseCellUri(uri);
  if (cell) return `${CELL_SCHEME}:${foldDrive(cell.notebookPath)}#${cell.cellId}`;
  let filePath = null;
  try {
    filePath = exports.uriToPath(uri);
  } catch {
    /* Not a URI this platform can resolve; its own spelling is the key. */
  }
  if (!filePath) return uri ?? "";
  // The drive letter is the one part of a Windows path that is case-insensitive,
  // and the one servers disagree about. The optional leading slash keeps the
  // answer off the platform doing the decoding: a Windows file URI becomes
  // `C:\…` on Windows and `/C:/…` everywhere else, and both have to fold the
  // same way or a server's spelling only matches on one of them.
  return foldDrive(filePath);
};
exports.pointToPosition = (point) => ({ line: point.row, character: point.column });
exports.positionToPoint = (position) => [position.line, position.character];
exports.rangeToLsp = (range) => ({
  start: exports.pointToPosition(range.start),
  end: exports.pointToPosition(range.end),
});
exports.rangeFromLsp = (range) => [
  exports.positionToPoint(range.start),
  exports.positionToPoint(range.end),
];

exports.symbolKind = (kind) =>
  ({
    1: "file",
    2: "module",
    3: "namespace",
    4: "package",
    5: "class",
    6: "method",
    7: "property",
    8: "field",
    9: "constructor",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    15: "string",
    16: "number",
    17: "boolean",
    18: "array",
    19: "object",
    20: "key",
    21: "null",
    22: "enum-member",
    23: "struct",
    24: "event",
    25: "operator",
    26: "type-parameter",
  })[kind] || "unknown";

// The full LSP 3.17 CompletionItemKind table. Every value is listed: the map
// used to skip seven kinds and was shifted by one from 20 onward, so a
// constant rendered as a struct and an enum member as a constant.
exports.completionKind = (kind) =>
  ({
    1: "text",
    2: "method",
    3: "function",
    4: "constructor",
    5: "field",
    6: "variable",
    7: "class",
    8: "interface",
    9: "module",
    10: "property",
    11: "unit",
    12: "value",
    13: "enum",
    14: "keyword",
    15: "snippet",
    16: "color",
    17: "file",
    18: "reference",
    19: "folder",
    20: "enum-member",
    21: "constant",
    22: "struct",
    23: "event",
    24: "operator",
    25: "type-parameter",
  })[kind] || "value";
