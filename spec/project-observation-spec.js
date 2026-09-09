const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const ServerSession = require("../lib/server-session");
const C = require("../lib/converters");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let tick = 0; tick < 80; tick++) await Promise.resolve();
};

describe("project observation before language server scans", () => {
  let manager, adapter, roots, directories, watches, start, restart, notify;
  const rootA = path.resolve("observation-project-a");
  const rootB = path.resolve("observation-project-b");
  const rootC = path.resolve("observation-project-c");
  const watch = (root) => {
    const pending = deferred();
    pending.handle = { path: root };
    watches.set(root, pending);
    directories.set(root, { getPath: () => root });
    return pending;
  };
  const ready = (root) => watches.get(root).resolve(watches.get(root).handle);
  const begin = () => manager.ensureSession(adapter, rootA);
  const afterGrace = async (starting) => {
    await flush();
    advanceClock(5000);
    await flush();
    const session = await starting;
    await session.ready;
    return session;
  };
  beforeEach(() => {
    roots = [rootA];
    directories = new Map();
    watches = new Map();
    watch(rootA);
    watch(rootB);
    watch(rootC);
    spyOn(lumine.project, "getPaths").and.callFake(() => roots);
    spyOn(lumine.project, "getDirectories").and.callFake(() =>
      roots.map((root) => directories.get(root)),
    );
    spyOn(lumine.project, "getWatcherPromise").and.callFake((root) => watches.get(root).promise);
    manager = new LanguageServerManager();
    manager.knownRoots = [...roots];
    adapter = {
      id: "observed",
      displayName: "Observed",
      grammarScopes: ["source.observation-test"],
      resolveServer: jasmine
        .createSpy("resolve server")
        .and.resolveTo({ command: "unused-test-server" }),
    };
    manager.adapters.set(adapter.id, adapter);
    start = spyOn(ServerSession.prototype, "start").and.callFake(async function () {
      this.capabilities = {
        workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      };
      this.setState("running");
    });
    spyOn(ServerSession.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    notify = spyOn(ServerSession.prototype, "notify");
    restart = spyOn(manager, "restart").and.callThrough();
  });
  afterEach(async () => manager.deactivate());

  it("waits before resolving or starting and ignores unrelated project roots", async () => {
    roots = [rootA, rootB];
    const starting = begin();
    await flush();
    expect(adapter.resolveServer).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(lumine.project.getWatcherPromise.calls.allArgs()).toEqual([[rootA]]);
    ready(rootA);
    const session = await starting;
    await session.ready;
    expect(start).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("lets rejected watches settle without rejecting server startup", async () => {
    const starting = begin();
    watches.get(rootA).reject(new Error("watch limit"));
    const session = await starting;
    await session.ready;
    expect(start).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("bounds the initial grace to five seconds", async () => {
    const starting = begin();
    await flush();
    advanceClock(4999);
    await flush();
    expect(start).not.toHaveBeenCalled();
    advanceClock(1);
    const session = await starting;
    await session.ready;
    expect(start).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("cancels a pending wait without waiting for the watch or deadline", async () => {
    const starting = begin();
    await flush();
    manager.cancelController(manager.controllerForRoute(adapter, rootA));
    expect(await starting).toBeNull();
    ready(rootA);
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts one degraded generation once when its watches later become ready", async () => {
    adapter.sessionScope = "workspace";
    roots = [rootA, rootB];
    const session = await afterGrace(begin());
    ready(rootA);
    ready(rootB);
    await flush();
    expect(restart).toHaveBeenCalledOnceWith(session);
    await restart.calls.mostRecent().returnValue;
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not restart if readiness arrived before the delayed server resolution finished", async () => {
    const resolved = deferred();
    adapter.resolveServer.and.returnValue(resolved.promise);
    const starting = begin();
    await flush();
    advanceClock(5000);
    await flush();
    ready(rootA);
    await flush();
    resolved.resolve({ command: "unused-test-server" });
    const session = await starting;
    await session.ready;
    expect(restart).not.toHaveBeenCalled();
  });

  it("keeps late recovery when an unrelated advertised folder leaves during startup settlement", async () => {
    adapter.sessionScope = "workspace";
    roots = [rootA, rootB, rootC];
    manager.knownRoots = [...roots];
    ready(rootA);
    ready(rootC);
    const session = await afterGrace(begin());
    const settling = deferred();
    session.ready = settling.promise;
    ready(rootB);
    await flush();
    roots = [rootA, rootB];
    await manager.projectPathsChanged();
    settling.resolve();
    await flush();
    expect(restart).toHaveBeenCalledOnceWith(session);
    await restart.calls.mostRecent().returnValue;
  });

  it("does not recover a removed root or a canceled session", async () => {
    await afterGrace(begin());
    roots = [];
    await manager.projectPathsChanged();
    ready(rootA);
    await flush();
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not restart when a timed-out watch ultimately fails", async () => {
    await afterGrace(begin());
    watches.get(rootA).reject(new Error("watch unavailable"));
    await flush();
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not revive a canceled degraded session when its watch becomes ready", async () => {
    const session = await afterGrace(begin());
    manager.cancelController(manager.controllerForSession(session));
    ready(rootA);
    await flush();
    expect(restart).not.toHaveBeenCalled();
  });

  it("ignores a late ready from a replaced watch at the same path", async () => {
    await afterGrace(begin());
    const oldWatch = watches.get(rootA);
    const directory = directories.get(rootA);
    watch(rootA);
    directories.set(rootA, directory);
    ready(rootA);
    oldWatch.resolve(oldWatch.handle);
    await flush();
    expect(restart).not.toHaveBeenCalled();
  });

  it("waits before announcing new workspace folders without restarting on ordinary readiness", async () => {
    adapter.sessionScope = "workspace";
    ready(rootA);
    const session = await begin();
    await session.ready;
    roots = [rootA, rootB];
    const announcing = manager.projectPathsChanged();
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(manager.workspaceFolders(session).map((folder) => folder.uri)).toEqual([
      C.pathToUri(rootA),
    ]);
    ready(rootB);
    await announcing;
    expect(notify).toHaveBeenCalledWith("workspace/didChangeWorkspaceFolders", {
      event: { added: [manager.folderOf(rootB)], removed: [] },
    });
    expect(restart).not.toHaveBeenCalled();
    expect(manager.workspaceFolders(session).map((folder) => folder.uri)).toEqual([
      C.pathToUri(rootA),
      C.pathToUri(rootB),
    ]);
  });

  it("coalesces rapid folder changes against the last advertised root set", async () => {
    adapter.sessionScope = "workspace";
    ready(rootA);
    const session = await begin();
    await session.ready;
    roots = [rootA, rootB];
    const first = manager.projectPathsChanged();
    await flush();
    roots = [rootA, rootB, rootC];
    const second = manager.projectPathsChanged();
    ready(rootB);
    ready(rootC);
    await Promise.all([first, second]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.calls.mostRecent().args[1].event.added.map((folder) => folder.uri)).toEqual([
      C.pathToUri(rootB),
      C.pathToUri(rootC),
    ]);
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not announce a folder removed while its watch was pending", async () => {
    adapter.sessionScope = "workspace";
    ready(rootA);
    const session = await begin();
    await session.ready;
    roots = [rootA, rootB];
    const first = manager.projectPathsChanged();
    await flush();
    roots = [rootA];
    await manager.projectPathsChanged();
    ready(rootB);
    await first;
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("recovers once after announcing a folder whose readiness exceeded the grace", async () => {
    adapter.sessionScope = "workspace";
    ready(rootA);
    const session = await begin();
    await session.ready;
    roots = [rootA, rootB];
    const announcing = manager.projectPathsChanged();
    await flush();
    advanceClock(5000);
    await announcing;
    expect(notify).toHaveBeenCalledTimes(1);
    ready(rootB);
    await flush();
    expect(restart).toHaveBeenCalledOnceWith(session);
    await restart.calls.mostRecent().returnValue;
  });

  it("waits for a newly adopted root before routing it to a multi-root server", async () => {
    ready(rootA);
    const session = await begin();
    await session.ready;
    roots = [rootA, rootB];
    const adopting = manager.adoptFolder(adapter, rootB);
    await flush();
    expect(session.folders.has(rootB)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    ready(rootB);
    expect(await adopting).toBe(session);
    expect(session.folders.has(rootB)).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });
});
