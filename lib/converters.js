const { pathToFileURL, fileURLToPath } = require("url");

exports.pathToUri = (filePath) => pathToFileURL(filePath).href;
exports.uriToPath = (uri) => (uri?.startsWith("file:") ? fileURLToPath(uri) : null);

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
exports.uriKey = (uri) => {
  let filePath = null;
  try {
    filePath = exports.uriToPath(uri);
  } catch {
    /* Not a URI this platform can resolve; its own spelling is the key. */
  }
  if (!filePath) return uri ?? "";
  return /^[a-zA-Z]:/.test(filePath) ? filePath[0].toUpperCase() + filePath.slice(1) : filePath;
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
