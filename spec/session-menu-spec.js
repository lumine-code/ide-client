describe("ide-client session menu", () => {
  let main, menu;

  const stubSession = (state, id = "stub", rootPath = "/project", folders = [rootPath]) => ({
    adapter: { id, displayName: `${id} Server` },
    rootPath,
    state,
    folders: new Set(folders),
    // Teardown takes whatever is left in the map through one of these — `stop`
    // on deactivation, `kill` on unload.
    stop() {},
    kill() {},
  });

  const render = async (item) => {
    await menu.serverList.setItems([{ id: "rendered-server", session: {}, ...item }]);
    return menu.serverList.getElement().querySelector("li");
  };
  const renderDetail = async (item) => {
    await menu.detailsList.setItems([item]);
    return menu.detailsList.getElement().querySelector("li");
  };

  beforeEach(async () => {
    await lumine.packages.activatePackage("ide-client");
    main = lumine.packages.getActivePackage("ide-client").mainModule;
    menu = main.sessionMenu;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-client");
  });

  it("puts the state in the trailing block of the primary line", async () => {
    const element = await render({
      label: "stub Server",
      detail: "/project",
      state: "running",
    });
    const trailing = element.querySelector(".primary-line > .trailing-block");
    expect(trailing).not.toBe(null);

    const badge = trailing.querySelector(".ide-client-session-state");
    expect(badge.textContent).toBe("running");
    // The name stays in the primary text, so the ellipsis truncates it and not
    // the state.
    expect(element.querySelector(".primary-text").textContent).toBe("stub Server");
  });

  it("renders the state as a themed badge, one variant per state", async () => {
    const badgeFor = async (state) =>
      (await render({ label: "stub Server", state })).querySelector(".ide-client-session-state");

    expect([...(await badgeFor("running")).classList]).toEqual([
      "ide-client-session-state",
      "badge",
      "badge-success",
    ]);
    expect((await badgeFor("starting")).classList.contains("badge-warning")).toBe(true);
    expect((await badgeFor("stopping")).classList.contains("badge-warning")).toBe(true);
    expect((await badgeFor("failed")).classList.contains("badge-error")).toBe(true);
    // An idle server gets the plain neutral pill, not a variant.
    expect([...(await badgeFor("stopped")).classList]).toEqual([
      "ide-client-session-state",
      "badge",
    ]);
  });

  it("renders the root path as a second line the theme dims", async () => {
    const element = await render({
      label: "stub Server",
      detail: "/project",
      state: "running",
    });
    expect(element.classList.contains("two-lines")).toBe(true);
    expect(element.querySelector(".secondary-line").textContent).toBe("/project");
  });

  it("puts a detail's value in the trailing block, so the values line up", async () => {
    const element = await renderDetail({
      label: "Command",
      value: "pyright-langserver --stdio",
    });
    expect(element.querySelector(".primary-text").textContent).toBe("Command");

    // The value carries its own class: the trailing block is floated and would
    // otherwise run a long command line off the edge of the card.
    const value = element.querySelector(".trailing-block .ide-client-session-value");
    expect(value.textContent).toBe("pyright-langserver --stdio");
  });

  it("hosts the list in the view's own panel, so a click outside cancels it", async () => {
    expect(menu.serverListHost.isVisible()).toBe(false);
    await menu.toggle();
    expect(menu.serverListHost.isVisible()).toBe(true);
    expect(menu.serverListHost.getPanel().getItem()).toBe(menu.serverList);

    menu.serverListHost.cancel();
    expect(menu.serverListHost.isVisible()).toBe(false);
  });

  it("clears the previous query when it reopens", async () => {
    await menu.toggle();
    menu.serverList.getQueryEditor().setText("pyright");
    await menu.toggle();
    await menu.toggle();
    expect(menu.serverList.getQuery()).toBe("");
  });

  it("names every folder a server answers for, not the one that started it", () => {
    const shared = stubSession("running", "pyright", "/project", ["/project", "/work/tools"]);
    main.manager.sessions.set("pyright:/project", shared);
    main.manager.sessions.set("pyright:/work/tools", shared);
    spyOn(lumine.project, "getPaths").and.returnValue(["/project", "/work/tools"]);

    const [item, ...rest] = menu.serverItems();
    // One entry for one server, however many folders it took on.
    expect(rest).toEqual([]);
    expect(item.detail).toBe("Roots (2) · /project, /work/tools");
  });

  it("shows the whole project for a workspace-scoped server", () => {
    const session = stubSession("running", "wide", "/project");
    session.adapter.sessionScope = "workspace";
    main.manager.sessions.set("wide:", session);
    spyOn(lumine.project, "getPaths").and.returnValue(["/one", "/two"]);

    // Its own rootPath is just whichever folder came first.
    expect(menu.serverItems()[0].detail).toBe("Workspace · /one, /two");
  });

  it("calls a single project folder a root", () => {
    main.manager.sessions.set("stub:/project", stubSession("running"));
    spyOn(lumine.project, "getPaths").and.returnValue(["/project"]);
    expect(menu.serverItems()[0].detail).toBe("Root · /project");
  });

  it("names the file for a server started outside the project", () => {
    // No project folder contains it, so the session is rooted at the file's own
    // directory — the directory is an implementation detail, the file is not.
    const session = stubSession("running", "loose", "/tmp/scratch");
    session.documents = new Map([["uri", { editor: { getPath: () => "/tmp/scratch/notes.py" } }]]);
    main.manager.sessions.set("loose:/tmp/scratch", session);
    spyOn(lumine.project, "getPaths").and.returnValue(["/project"]);

    expect(menu.serverItems()[0].detail).toBe("File · /tmp/scratch/notes.py");
  });

  it("falls back to the directory when the loose file has no path yet", () => {
    const session = stubSession("running", "loose", "/tmp/scratch");
    main.manager.sessions.set("loose:/tmp/scratch", session);
    spyOn(lumine.project, "getPaths").and.returnValue(["/project"]);

    expect(menu.serverItems()[0].detail).toBe("File · /tmp/scratch");
  });

  it("lists the servers of the active editor first", () => {
    const other = stubSession("running", "zeta");
    const serving = stubSession("running", "alpha");
    main.manager.sessions.set("zeta:/project", other);
    main.manager.sessions.set("alpha:/project", serving);
    spyOn(main.manager, "sessionsForEditor").and.returnValue([other]);
    spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue({});

    expect(menu.serverItems().map((item) => item.label)).toEqual(["zeta Server", "alpha Server"]);
  });

  describe("stepping into a server's details", () => {
    let session;

    beforeEach(() => {
      session = stubSession("running", "pyright");
      session.serverInfo = { name: "basedpyright", version: "1.31.0" };
      session.launch = { command: "basedpyright-langserver", args: ["--stdio"] };
      session.process = { pid: 24180 };
      session.capabilities = {
        hoverProvider: true,
        definitionProvider: {},
        renameProvider: false,
      };
      session.documents = new Map([
        ["file:///a.py", {}],
        ["file:///b.py", {}],
      ]);
      main.manager.sessions.set("pyright:/project", session);
      main.manager.diagnostics.set(
        session,
        new Map([
          ["file:///a.py", { diagnostics: [{}, {}, {}] }],
          ["file:///b.py", { diagnostics: [] }],
        ]),
      );
      spyOn(lumine.project, "getPaths").and.returnValue(["/project"]);
    });

    it("routes a confirmed server row into showDetails", async () => {
      spyOn(menu, "showDetails");
      await menu.toggle();
      expect(menu.serverList.getItemCount()).toBe(1);

      expect((await menu.serverList.confirmSelection()).status).toBe("success");
      expect(menu.showDetails).toHaveBeenCalledWith(session);
    });

    it("shows the details as a flow step named after the server", async () => {
      await menu.toggle();
      await menu.showDetails(session);

      expect(menu.serverListHost.isVisible()).toBe(false);
      expect(menu.detailsListHost.isVisible()).toBe(true);
      expect(lumine.workspace.getModalTrail()).toEqual(["Servers", "pyright Server"]);
      expect(menu.detailsList.getItems().map((item) => item.label)).toEqual([
        "State",
        "Scope",
        "Server",
        "Process",
        "Command",
        "Documents",
        "Diagnostics",
        "Capabilities",
      ]);
    });

    it("reports what the session knows about itself", () => {
      const values = new Map(menu.detailItems(session).map((item) => [item.label, item.value]));

      expect(values.get("State")).toBe("running");
      expect(values.get("Server")).toBe("basedpyright 1.31.0");
      expect(values.get("Process")).toBe("pid 24180 · stdio");
      expect(values.get("Command")).toBe("basedpyright-langserver --stdio");
      expect(values.get("Documents")).toBe("2");
      // A document whose diagnostics were cleared keeps its entry, and is not
      // a file with problems.
      expect(values.get("Diagnostics")).toBe("3 in 1 file");
      // Only what the server actually advertised, with the suffix off. A
      // capability the server declared false is not one it has.
      expect(values.get("Capabilities")).toBe("definition, hover");
    });

    it("says how often a server has been restarted out from under the user", () => {
      session.restartCount = 2;
      const [state] = menu.detailItems(session);
      expect(state.value).toBe("running · restarted 2×");
    });

    it("leaves out the rows a session has nothing to report for", () => {
      const bare = stubSession("starting", "bare");
      main.manager.sessions.set("bare:/project", bare);
      expect(menu.detailItems(bare).map((item) => item.label)).toEqual(["State", "Scope"]);
    });

    it("copies a confirmed value and stays open to show what it took", async () => {
      await menu.toggle();
      await menu.showDetails(session);

      const command = menu.detailsList.getItems().find((item) => item.label === "Command");
      await menu.detailsList.selectItem(command);
      expect((await menu.detailsList.confirmSelection()).status).toBe("success");

      expect(lumine.clipboard.read()).toBe("basedpyright-langserver --stdio");
      expect(menu.detailsListHost.isVisible()).toBe(true);
      expect(menu.detailsList.getElement().querySelector(".status-message").textContent).toBe(
        "Copied Command",
      );

      // It takes itself down, and the copy hint is still underneath.
      advanceClock(2000);
      await conditionPromise(() =>
        Boolean(menu.detailsList.getElement().querySelector(".info-message")),
      );
      expect(menu.detailsList.getElement().querySelector(".info-message").textContent).toBe(
        "Confirm a row to copy its value",
      );
    });

    it("returns to a freshly built server list on back navigation", async () => {
      await menu.toggle();
      await menu.showDetails(session);

      // A server that appeared while the details were open must be in the
      // list the back navigation re-shows.
      main.manager.sessions.set("late:/project", stubSession("starting", "late"));

      expect(lumine.workspace.popModal()).toBe(true);
      expect(menu.serverListHost.isVisible()).toBe(true);
      expect(menu.serverList.getItems().map((item) => item.label)).toEqual([
        "late Server",
        "pyright Server",
      ]);
      expect(lumine.workspace.getModalTrail()).toEqual(["Servers"]);
    });
  });

  describe("acting on a server from the list", () => {
    let first, second;

    beforeEach(async () => {
      // Sorted by display name, so `alpha` is the row above `zeta`.
      first = stubSession("running", "alpha");
      second = stubSession("running", "zeta");
      main.manager.sessions.set("alpha:/project", first);
      main.manager.sessions.set("zeta:/project", second);
      spyOn(lumine.project, "getPaths").and.returnValue(["/project"]);
      await menu.toggle();
    });

    it("acts on the row the selection is on, not on the first one", async () => {
      spyOn(main.manager, "restart").and.returnValue(Promise.resolve(second));
      await menu.serverList.selectIndex(1);

      expect((await menu.serverList.runAction("ide-client:restart-server")).status).toBe("success");
      expect(main.manager.restart).toHaveBeenCalledWith(second);

      spyOn(main.manager, "disconnect").and.returnValue(Promise.resolve());
      expect((await menu.serverList.runAction("ide-client:stop-server")).status).toBe("success");
      expect(main.manager.disconnect).toHaveBeenCalledWith(second);

      spyOn(main, "showLogForAdapter").and.returnValue(Promise.resolve());
      expect((await menu.serverList.runAction("ide-client:show-server-log")).status).toBe(
        "success",
      );
      expect(main.showLogForAdapter).toHaveBeenCalledWith("zeta");
    });

    it("keeps the list open and reports a failure where the row still is", async () => {
      spyOn(main.manager, "restart").and.returnValue(Promise.reject(new Error("no such command")));
      spyOn(lumine.notifications, "addError");

      await menu.run(main.manager.restart(first));

      expect(menu.serverListHost.isVisible()).toBe(true);
      expect(lumine.notifications.addError.calls.mostRecent().args[0]).toBe(
        "Language server action failed",
      );
    });

    it("repaints the open list on a state change, keeping the selection put", async () => {
      await menu.serverList.selectIndex(1);
      expect(menu.serverList.getSelectedItem().session).toBe(second);

      // What a restart reports: the row's own session object is replaced, and
      // only the key it is filed under carries the identity across.
      const replacement = stubSession("starting", "zeta");
      main.manager.sessions.set("zeta:/project", replacement);
      await menu.refresh();

      expect(menu.serverList.getItems().map((item) => item.state)).toEqual(["running", "starting"]);
      expect(menu.serverList.getSelectedItem().session).toBe(replacement);
    });

    it("leaves a hidden list alone, so reopening it is what rebuilds the rows", async () => {
      await menu.toggle();
      spyOn(menu, "serverItems");

      await menu.refresh();
      expect(menu.serverItems).not.toHaveBeenCalled();
    });
  });
});
