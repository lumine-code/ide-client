describe("ide-client item actions", () => {
  let main, list;

  function nextAction(owner) {
    return new Promise((resolve) => {
      const subscription = owner.onDidFinishAction((event) => {
        subscription.dispose();
        resolve(event);
      });
    });
  }

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    // No activation commands here, so a plain activation resolves; it also
    // loads the package keymap the actions list reads.
    main = (await lumine.packages.activatePackage("ide-client")).mainModule;
    list = main.sessionMenu.serverList;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-client");
  });

  it("derives its session actions from the command registrations and the keymap", async () => {
    await list.setItems([
      {
        id: "pyright:/project",
        label: "pyright Server",
        detail: "Root · /project",
        state: "running",
        session: {},
      },
    ]);
    await list.selectIndex(0);
    const actions = list.getAvailableActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    const restart = byCommand.get("ide-client:restart-server");
    expect(restart.name).toBe("Restart Server");
    expect(restart.description).toBe("Restart the selected server without leaving the list.");
    expect(restart.keystrokes).toEqual(["alt-r"]);

    expect(byCommand.get("ide-client:stop-server").keystrokes).toEqual(["alt-delete"]);
    expect(byCommand.get("ide-client:show-server-log").keystrokes).toEqual(["alt-l"]);
    expect(byCommand.get("ide-client:show-problems").keystrokes).toEqual(["alt-p"]);
    expect(byCommand.get("ide-client:show-problems").context).toBe("dialog");
    expect(byCommand.get("ide-client:show-details").keystrokes).toEqual(["enter"]);
    expect(byCommand.get("ide-client:show-details").primary).toBe(true);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }

    // Chrome and the window-wide commands stay out — the latter is why the
    // in-list names are not `restart`, `show-log` and `toggle-problems`.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("ide-client:servers")).toBe(false);
    expect(byCommand.has("ide-client:restart")).toBe(false);
    expect(byCommand.has("ide-client:show-log")).toBe(false);
    expect(byCommand.has("ide-client:toggle-problems")).toBe(false);
  });

  it("keeps only the session-wide action when no server is selected", async () => {
    await list.setItems([]);

    expect(list.getAvailableActions().map((action) => action.command)).toEqual([
      "ide-client:show-problems",
    ]);
  });

  it("switches the managed-server primary action between install and update", async () => {
    const managedList = main.getManagedMenu().list;
    expect(managedList.getSource().mode).toBe("snapshot");
    const selectEntry = async (installed) => {
      await managedList.setItems([
        {
          id: "example",
          label: "Example Server",
          detail: installed ? "1.0.0 · installed" : "not installed",
          state: installed ? null : "missing",
          entry: { adapter: { id: "example" }, installed },
        },
      ]);
      await managedList.selectIndex(0);
      return new Map(managedList.getAvailableActions().map((action) => [action.command, action]));
    };

    let actions = await selectEntry(null);
    expect([...actions.keys()]).toEqual([
      "ide-client:install-server",
      "ide-client:check-server-updates",
    ]);
    expect(actions.get("ide-client:install-server").keystrokes).toEqual(["enter", "alt-i"]);
    expect(actions.get("ide-client:install-server").primary).toBe(true);
    expect(actions.get("ide-client:check-server-updates").context).toBe("dialog");

    actions = await selectEntry("1.0.0");
    expect([...actions.keys()]).toEqual([
      "ide-client:update-server",
      "ide-client:uninstall-server",
      "ide-client:check-server-updates",
    ]);
    expect(actions.get("ide-client:update-server").keystrokes).toEqual(["enter", "alt-u"]);
    expect(actions.get("ide-client:update-server").primary).toBe(true);

    managedList.selectNone();
    expect(managedList.getAvailableActions().map((action) => action.command)).toEqual([
      "ide-client:check-server-updates",
    ]);
  });

  it("shows the actions as a flow step and runs one against the server list", async () => {
    const session = {
      adapter: { id: "pyright", displayName: "pyright Server" },
      rootPath: "/project",
      state: "running",
      folders: new Set(["/project"]),
      // The manager takes every entry of its session map through teardown, so a
      // double that leaves these out is not a session it can shut down.
      stop() {},
      kill() {},
    };
    main.manager.sessions.set("pyright:/project", session);
    spyOn(lumine.project, "getPaths").and.returnValue(["/project"]);
    spyOn(main.manager, "restart").and.returnValue(Promise.resolve(session));

    await main.sessionMenu.toggle();
    await list.showActions();

    const actionElement = lumine.workspace.getElement().querySelector(".select-list-actions");
    const actionList = actionElement.getModel();
    expect(actionList.isVisible()).toBe(true);
    expect(lumine.workspace.getModalTrail()).toEqual(["Servers", "Actions"]);
    expect(actionElement.classList.contains("ide-client-session-menu")).toBe(false);
    expect(actionList.getItems().map(({ command }) => command)).toContain(
      "ide-client:restart-server",
    );

    const finished = nextAction(list);
    lumine.commands.dispatch(actionElement, "ide-client:restart-server");
    expect((await finished).status).toBe("success");

    // Running an action returns to the server list first, so the handler finds
    // the server row it was chosen for still selected.
    expect(main.manager.restart).toHaveBeenCalledWith(session);
    expect(list.isVisible()).toBeTruthy();
    expect(actionList.isVisible()).toBeFalsy();
  });
});
