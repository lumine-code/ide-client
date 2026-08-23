# ide-client

Registers a language server with the editor. The adapter says how to launch it and which grammars it serves; `ide-client` does the rest of LSP.

|             |                                                   |
| ----------- | ------------------------------------------------- |
| Version     | `1.0.0`                                           |
| Provided by | `provideIdeClient()` returning the client service |
| Consumed by | `consumeIdeClient(client)`                        |
| Owner       | `ide-client` (bundled)                            |

An adapter package is small — a manifest entry, a `resolveServer`, and a grammar list. Everything a language server can do then arrives in the editor at once, because `ide-client` implements the fifteen UI-facing services (`autocomplete.provider`, `symbol.provider`, `hover.provider`, `outline.provider`, `refactor.provider`, `find-references.provider`, `intentions.list`, `code-lens.provider`, `inlay-hints.provider`, `semantic-tokens.provider`, and the four `code-format.*`) on every adapter's behalf. You do not implement any of them.

The full types are `lib/main.d.ts` in this package.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "ide-client": {
      "versions": { "^1.0.0": "consumeIdeClient" }
    }
  }
}
```

## Contract

The adapter you register:

```ts
interface LanguageServerAdapter {
  id: string;
  displayName: string;
  grammarScopes: string[];
  resolveServer(context: ServerResolutionContext): Promise<ServerLaunch | null>;

  languageId?: string;
  languageIdForScope?(scopeName: string): string | undefined;
  documentSelector?: Array<{ language?: string; scheme?: string; pattern?: string }>;
  sessionScope?: "project-root" | "workspace";
  getInitializationOptions?(context: { rootPath: string; rootUri: string }): unknown;
  getSettings?(): unknown;
  settingsKeyPaths?: string[];
  getWorkspaceConfiguration?(section?: string, resource?: string): unknown;
  handleServerRequest?(
    method: string,
    params: unknown,
    context: { session: LanguageServerSession },
  ): unknown;
  handleServerNotification?(
    method: string,
    params: unknown,
    context: { session: LanguageServerSession },
  ): void;
  features?: Partial<Record<LanguageServerFeature, boolean>>;
  managedServer?: ManagedServerDescriptor;
  installServer?(context: ServerInstallContext): Promise<AdapterInstallResult>;
  latestServerVersion?(api: InstallApi): Promise<string | null>;
  transformDocumentText?(text: string, context: { editor: TextEditor; uri: string }): string;
  restoreDocumentText?(text: string, context: { editor: TextEditor; uri: string }): string;
  transformDiagnostics?(
    diagnostics: Diagnostic[],
    context: { editor?: TextEditor; uri: string; session: LanguageServerSession },
  ): Diagnostic[];
  transformServerCapabilities?(caps: Record<string, unknown>): Record<string, unknown>;
}
```

Four fields are required:

| Field                    | Description                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | Stable identifier, also the key for `getLog`.                                                                                  |
| `displayName`            | Shown to the user in status and logs.                                                                                          |
| `grammarScopes`          | Which editors this server serves.                                                                                              |
| `resolveServer(context)` | Returns a `ServerLaunch`, or `null` when the server is not installed — which disables the adapter quietly rather than failing. |

`ServerLaunch` is `{ command, args?, cwd?, env?, transport?, host?, port?, version?, fileCancellationFolder? }` with `transport` one of `"stdio"` (default), `"ipc"`, or `"socket"`. `fileCancellationFolder` is an absolute, session-unique directory for a server that uses marker files instead of `$/cancelRequest`; `ide-client` creates it and removes it with the connection.

The service you receive:

| Member                                                            | Description                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `registerAdapter(adapter)`                                        | Registers it and returns a `Disposable`.                                                 |
| `adaptersForEditor(editor)`                                       | Every registered adapter that serves that editor, whether or not a server is running.    |
| `onDidChangeAdapters(fn)`                                         | `{ adapter, registered }` whenever an adapter is registered or unregistered.             |
| `sessionForEditor(editor)`                                        | The session serving that editor, or `null`. May still be starting.                       |
| `activeSessionForEditor(editor)`                                  | Resolves once the session has finished starting; `null` when absent, failed, or stopped. |
| `activeSessionsForEditor(editor)`                                 | Every running session serving that editor, in adapter registration order.                |
| `activeSessionForFeature(editor, method, feature?)`               | The first of those that serves `method`, honouring dynamic registrations and switches.   |
| `getSessions()`                                                   | Every session.                                                                           |
| `request(editor, method, params, opts)`                           | Sends a request through the **first** session serving that editor, unchecked. See below. |
| `onDidChangeSession(fn)`                                          | `{ session, state, error? }` on every state transition.                                  |
| `onDidPublishDiagnostics(fn)`                                     | Raw `textDocument/publishDiagnostics` payloads.                                          |
| `onDidChangeFeatures(fn)`                                         | `{ adapter }` when one of an adapter's feature switches changes.                         |
| `featureEnabled(adapter, feature, editor?)`                       | Whether that feature is on for that adapter, in that editor's scope.                     |
| `onDidLog(fn)`, `getLog(adapterId)`                               | Server stderr and protocol log.                                                          |
| `restart(session)`, `stop(session)`                               | Lifecycle control.                                                                       |
| `reportMissingServer(adapterId, opts?)`                           | Says once per window that the server was not found; honours the package's opt-out.       |
| `installServer(adapterId, opts?)`                                 | Fetches and installs the server; reports its own progress and failure.                   |
| `updateServer(adapterId)`                                         | Installs the newest release, or resolves unchanged when already current.                 |
| `uninstallServer(adapterId)`                                      | Removes the managed copy only.                                                           |
| `managedServer(adapterId)`                                        | The installed copy, or `null`.                                                           |
| `serverInstallationStatus(adapterId)`                             | What is happening to that server right now, or `null`.                                   |
| `onDidChangeServerInstallation(fn)`                               | `{ adapterId, status }` as an install proceeds.                                          |
| `applyWorkspaceEdit(edit, label)`                                 | Applies an LSP `WorkspaceEdit` to the workspace.                                         |
| `openNotebookDocument(descriptor)`                                | Opens a notebook for language servers; see "Notebook documents" below.                   |
| `adaptersForNotebook(filePath)`                                   | The adapters serving an open notebook — the stand-down question, notebook-shaped.        |
| `cellUri(notebookPath, cellId)`, `parseCellUri(uri)`              | The `vscode-notebook-cell:` URI vocabulary, e.g. for configuration scope URIs.           |
| `openNotebook`, `changeNotebook`, `saveNotebook`, `closeNotebook` | Raw per-session notebook notifications; prefer `openNotebookDocument`.                   |

`opts` for `request` — both optional:

| Option           | Description                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`         | An `AbortSignal`. Aborting settles the returned promise straight away, whatever the server does next.                                                                                                                                       |
| `cancelOnServer` | Whether aborting also sends `$/cancelRequest`. Defaults to `true`, except for `textDocument/references` and `workspace/executeCommand`, which are abandoned quietly — servers supersede the first themselves, and the second is a mutation. |

### Picking a session

More than one server on a grammar is normal, so `sessionForEditor` and `request` — both of which take the first — are only right when any of them will do. Otherwise resolve a session and use its own `request()`:

```js
const session = await client.activeSessionForFeature(
  editor,
  "textDocument/prepareTypeHierarchy",
  "typeHierarchy",
);
if (!session) return; // nothing running here serves it
const items = await session.request("textDocument/prepareTypeHierarchy", params);
```

Two reasons to hold the session rather than re-pick per request. A reply's `data` is opaque and meaningful only to the server that produced it, so a follow-up sent elsewhere is a protocol violation, not merely a routing preference. And `supports()` consults the dynamic registrations **before** the static capability, while the feature switches are honoured either way — a raw `session.capabilities.<x>Provider` read misses a server that registered late and finds `{}` for one that registers everything dynamically.

Some capabilities the hub advertises on a consumer's behalf, because fragments are merged once at initialize and an external package cannot contribute one: `textDocument.callHierarchy` and `textDocument.typeHierarchy` are both declared for `hierarchy-view`.

The unchecked request API is still a client-capability contract. `ide-client` advertises the generic raw-request routes it implements even when no built-in pane consumes them: document links, document colours, folding ranges, selection ranges, and linked-editing ranges. Keep those capability objects truthful and complete. Servers in the wild sometimes read an optional child such as `textDocument.foldingRange.lineFoldingOnly` without first checking its parent, so an omitted shape can break a valid raw request inside the server.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeIdeClient(client) {
    return client.registerAdapter({
      id: "my-language-server",
      displayName: "My Language Server",
      grammarScopes: ["source.mylang"],
      async resolveServer({ rootPath }) {
        const command = await which("my-langserver");
        if (!command) return null;
        return { command, args: ["--stdio"], cwd: rootPath };
      },
      getSettings: () => ({ mylang: lumine.config.get("my-package.serverSettings") }),
      settingsKeyPaths: ["my-package.serverSettings"],
    });
  },
};
```

## Behavior

`resolveServer` returning `null` is the supported way to be a no-op: an adapter whose server is not installed should return `null` rather than throw, and nothing appears in the UI.

Sessions are keyed by `sessionScope`. `"project-root"`, the default, gives each project folder its own server, because most servers resolve their configuration relative to a root and would answer for the wrong project otherwise. `"workspace"` gives the window a single server whose identity never moves, whichever folders come and go.

A `"project-root"` server that declares `workspace.workspaceFolders.supported` **and** `changeNotifications` does not pay for a second process per folder: the running session takes the new folder through `workspace/didChangeWorkspaceFolders` and is then reachable under both. Servers that declare neither get an instance each. Nothing has to be set on the adapter for this — the capabilities decide.

`getSessions()` returns each server once however many folders it answers for.

`sessionForEditor` may hand back a session that is still starting. Await `activeSessionForEditor` when the next thing you do is a request.

`adaptersForEditor` answers a different question, and it is the one a package outside the hub usually has: is anything already covering this editor? It reads the registration rather than the session, so it is settled the moment the adapter package activates and does not flicker while a server starts, dies, or is restarted. A linter that shells out to the same tool a server serves — `linter-ruff` beside `ide-ruff` — asks this, matches an adapter `id`, and returns no messages for that editor rather than reporting every violation twice. Pair it with `onDidChangeAdapters`, since an adapter that registers after the editor was last handled leaves the duplicate on screen until something asks for another pass.

The `languageId` sent to the server is resolved in order: `languageIdForScope(scopeName)`, then the built-in scope table, then the blanket `languageId`. Override only the level you actually need.

`getSettings` is pushed as `workspace/didChangeConfiguration` after initialize, and re-pushed whenever a config key listed in `settingsKeyPaths` changes. Without `settingsKeyPaths` the settings are sent once and never refreshed.

`handleServerRequest` and `handleServerNotification` cover protocol extensions owned by one server rather than LSP itself. Core client handlers still take precedence; the adapter sees only otherwise-unhandled traffic. Requests must return the JSON-RPC result the server expects, while notifications are also emitted through `session.onNotification` after the adapter observes them.

The core handlers include server-initiated `workspace/workspaceFolders`. Its result is the same current folder list sent during initialize, so a server may query it later without an adapter hook. The client also sends folder-change notifications to sessions that declare support for them.

`transformDocumentText` can adapt an editor's text before `didOpen`, `didChange`, and `didSave`. An adapter that uses it receives full-document changes so the server never sees a mixture of transformed and original text. `restoreDocumentText` reverses the adaptation in formatting, rename, and workspace edits before they reach the editor. A transform must preserve line positions outside the text it intentionally hides.

`transformDiagnostics` is the adapter's last word on what its server reported, for the diagnostic a server insists on and its own users do not want — `ide-json` drops "Comments are not permitted in JSON" with it. Every route arrives at the same funnel, push notifications and pulled reports alike, so what it returns is what is stored, emitted, counted and handed to a code-action request as context; there is no unfiltered copy behind it. Returning the array unchanged is free. Prefer it over `transformDocumentText` whenever the goal is what the server _says_ rather than what it _sees_: hiding text costs a reversal in every edit that comes back, and one that survives a reformat is rarely writable.

`session.supports(method, editor)` honours dynamic registrations, so ask it rather than reading `capabilities` yourself when a server registers capabilities after initialize. It also honours the feature switches below, which is why it is the only correct way to ask.

`transformServerCapabilities` is the escape hatch for a server that under- or over-reports what it can do.

## Notebook documents

`openNotebookDocument(descriptor)` teaches the hub a notebook: LSP 3.17 notebook sync, per capable session. The descriptor carries the notebook's `filePath`, its `notebookType` (defaults to `"jupyter-notebook"`), and the **full ordered cell list** — markup cells included, because the 1-based cell numbers diagnostics carry count every cell — each cell with a stable `id`, its `kind`, and its live `editors`. The returned bridge has `updateCells(cells)` for structural changes (the hub computes the LSP deltas), `didSave()`, and `dispose()`; content sync follows each code cell's buffer on its own. The caller of record is `jupyter-view`, whose own bridge adapts its document model to this shape — another notebook UI would drive the same bridge.

What follows from an open bridge, with no further wiring:

- Each cell is its own text document under a `vscode-notebook-cell:` URI whose path component is the notebook's, so client and server positions are both cell-relative — identity, no mapping.
- Only sessions whose server advertises a matching `notebookDocumentSync` ever see the notebook, and only they are asked about cell URIs. A same-grammar server without notebook sync is never consulted for a cell.
- Cell editors route through every provider — completions, hover, signature, code actions, formatting — exactly like file editors.
- Cell diagnostics aggregate per notebook and reach the linter against the notebook's path with `cell` numbers, the same shape `linter-ruff`'s CLI route emits; jupyter-view's adapter projects them onto the cells.
- Workspace edits and `window/showDocument` targets naming cell URIs land in the right cell buffers; the descriptor's `show` callback is how server-initiated navigation reveals a cell.

An untitled notebook cannot open — `openNotebookDocument` returns `null` until the notebook has a path. The bridge is **path-immutable**: on a save-as, dispose it and open a new one, which is also how servers expect a renamed notebook to behave.

A server that exits on its own is restarted on a growing delay, up to `restartLimit` times in a row, and the session is replaced each time — an adapter that holds one has to follow `onDidChangeSession` rather than keep the reference. The limit counts a failure run rather than the life of the window: a server that stays up for a minute has its restarts back, and one that dies on every start reaches the limit and is reported to the user with a way into its log. A restart somebody asked for, through `restart(session)` or the server list, starts a new run. A server that fails its very first start is reported once and not retried, since nothing about it has worked yet.

## Managed servers

An adapter that declares `managedServer` lets the editor fetch its server, keep it current and remove it again, and appears in the Manage Servers list. Nothing else changes: the descriptor is data, and `resolveServer` stays the only thing that decides what runs.

```ts
type ManagedServerDescriptor =
  | {
      source: "github-release";
      displayName?: string;
      repository: string; // "owner/name"
      assetFor(c: { platform: string; arch: string; version: string }): string | null;
      checksum: "sha256-sidecar" | "none";
      assetType?: "archive" | "binary"; // defaults to archive
      binary: string; // installed base name; located inside an archive when applicable
      strip?: number;
    }
  | {
      source: "npm";
      displayName?: string;
      packages: string[]; // extracted side by side; the first decides the version
      module: string; // entry module, relative to the install directory
      bundled?: boolean; // the package also ships the server, so uninstall falls back
    };
```

Everything lands in `<configDir>/language-servers/<adapter.id>/`, one directory per adapter whatever the source. The installed copy is handed back on `context.managedServer`, so `resolveServer` reads one field rather than knowing that layout:

```js
async resolveServer(context) {
  const configured = lumine.config.get("my-package.serverPath");
  if (configured) return { command: configured };
  if (context.managedServer)
    return { command: context.managedServer.binaryPath, version: context.managedServer.version };
  return { command: await which("my-langserver") } ?? null;
}
```

That order is the convention: an explicit setting wins, then the copy the user asked the editor to install, then whatever is on `PATH` — which is also where uninstalling lands.

Four things are worth knowing before writing a descriptor:

- **`assetFor` returns an exact file name**, never a pattern. A release commonly carries other archives whose names share a prefix — tinymist publishes `tinymist-docs-tool-<target>` beside the server's own — and a prefix match fetches the wrong one. Returning `null` says this platform has no build, which is reported rather than guessed at.
- **`checksum` is stated, not inferred.** `"none"` records a source that publishes nothing to verify against; texlab is one today. Making that a value in the descriptor keeps the gap visible in the adapter instead of being a step the installer quietly skips.
- **`binary` is a base name.** Archives put it at the root or one directory down, and it is searched for rather than predicted. Set `assetType: "binary"` when the release asset is the executable itself; it is installed under this base name and made executable on macOS and Linux.
- **An npm source is an upgrade tier when the package already ships the server.** Set `bundled: true` and keep the dependency: the pinned copy stays the floor, so uninstalling drops back to it and can never leave the user with nothing. `ide-pyright` works this way.

Descriptors are validated at `registerAdapter`, not at install time, so a typo surfaces when the package activates.

Installing, updating and removing all stop the adapter's sessions first, swap the directory, and re-attach — Windows refuses to replace a running executable, and a server that keeps running through the swap would go on serving from a directory that no longer exists.

### Fetching your own server

A descriptor only describes the shapes it was designed for. An adapter whose server does not fit one — several binaries rather than a server, a release layout nobody anticipated — implements `installServer` instead and uses the primitives the hub hands it. This is the model Zed's extension API uses, and the names mirror it deliberately.

```js
async installServer({ storagePath, api }) {
  api.setServerInstallationStatus("downloading");
  const release = await api.latestGithubRelease("owner/tool");
  const asset = release.assets.find((a) => a.name === assetForThisPlatform());
  await api.downloadFile(asset.url, storagePath, { type: "gzip-tar" });
  await api.makeFileExecutable(`${storagePath}/tool`);
  return { version: release.version, binary: "tool" };
}
```

Fill `storagePath` and return `{ version, binary }` or `{ version, module }` naming what to launch, relative to the install directory. Everything else is unchanged: the hub stages, swaps atomically, rolls back on failure, writes the same `install.json`, stops and restarts sessions in the same order, and reports the same status. It is the descriptor path without the descriptor.

| primitive                                         |                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `latestGithubRelease(repository, { preRelease })` | `{ version, tag, assets: [{ name, url, size }] }`; throws with the status rather than resolving empty |
| `githubReleaseByTag(repository, tag)`             | the same shape                                                                                        |
| `npmPackageLatestVersion(name)`                   |                                                                                                       |
| `npmPackageInstalledVersion(name, directory)`     | `null` when absent                                                                                    |
| `npmInstallPackage(name, version, directory)`     | installs the package and its tree; `--omit=dev --ignore-scripts`                                      |
| `downloadFile(url, destination, { type })`        | `type` ∈ `uncompressed` \| `gzip` \| `gzip-tar` \| `zip`                                              |
| `makeFileExecutable(path)`                        | no-op on Windows                                                                                      |
| `setServerInstallationStatus(status)`             | `checking` \| `downloading` \| `installing` \| `failed` \| `null`                                     |

Two things to know. **`managedServer` and `installServer` are mutually exclusive** — declaring both leaves it ambiguous which one fills the staging directory, and is rejected at `registerAdapter`. And **`downloadFile` does not verify checksums**: the descriptor path verifies every download against what its source publishes, and it cannot force that on a caller, so an adapter reaching for the primitive owns its own verification. Zed has the same gap; stating it is the difference.

Implement `latestServerVersion(api)` as well if the Manage Servers list should have a version to compare against; without it the row simply reports what is installed.

### One status vocabulary

Whatever an adapter does underneath, it reports through `setServerInstallationStatus`, and the hub sets the same states around every install it runs. That is deliberately the only place uniformity is enforced: the Manage Servers rows and the busy indicator read the status, never the mechanism. A user should never learn that one server arrives as a GitHub asset and another as an npm tree.

### Saying the server is missing

Do not raise the notification yourself. Call `reportMissingServer(adapterId, { description })` from the `resolveServer` branch that returns `null`, and the hub handles the rest:

```js
if (!launch) {
  service.reportMissingServer("ide-ruff", { description: "Install Ruff and …" });
  return null;
}
```

It fires **once per window per adapter**, adds an **Install** button when the adapter declares `managedServer`, and always adds **Never Ask Again**. Either button closes the notification — a notification button dismisses nothing on its own, and both answers here are final, so a banner still asking the question is the only thing on screen saying whether the click registered. It is a warning, not an error: an adapter with no server is not broken, it simply has nothing to run, and several such packages installed at once otherwise means a stack of red banners for tools the user may never have wanted.

Never Ask Again writes `false` to `<adapter.id>.notifyWhenMissing`, so **declare that setting in your `configSchema`** or the user has no way to turn it back on:

```json
"notifyWhenMissing": {
  "title": "Notify When Missing",
  "description": "Show a notification when the language server cannot be found, offering to install it.",
  "type": "boolean",
  "default": true
}
```

The once-per-window flag is cleared as soon as a session for that adapter starts, so a server that is removed later is reported again rather than staying silent.

## Features

More than one adapter commonly covers one grammar — a type checker beside a linter — and for the requests whose answers cannot be merged the hub has to pick one server. Left to itself it picks whichever adapter registered first, which is package activation order and says nothing about which server the user wants. The feature switches are how that choice is expressed: a switched-off server is skipped, and the next one that can serve the request answers instead.

The vocabulary is `diagnostics`, `autocomplete`, `hover`, `signature`, `definition`, `references`, `callHierarchy`, `typeHierarchy`, `symbols`, `outline`, `format`, `rename`, `codeActions`, `inlayHints`, `codeLens`, and `semanticTokens`. They are names for what the user sees, not protocol methods: one switch covers all three formatting requests, and `symbols` and `outline` split `textDocument/documentSymbol` between go-to-symbol and the outline panel.

Declare them in your `package.json` under `features`, listing **only what your server actually advertises** — a switch for a capability the server never had is a control that does nothing:

```json
{
  "configSchema": {
    "features": {
      "title": "Features",
      "description": "Which parts of this server the editor uses.",
      "type": "object",
      "properties": {
        "hover": {
          "title": "Hover",
          "description": "Show this server's documentation on hover.",
          "type": "boolean",
          "default": true
        }
      }
    }
  }
}
```

The hub reads `<adapter id>.features.<name>`, so the key path follows from your `id` and nothing has to be registered. Every switch is read through the editor's scope, so a user can override one per language. A feature nobody named is on.

The `features` field on the adapter object is the fallback for an adapter with no config namespace — a custom server from `language-servers.json`, whose id carries a colon. A package should use `configSchema`, which the user can actually change; that wins over the field.

`diagnostics` is the odd one: servers may push them or expose the LSP 3.17 pull model. Switching diagnostics off hides stored results; pull-capable servers are also not queried until the switch is enabled again.

## Teardown

`registerAdapter` returns a `Disposable` that unregisters the adapter and stops its sessions — return it directly from `consumeIdeClient`, as in the example. Sessions are also stopped when `ide-client` deactivates, so an adapter needs no shutdown logic of its own.

That holds for a window reload too, which never deactivates a package: the servers are killed as the window goes away rather than asked to shut down, since no LSP round trip can finish at that point. Do not add an unload handler of your own — a language server is a child process, and one left running is orphaned for the life of the machine.

Teardown never stops early. A server that cannot be shut down cleanly is reported and skipped, so it cannot strand the servers beside it. The one exception is `stop(session)`, which rejects, because a stop somebody asked for should be able to say it failed.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
