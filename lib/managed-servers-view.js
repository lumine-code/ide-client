const { CompositeDisposable } = require("lumine");

// The state chip is a plain `.badge`, so its shape and colors come from the UI
// theme. `installed` maps to no variant on purpose: a server that is simply
// present should read as neutral, not as a success the user has to acknowledge.
const STATE_BADGES = {
  update: "badge-info",
  missing: "badge-warning",
  // What is happening right now outranks what is installed, and reads the same
  // for every adapter however it acquires its server.
  checking: "badge-info",
  downloading: "badge-info",
  installing: "badge-info",
  failed: "badge-error",
};

const STATE_LABELS = {
  update: "update",
  missing: "not installed",
  checking: "checking…",
  downloading: "downloading…",
  installing: "installing…",
  failed: "failed",
};

// Lists every language server the editor can install, whether or not one is
// running — which is the gap this view exists to close. `ide-client:servers` is
// keyed on live sessions, so a server that has never resolved appears nowhere
// in it, and "the thing I want is not installed" was invisible.
//
// Everything that acts on a row is an explicit list action with its command
// metadata and keystroke.
module.exports = class ManagedServersView {
  constructor(main) {
    this.main = main;
    this.subscriptions = new CompositeDisposable();
    this.list = lumine.workspace.buildSelectList({
      className: "ide-client-managed-servers",
      crumb: "Manage Servers",
      items: [],
      emptyMessage: "No installable language servers are registered",
      getItemId: (item) => item.id,
      search: { getFilterText: (item) => `${item.label} ${item.detail || ""}` },
      renderItem: (item) => this.renderItem(item),
      source: { mode: "snapshot", load: () => this.items() },
      commands: {
        "ide-client:install-server": {
          description: "Download and install the selected server.",
          didDispatch: (event) =>
            this.act((id) => this.main.installServer(id), event.detail.item.entry),
        },
        "ide-client:update-server": {
          description: "Install the newest release of the selected server.",
          didDispatch: (event) =>
            this.act((id) => this.main.updateServer(id), event.detail.item.entry),
        },
        "ide-client:uninstall-server": {
          description: "Remove the copy the editor installed.",
          didDispatch: (event) => this.uninstall(event.detail.item.entry),
        },
        "ide-client:check-server-updates": {
          description: "Look up the newest release of every installable server.",
          didDispatch: () => this.checkForUpdates(),
        },
      },
      actions: [
        {
          command: "ide-client:install-server",
          context: "item",
          when: ({ item }) => !item.entry.installed,
          primary: ({ item }) => !item.entry.installed,
          disposition: "stay",
          dispatch: "local",
          group: "install",
        },
        {
          command: "ide-client:update-server",
          context: "item",
          when: ({ item }) => Boolean(item.entry.installed),
          primary: ({ item }) => Boolean(item.entry.installed),
          disposition: "stay",
          dispatch: "local",
          group: "install",
        },
        {
          command: "ide-client:uninstall-server",
          context: "item",
          when: ({ item }) => Boolean(item.entry.installed),
          disposition: "stay",
          dispatch: "local",
          group: "install",
          tone: "danger",
        },
        {
          command: "ide-client:check-server-updates",
          context: "dialog",
          disposition: "stay",
          dispatch: "local",
          group: "updates",
        },
      ],
    });
    this.subscriptions.add(
      // An install reports as it goes, so the row follows it rather than
      // freezing on the opening snapshot.
      this.managed().onDidChangeInstallation(() => this.refresh()),
    );
  }

  managed() {
    return this.main.managedServers;
  }

  items() {
    return this.managed()
      .adapters()
      .map((adapter) => this.managed().describe(adapter))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((entry) => ({
        id: entry.adapter.id,
        label: entry.displayName,
        detail: this.describe(entry),
        state:
          entry.status ||
          (entry.updatable ? "update" : entry.installed || entry.hasFallback ? null : "missing"),
        entry,
      }));
  }

  // What the row says about itself. An adapter whose package also ships the
  // server has no "missing" state to report — uninstalling only drops back to
  // the copy that came with it — so it says which copy is in use instead.
  describe(entry) {
    if (entry.updatable) return `${entry.installed} · ${entry.available} available`;
    if (entry.installed) return `${entry.installed} · installed`;
    if (entry.hasFallback) return "bundled with the package";
    return entry.available ? `${entry.available} available · not installed` : "not installed";
  }

  renderItem(item) {
    return {
      primary: item.label,
      secondary: item.detail,
      trailing: [
        item.state && {
          text: STATE_LABELS[item.state] ?? item.state,
          className: `ide-client-managed-state badge ${STATE_BADGES[item.state] ?? ""}`.trim(),
        },
      ],
    };
  }

  // The list stays open while an install runs: the row it belongs to is the
  // context for whatever the action reports, and closing would take that away.
  async act(work, target) {
    if (!target) return;
    try {
      await work(target.adapter.id);
    } catch {
      // Reported where the action ran, with the reason it failed.
    }
    await this.refresh();
  }

  async uninstall(entry) {
    if (!entry) return;
    if (!entry.installed) {
      return this.list.setInfoMessage(`${entry.displayName} has no managed copy to remove`);
    }
    try {
      await this.managed().uninstall(entry.adapter.id);
      await this.list.setInfoMessage(
        entry.hasFallback
          ? `Removed the managed ${entry.displayName}; the copy that ships with the package is back in use`
          : `Removed ${entry.displayName}`,
      );
    } catch (error) {
      lumine.notifications.addError(`Could not remove ${entry.displayName}`, {
        detail: error.message,
        dismissable: true,
      });
    }
    await this.refresh();
  }

  // One lookup per adapter, run together. Failures are already swallowed by
  // `latestVersion`, so an offline machine simply learns nothing new rather
  // than raising one dialog per server.
  async checkForUpdates() {
    await this.list.setInfoMessage("Checking for updates…");
    const adapters = this.managed().adapters();
    await Promise.all(
      adapters.map((adapter) => this.managed().latestVersion(adapter, { force: true })),
    );
    const items = this.items();
    const behind = items.filter((item) => item.entry.updatable).length;
    await this.list.setItems(items);
    await this.list.setInfoMessage(
      behind
        ? `${behind} ${behind === 1 ? "server has" : "servers have"} a newer release`
        : "Every installed server is up to date",
    );
  }

  // Stable IDs keep the selected adapter in place when its row is rebuilt.
  async refresh() {
    if (!this.list.isVisible()) return;
    await this.list.setItems(this.items());
  }

  async toggle() {
    if (this.list.isVisible()) return this.list.hide();
    return this.list.show();
  }

  destroy() {
    this.subscriptions.dispose();
    return this.list.destroy();
  }
};
