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
// Everything that acts on a row is a command registered on the list itself,
// which is what puts it in the item-actions list with its keystroke and lets it
// be pressed straight from the list.
module.exports = class ManagedServersView {
  constructor(main) {
    this.main = main;
    this.subscriptions = new CompositeDisposable();
    this.list = lumine.workspace.buildSelectList({
      className: "ide-client-managed-servers",
      crumb: "Manage Servers",
      items: [],
      emptyMessage: "No installable language servers are registered",
      filterKeyForItem: (item) => `${item.label} ${item.detail || ""}`,
      elementForItem: (item) => this.elementForItem(item),
      // Runs on every show, including a back navigation, so the rows always
      // carry current versions.
      willShow: () => this.list.update({ items: this.items() }),
      didConfirmSelection: (item) => this.primaryAction(item),
      didCancelSelection: () => this.list.hide(),
    });
    this.subscriptions.add(
      lumine.commands.add(this.list.element, {
        "ide-client:install-server": {
          description: "Download and install the selected server",
          didDispatch: () => this.act((id) => this.main.installServer(id)),
        },
        "ide-client:update-server": {
          description: "Install the newest release of the selected server",
          didDispatch: () => this.act((id) => this.main.updateServer(id)),
        },
        "ide-client:uninstall-server": {
          description: "Remove the copy the editor installed",
          didDispatch: () => this.uninstallSelected(),
        },
        "ide-client:check-server-updates": {
          description: "Look up the newest release of every installable server",
          didDispatch: () => this.checkForUpdates(),
        },
      }),
      // An install reports as it goes, so the row follows it rather than
      // freezing on whatever the list saw when it opened.
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

  elementForItem(item) {
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

  selected() {
    return this.list.getSelectedItem()?.entry ?? null;
  }

  // Confirming a row does the thing that row is for, so the common case needs
  // no keystroke to learn: install what is not there, and update what is.
  primaryAction(item) {
    const entry = item?.entry;
    if (!entry) return undefined;
    return entry.installed
      ? this.act((id) => this.main.updateServer(id), entry)
      : this.act((id) => this.main.installServer(id), entry);
  }

  // The list stays open while an install runs: the row it belongs to is the
  // context for whatever the action reports, and closing would take that away.
  async act(work, target = this.selected()) {
    if (!target) return;
    try {
      await work(target.adapter.id);
    } catch {
      // Reported where the action ran, with the reason it failed.
    }
    await this.refresh();
  }

  async uninstallSelected() {
    const entry = this.selected();
    if (!entry) return;
    if (!entry.installed) {
      return this.list.update({
        infoMessage: `${entry.displayName} has no managed copy to remove`,
      });
    }
    try {
      await this.managed().uninstall(entry.adapter.id);
      await this.list.update({
        infoMessage: entry.hasFallback
          ? `Removed the managed ${entry.displayName}; the copy that ships with the package is back in use`
          : `Removed ${entry.displayName}`,
      });
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
    await this.list.update({ infoMessage: "Checking for updates…" });
    const adapters = this.managed().adapters();
    await Promise.all(
      adapters.map((adapter) => this.managed().latestVersion(adapter, { force: true })),
    );
    const items = this.items();
    const behind = items.filter((item) => item.entry.updatable).length;
    await this.list.update({
      items,
      infoMessage: behind
        ? `${behind} ${behind === 1 ? "server has" : "servers have"} a newer release`
        : "Every installed server is up to date",
    });
  }

  // Rebuilding the items takes the selection back to the top with them, which
  // would hand the next keystroke a different server than the one it was aimed
  // at, so the selected row is put back by its id.
  async refresh() {
    if (!this.list.isVisible()) return;
    const selected = this.list.getSelectedItem();
    const items = this.items();
    await this.list.update({ items });
    const index = items.findIndex((item) => item.id === selected?.id);
    if (index > 0) await this.list.selectIndex(index);
  }

  async toggle() {
    if (this.list.isVisible()) return this.list.hide();
    this.list.show();
  }

  destroy() {
    this.subscriptions.dispose();
    this.list.destroy();
  }
};
