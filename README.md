# ide-client

Language Server Protocol client infrastructure.

Starts language servers lazily when matching editors open and exposes UI-independent sessions to other packages through the `ide-client` service.

## Features

- **Sessions**: starts every matching adapter lazily, scoped to a project root or the workspace, and safely serializes restarts and shutdown.
- **Protocol lifecycle**: negotiates document and notebook synchronization, dynamic capabilities, workspace folders, watched files, file-operation notifications, progress and three JSON-RPC transports.
- **Language features**: supplies completions, symbols, hover, signatures, references, document links, folding, selection ranges, linked editing, colors, formatting, rename, code actions, inlay hints, code lens and semantic tokens.
- **Diagnostics**: combines pushed, per-document pull and workspace pull reports and forwards their current state to the linter package.
- **Feature routing**: merges answers where useful and lets adapter switches choose one of several servers where only one result can apply.
- **Managed servers**: downloads, verifies, updates, rolls back and removes server binaries, npm packages and companion toolchains.
- **Inspection**: exposes server state, capabilities, documents, diagnostics, logs and lifecycle actions through the server list and status bar.

## Installation

To install `ide-client` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-client`.

Install the separate `file-operations` package if language servers should be allowed to create, rename or delete files through `WorkspaceEdit`. Without it, text edits and all other language features continue to work, while resource operations are not advertised.

## Commands

Commands available in `lumine-workspace`:

- `ide-client:servers`: list the running language servers and act on one of them,
- `ide-client:manage-servers`: list the language servers the editor can install and act on one of them,
- `ide-client:restart`: restart the language servers for the active editor,
- `ide-client:toggle-problems`: open the linter panel with the server diagnostics,
- `ide-client:format`: format the active document,
- `ide-client:show-log`: open the active server's log in a new editor,
- `ide-client:open-custom-servers-file`: open the custom servers configuration file,
- `ide-client:fold-server-ranges`: fold every range the active file's language server reports,
- `ide-client:expand-selection-range`: expand each selection to the next parent range from the language server,
- `ide-client:select-linked-ranges`: select every range linked to the symbol under the cursor,
- `ide-client:color-presentation`: choose and apply a language-server spelling for the color under the cursor.

Commands available in `.ide-client-session-menu`:

- `ide-client:show-details`: show what the selected server reports about itself,
- `ide-client:restart-server`: restart the selected server without leaving the list,
- `ide-client:stop-server`: stop the selected server until a matching editor opens again,
- `ide-client:show-server-log`: open the selected server's log in a new editor,
- `ide-client:show-problems`: open the linter panel with the diagnostics of every server.

Commands available in `.ide-client-managed-servers`:

- `ide-client:install-server`: download and install the selected server,
- `ide-client:update-server`: install the newest release of the selected server,
- `ide-client:uninstall-server`: remove the copy the editor installed,
- `ide-client:check-server-updates`: look up the newest release of every installable server.

Commands available in `.ide-client-color-presentations`:

- `ide-client:apply-color-presentation`: apply the selected color spelling.

## Usage

Language servers are registered by adapter packages that consume the `ide-client` service:

```js
consumeIdeClient(ideClient) {
  return ideClient.registerAdapter({
    id: "example",
    displayName: "Example Language Server",
    grammarScopes: ["source.example"],
    async resolveServer({ rootPath }) {
      return { command: "/absolute/path/to/example-ls", args: ["--stdio"], cwd: rootPath };
    },
  });
}
```

Commands are spawned directly with `shell: false`; arguments belong in `args`. The default session scope is one server per project root; a server whose capabilities declare multi-root support is handed further folders instead of being started again, so `sessionScope: "workspace"` is needed only for servers with no notion of a root. Editors without a file path are not attached to language servers. The complete public shapes are documented in `lib/main.d.ts`.

Text edits from `WorkspaceEdit` are applied to versioned editor buffers by this package. Filesystem inspection and resource operations are delegated to the optional `file-operations` infrastructure instead; `ide-client` never falls back to reading or mutating paths itself. The executor's lifecycle lets the hub retarget buffers and replace private staging noise with durable LSP file events, and a session advertises create, rename and delete support only when that executor was available during initialize.

## Configuration

Any language server can be wired without an adapter package through `language-servers.json` in the configuration directory (open it with `ide-client:open-custom-servers-file`). Each entry needs a `command` and grammar `scopes`; `args`, `languageId`, `sessionScope`, `transport`, `env`, `initializationOptions`, `settings`, and `features` are optional. `settings` feeds both `workspace/configuration` lookups and the configuration push after startup, and `features` switches individual capabilities off — an adapter package holds the same switches in its own settings, but a custom server has no settings page to put them on:

```json
{
  "gopls": {
    "command": "gopls",
    "args": ["serve"],
    "scopes": ["source.go"],
    "settings": { "gopls": { "usePlaceholders": true } },
    "features": { "inlayHints": false }
  }
}
```

Saving the file restarts exactly the servers whose entries changed.

## Customization

Tweak the server list, its details step, and the status-bar item from your stylesheet. The item stays the color of the status bar whatever the servers are doing, but it carries `has-starting` and `has-failed` so you can say otherwise:

```css
.ide-client-session-state {
  font-weight: bold;
}
.ide-client-session-detail .ide-client-session-value {
  color: var(--text-color-subtle);
}
.ide-client-server-status .ide-client-server-label {
  color: var(--text-color-info);
}
.ide-client-server-status.has-failed .ide-client-server-label {
  color: var(--text-color-error);
}
```

## Services

- [`ide-client`](docs/ide-client.md): provided to adapter packages to register language servers and reach sessions.
- `autocomplete.provider`: provided to autocomplete to serve language-server completions.
- `symbol.provider`: provided to the symbol hub to serve document and project symbols.
- `hover.provider`: provided to hover UIs to serve documentation at a buffer position.
- `hover.signature-provider`: provided to signature-help UIs to serve call signatures while typing.
- `code-format.range`: provided to formatting orchestrators; resolves a selected range to text edits from the server.
- `code-format.file`: provided to formatting orchestrators; resolves a whole file to text edits from the server.
- `code-format.on-type`: provided to formatting orchestrators; resolves text edits as the user types a trigger character.
- `code-format.on-save`: provided to formatting orchestrators; resolves text edits on save.
- `find-references.provider`: provided to reference UIs to list occurrences of the symbol at a position.
- `refactor.provider`: provided to rename UIs; resolves to a path-to-edits map, with prepare support.
- `intentions.list`: provided to the intentions UI to serve code actions and quick fixes at the cursor.
- `code-lens.provider`: provided to the code lens UI to serve the actionable links shown above the code.
- `inlay-hints.provider`: provided to the inlay hints UI to serve the labels a server computes for the visible rows.
- `semantic-tokens.provider`: provided to the semantic tokens UI to serve the server's classification of the identifiers.
- `hyperclick.provider`: provided to hyperclick to follow language-server document links, resolving lazy targets only when clicked.
- `file-operations.executor`: consumed to preflight and execute the create, rename and delete steps in a server `WorkspaceEdit`.
- `linter.registry`: consumed to push server diagnostics into the linter UI, one delegate per server.
- `busy-signal`: consumed to surface server work-done progress on the busy indicator.
- `status-bar`: consumed to show the running servers in an item that opens the server list.
- `tree-view.file-operations`: consumed to prepare and report create, rename and delete operations so servers can update references before a move.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
