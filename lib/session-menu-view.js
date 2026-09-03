const { CompositeDisposable } = require("lumine");

// The state chip is a plain `.badge`, so its shape and colors come from the UI
// theme rather than from this package. `stopped` maps to no variant on purpose:
// the neutral pill is what an idle server should read as.
const STATE_BADGES = {
  running: "badge-success",
  starting: "badge-warning",
  stopping: "badge-warning",
  failed: "badge-error",
};

// A server advertises each feature as a `<feature>Provider` field, so the field
// names are the feature list once the suffix is off.
const PROVIDER_SUFFIX = /Provider$/;

// Stands in the message line from the moment the details open, so the first
// copy replaces a line that is already there rather than pushing the rows down.
const COPY_HINT = "Confirm a row to copy its value";

// Lists every language server the window is running — not only the one serving
// the active editor — so any session can be inspected or acted on from
// anywhere. Confirming a server steps into its details; everything that acts on
// one is an explicit list action with its command metadata and keystroke.
module.exports = class SessionMenuView {
  constructor(main) {
    this.main = main;
    this.subscriptions = new CompositeDisposable();
    // Each step has its own model and modal host, which the modal flow chains.
    this.serverListHost = lumine.workspace.addSelectList(
      {
        items: [],
        emptyMessage: "No language servers are running",
        getItemId: (item) => item.id,
        search: { getFilterText: (item) => `${item.label} ${item.detail || ""}` },
        renderItem: (item) => this.renderServerItem(item),
        source: { mode: "snapshot", load: () => this.serverItems() },
        commands: {
          "ide-client:show-details": {
            description: "Show what the selected server reports about itself.",
            didDispatch: (event) => this.showDetails(event.detail.item.session),
          },
          "ide-client:restart-server": {
            description: "Restart the selected server without leaving the list.",
            didDispatch: (event) => this.restart(event.detail.item),
          },
          "ide-client:stop-server": {
            description: "Stop the selected server until a matching editor opens again.",
            didDispatch: (event) => this.stop(event.detail.item),
          },
          "ide-client:show-server-log": {
            description: "Open the selected server's log in a new editor.",
            didDispatch: (event) => this.showLog(event.detail.item),
          },
          "ide-client:show-problems": {
            description: "Open the linter panel with the diagnostics of every server.",
            didDispatch: () => this.main.showProblems(),
          },
        },
        actions: [
          {
            command: "ide-client:show-details",
            context: "item",
            primary: true,
            disposition: "push",
            dispatch: "local",
            group: "inspect",
          },
          {
            command: "ide-client:restart-server",
            context: "item",
            disposition: "stay",
            dispatch: "local",
            group: "server",
          },
          {
            command: "ide-client:stop-server",
            context: "item",
            disposition: "stay",
            dispatch: "local",
            group: "server",
          },
          {
            command: "ide-client:show-server-log",
            context: "item",
            disposition: "stay",
            dispatch: "local",
            group: "inspect",
          },
          {
            command: "ide-client:show-problems",
            context: "dialog",
            disposition: "stay",
            dispatch: "local",
            group: "inspect",
          },
        ],
      },
      {
        className: "ide-client-session-menu",
        crumb: "Servers",
      },
    );
    this.serverList = this.serverListHost.getModel();
    // Not the menu's class: the package keymap binds the server actions under
    // it, and none of them means anything here.
    this.detailsListHost = lumine.workspace.addSelectList(
      {
        items: [],
        getItemId: (item) => item.label,
        search: { getFilterText: (item) => `${item.label} ${item.value}` },
        renderItem: (item) => this.renderDetail(item),
        commands: {
          "ide-client:copy-server-detail": {
            description: "Copy the selected server detail.",
            didDispatch: (event) => this.copyDetail(event.detail.item),
          },
        },
        actions: [
          {
            command: "ide-client:copy-server-detail",
            context: "item",
            primary: true,
            disposition: "stay",
            dispatch: "local",
          },
        ],
      },
      { className: "ide-client-session-details" },
    );
    this.detailsList = this.detailsListHost.getModel();
    this.subscriptions.add(
      // Restarting and stopping happen with the list still open, so the rows
      // have to follow the server rather than freeze on the opening snapshot.
      this.main.manager.onDidChangeSession(() => this.refresh()),
      // A flow resume is deliberately not a new source opening. Rebuild here
      // so a server that appeared while its details were open is visible.
      this.serverListHost.onDidResume(() => this.serverList.setItems(this.serverItems())),
    );
  }

  // The state goes in the trailing block, so the states line up down the right
  // edge instead of each one trailing a name of a different length.
  renderServerItem(item) {
    return {
      primary: item.label,
      secondary: item.detail,
      trailing: [
        item.state && {
          text: item.state,
          className: `ide-client-session-state badge ${STATE_BADGES[item.state] ?? ""}`.trim(),
        },
      ],
    };
  }

  // Same shape for the detail rows: the label reads down the left edge and the
  // values line up on the right.
  renderDetail(item) {
    return {
      primary: item.label,
      className: "ide-client-session-detail",
      trailing: [{ text: item.value, className: "ide-client-session-value" }],
    };
  }

  // What the server actually covers, named as such. A bare path cannot say
  // whether it is the project, one root among several, or the directory of a
  // loose file — and naming a server after the folder that happened to start
  // it is a lie for anything serving more than one.
  scopeOf(session) {
    const scope = this.main.manager.scopeFor(session);
    if (scope === "file") {
      // The folder is only the file's directory; the file is what was opened.
      const files = [...(session.documents?.values() || [])]
        .map((document) => document.editor?.getPath())
        .filter(Boolean);
      if (files.length)
        return { label: files.length > 1 ? `Files (${files.length})` : "File", files };
      return { label: "File", files: [...session.folders] };
    }
    const folders = this.main.manager.foldersFor(session);
    if (scope === "workspace") return { label: "Workspace", files: folders };
    return { label: folders.length > 1 ? `Roots (${folders.length})` : "Root", files: folders };
  }

  describeScope(session) {
    const { label, files } = this.scopeOf(session);
    const paths = files.length ? files : [session.rootPath];
    return `${label} · ${paths.join(", ")}`;
  }

  // The active editor's servers come first: they are the ones the user is
  // most likely acting on.
  serverItems() {
    const editor = lumine.workspace.getActiveTextEditor();
    const serving = new Set(editor ? this.main.manager.sessionsForEditor(editor) : []);
    return this.main.manager
      .allSessions()
      .sort(
        (a, b) =>
          (serving.has(a) ? 0 : 1) - (serving.has(b) ? 0 : 1) ||
          a.adapter.displayName.localeCompare(b.adapter.displayName),
      )
      .map((session) => ({
        // A restart hands the session's keys to a replacement object, so the
        // key identifies the row across one and the identity does not.
        id: this.main.manager.keysFor(session)[0] ?? session.adapter.id,
        label: session.adapter.displayName,
        detail: this.describeScope(session),
        state: session.state,
        session,
      }));
  }

  // Everything the session knows about itself that a bug report or a "why is
  // this server not answering" would ask for. A row with nothing to report is
  // left out rather than shown empty.
  detailItems(session) {
    const rows = [];
    const add = (label, value) => {
      if (value) rows.push({ label, value: String(value) });
    };
    const { launch, serverInfo, capabilities = {} } = session;

    add(
      "State",
      session.restartCount
        ? `${session.state} · restarted ${session.restartCount}×`
        : session.state,
    );
    add("Scope", this.describeScope(session));
    add("Server", serverInfo && [serverInfo.name, serverInfo.version].filter(Boolean).join(" "));
    // The pid says which process to look at in a task manager; the transport
    // says what the connection to it is. Only a session that was given a launch
    // has either — `stdio` is the default the launch is read with, not a guess
    // to make on a session that has none.
    add(
      "Process",
      launch &&
        [session.process?.pid && `pid ${session.process.pid}`, launch.transport || "stdio"]
          .filter(Boolean)
          .join(" · "),
    );
    add("Command", launch && [launch.command, ...(launch.args || [])].filter(Boolean).join(" "));
    // Stringified here rather than in `add`, so a server holding no documents
    // still reports the zero.
    add("Documents", session.documents && String(session.documents.size));
    const diagnostics = this.main.manager.diagnosticCountFor(session);
    add(
      "Diagnostics",
      diagnostics.total &&
        `${diagnostics.total} in ${diagnostics.files} ${diagnostics.files === 1 ? "file" : "files"}`,
    );
    add(
      "Capabilities",
      Object.keys(capabilities)
        .filter((key) => PROVIDER_SUFFIX.test(key) && capabilities[key])
        .map((key) => key.replace(PROVIDER_SUFFIX, ""))
        .sort()
        .join(", "),
    );
    return rows;
  }

  // Acting on a server keeps the list open, so a failure has to be reported
  // where the user can still see the row it belongs to.
  run(promise) {
    return Promise.resolve(promise).catch((error) =>
      lumine.notifications.addError("Language server action failed", {
        detail: error.message,
        dismissable: true,
      }),
    );
  }

  restart(item) {
    return this.run(this.main.manager.restart(item.session));
  }

  stop(item) {
    return this.run(this.main.manager.disconnect(item.session));
  }

  showLog(item) {
    return this.run(this.main.showLogForAdapter(item.session.adapter.id));
  }

  // A state change repaints the rows in place. Stable IDs let the list retain
  // the selected server even when a restart replaces its session object.
  async refresh() {
    if (!this.serverListHost.isVisible()) return;
    await this.serverList.setItems(this.serverItems());
  }

  // The details show themselves as a flow step: the visible server list becomes
  // the trail root, and Shift-Escape or a crumb click returns to it.
  async showDetails(session) {
    if (!session) return;
    await this.detailsList.setItems(this.detailItems(session));
    await this.detailsList.setInfoMessage(COPY_HINT);
    return this.detailsListHost.show({ crumb: session.adapter.displayName });
  }

  // The panel stays open: a value is read as often as it is copied, and losing
  // the rest of the details to take one line is a poor trade.
  copyDetail(item) {
    lumine.clipboard.write(item.value);
    // A status rather than the info line: it expires by itself and the copy
    // hint comes back underneath, where overwriting the hint left the panel
    // saying "Copied Command" for as long as it stayed open.
    return this.detailsList.setStatus({ message: `Copied ${item.label}`, duration: 2000 });
  }

  async toggle() {
    if (this.serverListHost.isVisible()) return this.serverListHost.hide();
    if (this.detailsListHost.isVisible()) return this.detailsListHost.hide();
    return this.serverListHost.show();
  }

  destroy() {
    this.subscriptions.dispose();
    return Promise.all([this.serverListHost.destroy(), this.detailsListHost.destroy()]);
  }
};
