const C = require("./converters");

// LSP DiagnosticSeverity and DiagnosticTag. The numbering stops here: the
// linter contract takes semantic strings, the same way it takes "error" rather
// than 1.
const SEVERITIES = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

const TAGS = {
  1: "unnecessary",
  2: "deprecated",
};

// LSP leaves an omitted severity to the client. Treat it as an error: a server
// that omits the field is not saying "this is minor", and under-reporting a
// real problem is the worse failure. vscode-languageclient does the same, so
// this is what server authors test against.
const DEFAULT_SEVERITY = "error";

// The path the editor knows the file by, not the one the server spelled it
// with. Pyright and tsserver answer with a lowercase drive letter where the
// editor has an upper-case one, and every consumer compares this against
// `editor.getPath()` — the linter panel filtering to the active file, the
// gutter deciding which editor to draw in. Handing over the server's spelling
// means the diagnostics arrive, are stored, and are never shown anywhere.
const pathFor = (uri) => {
  try {
    return C.uriToPath(uri) ? C.uriKey(uri) : null;
  } catch {
    // A URI this platform cannot resolve belongs to no editor.
    return null;
  }
};

const toMessage = (diagnostic, location) => {
  const sourceAndCode = [diagnostic.source, diagnostic.code]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(": ");
  const related = (diagnostic.relatedInformation || [])
    .map((item) => `${item.location.uri}: ${item.message}`)
    .join("\n");
  // One expression covers all three edge cases: an absent list, an empty
  // one, and a tag number a future protocol version adds.
  const tags = diagnostic.tags?.map((tag) => TAGS[tag]).filter(Boolean);
  return {
    // `??`, not `||`: only an absent or unrecognized severity takes the
    // default, and it does not depend on "" or 0 never appearing.
    severity: SEVERITIES[diagnostic.severity] ?? DEFAULT_SEVERITY,
    tags: tags?.length ? tags : undefined,
    location,
    excerpt: diagnostic.message,
    description: [sourceAndCode, related].filter(Boolean).join("\n\n") || undefined,
    url: diagnostic.codeDescription?.href,
    lspDiagnostic: diagnostic,
  };
};

exports.toLinterMessages = (uri, diagnostics = []) => {
  const filePath = pathFor(uri);
  if (!filePath) return { filePath: null, messages: [] };
  return {
    filePath,
    messages: diagnostics.map((diagnostic) =>
      toMessage(diagnostic, { file: filePath, position: C.rangeFromLsp(diagnostic.range) }),
    ),
  };
};

// A cell's diagnostics land against the notebook: `file` is the .ipynb path,
// `cell` the 1-based index over the notebook's full cell list (markdown
// included), and the position stays cell-relative — the shape jupyter-view's
// linter adapter projects onto cell buffers, and the same one linter-ruff's
// CLI route emits. Deliberately no `location.buffer`: split views give the
// same cell different buffers, and naming one would tie the message to one
// view.
exports.toNotebookLinterMessages = ({ notebookPath, cellIndex }, diagnostics = []) => ({
  filePath: notebookPath,
  messages: diagnostics.map((diagnostic) =>
    toMessage(diagnostic, {
      file: notebookPath,
      cell: cellIndex + 1,
      position: C.rangeFromLsp(diagnostic.range),
    }),
  ),
});
