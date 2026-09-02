const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const tar = require("tar");
const LanguageServerManager = require("../lib/language-server-manager");
const ManagedServers = require("../lib/managed-servers");
const { compareVersions, parseSidecar, bsdtarPath } = ManagedServers;

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const integrityOf = (buffer) =>
  `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;

// A response of the shape `fetch` returns, for whichever body the route serves.
const respond = (body) => ({
  ok: true,
  status: 200,
  json: async () => JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : body),
  text: async () => (Buffer.isBuffer(body) ? body.toString("utf8") : String(body)),
  arrayBuffer: async () => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  },
});
const missing = (status = 404) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => "",
  arrayBuffer: async () => new ArrayBuffer(0),
});

describe("ManagedServers", () => {
  let manager, managed, storageRoot, scratch, routes, requested;

  // Builds a gzipped tar of `files` — a map of relative path to contents — so
  // extraction, binary location and the swap are all exercised for real rather
  // than stubbed.
  const tarball = async (files) => {
    const source = fs.mkdtempSync(path.join(scratch, "src-"));
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(source, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    const archive = path.join(scratch, `archive-${Object.keys(routes).length}.tar.gz`);
    await tar.c({ file: archive, cwd: source, gzip: true }, fs.readdirSync(source));
    const buffer = fs.readFileSync(archive);
    fs.rmSync(archive, { force: true });
    return buffer;
  };

  const adapterFor = (managedServer) => ({
    id: "ide-test",
    displayName: "Test Server",
    grammarScopes: ["source.test"],
    resolveServer: async () => null,
    managedServer,
  });

  const githubDescriptor = (overrides = {}) => ({
    source: "github-release",
    displayName: "Testlang",
    repository: "example/testlang",
    assetFor: () => "testlang-x86_64.tar.gz",
    checksum: "sha256-sidecar",
    binary: "testlang",
    ...overrides,
  });

  const npmDescriptor = (overrides = {}) => ({
    source: "npm",
    displayName: "Testpkg",
    packages: ["testpkg"],
    module: "node_modules/testpkg/server.js",
    ...overrides,
  });

  const register = (descriptor) => {
    const adapter = adapterFor(descriptor);
    manager.registerAdapter(adapter);
    return adapter;
  };

  beforeEach(() => {
    manager = new LanguageServerManager();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "managed-servers-"));
    storageRoot = path.join(scratch, "language-servers");
    routes = {};
    requested = [];
    managed = new ManagedServers(manager, {
      storageRoot,
      fetchUrl: async (url) => {
        requested.push(url);
        const route = routes[url];
        if (route === undefined) return missing();
        return typeof route === "function" ? route() : respond(route);
      },
    });
    manager.setManagedServers(managed);
  });

  afterEach(async () => {
    await manager.deactivate();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("compareVersions", () => {
    it("orders by numeric segment", () => {
      expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
      expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
      expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    });

    it("ignores a leading v and treats missing segments as zero", () => {
      expect(compareVersions("v1.2.0", "1.2")).toBe(0);
    });

    it("sorts a prerelease before the release it precedes", () => {
      expect(compareVersions("1.1.0-rc.1", "1.1.0")).toBeLessThan(0);
      expect(compareVersions("1.1.0", "1.1.0-rc.1")).toBeGreaterThan(0);
    });

    it("orders calendar-versioned releases by their complete date", () => {
      expect(compareVersions("2026-02-08", "2026-02-01")).toBeGreaterThan(0);
      expect(compareVersions("2026-01-28", "2026-02-01")).toBeLessThan(0);
      expect(compareVersions("2026-02-08", "2026-02-08")).toBe(0);
    });
  });

  describe("parseSidecar", () => {
    it("reads a bare digest and the sha256sum two-column form", () => {
      const digest = "a".repeat(64);
      expect(parseSidecar(digest)).toBe(digest);
      expect(parseSidecar(`${digest}  testlang-x86_64.tar.gz\n`)).toBe(digest);
      expect(parseSidecar("not a digest")).toBe(null);
    });
  });

  describe("descriptor validation", () => {
    it("rejects a github-release descriptor that states no checksum policy", () => {
      expect(() =>
        manager.registerAdapter(adapterFor(githubDescriptor({ checksum: undefined }))),
      ).toThrowError(/managedServer\.checksum/);
    });

    it("rejects a github-release descriptor with no assetFor or binary", () => {
      expect(() =>
        manager.registerAdapter(adapterFor(githubDescriptor({ assetFor: undefined }))),
      ).toThrowError(/managedServer\.assetFor/);
      expect(() =>
        manager.registerAdapter(adapterFor(githubDescriptor({ binary: undefined }))),
      ).toThrowError(/managedServer\.binary/);
      expect(() =>
        manager.registerAdapter(adapterFor(githubDescriptor({ binary: "../testlang" }))),
      ).toThrowError(/managedServer\.binary/);
    });

    it("rejects an unknown github release asset type", () => {
      expect(() =>
        manager.registerAdapter(adapterFor(githubDescriptor({ assetType: "directory" }))),
      ).toThrowError(/managedServer\.assetType/);
    });

    it("rejects an npm descriptor with no packages or module", () => {
      expect(() =>
        manager.registerAdapter(adapterFor(npmDescriptor({ packages: [] }))),
      ).toThrowError(/managedServer\.packages/);
      expect(() =>
        manager.registerAdapter(adapterFor(npmDescriptor({ module: undefined }))),
      ).toThrowError(/managedServer\.module/);
    });

    it("rejects an unknown source", () => {
      expect(() =>
        manager.registerAdapter(adapterFor({ source: "ftp", binary: "x" })),
      ).toThrowError(/managedServer\.source/);
    });

    it("accepts an adapter with no descriptor at all", () => {
      expect(() => manager.registerAdapter(adapterFor(undefined))).not.toThrow();
    });
  });

  describe("installing from a GitHub release", () => {
    const url =
      "https://github.com/example/testlang/releases/download/v1.2.3/testlang-x86_64.tar.gz";

    const serveRelease = async (files) => {
      const archive = await tarball(files);
      routes["https://api.github.com/repos/example/testlang/releases/latest"] = JSON.stringify({
        tag_name: "v1.2.3",
      });
      routes[url] = archive;
      routes[`${url}.sha256`] = `${sha256(archive)}  testlang-x86_64.tar.gz\n`;
      return archive;
    };

    it("downloads, verifies and installs, finding a binary nested in the archive", async () => {
      await serveRelease({ "testlang-1.2.3/testlang": "#!/bin/sh\n" });
      const adapter = register(githubDescriptor());

      const record = await managed.install("ide-test");

      expect(record.version).toBe("1.2.3");
      expect(record.source).toBe("github-release");
      expect(record.binary).toBe(path.join("testlang-1.2.3", "testlang"));

      const install = managed.installFor(adapter);
      expect(install.version).toBe("1.2.3");
      expect(fs.existsSync(install.binaryPath)).toBe(true);
      expect(install.modulePath).toBe(null);
      // The record is written inside the install so it moves with it.
      expect(fs.existsSync(path.join(storageRoot, "ide-test", "install.json"))).toBe(true);
    });

    it("finds a binary sitting at the archive root", async () => {
      await serveRelease({ testlang: "#!/bin/sh\n" });
      const adapter = register(githubDescriptor());
      await managed.install("ide-test");
      expect(managed.installFor(adapter).binaryPath).toBe(
        path.join(storageRoot, "ide-test", "testlang"),
      );
    });

    it("installs a raw release executable under the declared binary name", async () => {
      const asset = "testlang-linux-x64";
      const rawUrl = `https://github.com/example/testlang/releases/download/v1.2.3/${asset}`;
      const payload = Buffer.from("native executable");
      routes["https://api.github.com/repos/example/testlang/releases/latest"] = JSON.stringify({
        tag_name: "v1.2.3",
      });
      routes[rawUrl] = payload;
      const adapter = register(
        githubDescriptor({
          assetFor: () => asset,
          assetType: "binary",
          checksum: "none",
        }),
      );

      const record = await managed.install("ide-test");

      expect(record.asset).toBe(asset);
      expect(record.assetType).toBe("binary");
      expect(record.binary).toBe("testlang");
      expect(fs.readFileSync(managed.installFor(adapter).binaryPath)).toEqual(payload);
      if (process.platform !== "win32")
        expect(fs.statSync(managed.installFor(adapter).binaryPath).mode & 0o111).not.toBe(0);
    });

    it("requests exactly the asset name the descriptor computed", async () => {
      await serveRelease({ testlang: "x" });
      // The tinymist release carries `tinymist-docs-tool-<target>` assets beside
      // the server's own, so a prefix match would fetch the wrong one.
      register(githubDescriptor({ assetFor: () => "testlang-x86_64.tar.gz" }));
      await managed.install("ide-test");
      expect(requested).toContain(url);
    });

    it("discards a download whose checksum does not match and installs nothing", async () => {
      await serveRelease({ testlang: "x" });
      routes[`${url}.sha256`] = `${"b".repeat(64)}  testlang-x86_64.tar.gz\n`;
      const adapter = register(githubDescriptor());

      await expectAsync(managed.install("ide-test")).toBeRejectedWithError(/published checksum/);

      expect(managed.installFor(adapter)).toBe(null);
      expect(fs.existsSync(path.join(storageRoot, "ide-test"))).toBe(false);
      // No staging directory is left behind either.
      expect(fs.readdirSync(storageRoot).filter((name) => name.startsWith(".stage-"))).toEqual([]);
    });

    it("skips verification only when the descriptor says the source publishes none", async () => {
      await serveRelease({ testlang: "x" });
      delete routes[`${url}.sha256`];
      register(githubDescriptor({ checksum: "none" }));
      await expectAsync(managed.install("ide-test")).toBeResolved();
      expect(requested).not.toContain(`${url}.sha256`);
    });

    it("reports a platform the source publishes no build for", async () => {
      await serveRelease({ testlang: "x" });
      register(githubDescriptor({ assetFor: () => null }));
      await expectAsync(managed.install("ide-test")).toBeRejectedWithError(/publishes no build/);
    });

    it("reports an archive that does not contain the declared binary", async () => {
      await serveRelease({ "testlang-1.2.3/something-else": "x" });
      register(githubDescriptor());
      await expectAsync(managed.install("ide-test")).toBeRejectedWithError(/does not contain/);
    });

    it("keeps the previous install when the swap fails", async () => {
      await serveRelease({ testlang: "first" });
      const adapter = register(githubDescriptor());
      await managed.install("ide-test");
      const target = path.join(storageRoot, "ide-test");
      expect(fs.readFileSync(path.join(target, "testlang"), "utf8")).toBe("first");

      await serveRelease({ testlang: "second" });
      // Fail the move of the staged tree into place, after the old install has
      // already been set aside — the one window where the previous copy is not
      // where it belongs.
      const rename = fs.promises.rename;
      let calls = 0;
      spyOn(fs.promises, "rename").and.callFake((from, to) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("swap interrupted"));
        return rename(from, to);
      });

      await expectAsync(managed.install("ide-test")).toBeRejectedWithError(/swap interrupted/);

      expect(fs.readFileSync(path.join(target, "testlang"), "utf8")).toBe("first");
      expect(managed.installFor(adapter).version).toBe("1.2.3");
    });
  });

  describe("installing from npm", () => {
    const metadataUrl = "https://registry.npmjs.org/testpkg/1.1.411";
    const latestUrl = "https://registry.npmjs.org/testpkg/latest";
    const tarballUrl = "https://registry.npmjs.org/testpkg/-/testpkg-1.1.411.tgz";

    const servePackage = async (files) => {
      // npm wraps every published tree in a single `package/` directory.
      const archive = await tarball(files);
      const metadata = {
        version: "1.1.411",
        dist: { tarball: tarballUrl, integrity: integrityOf(archive) },
      };
      routes[latestUrl] = JSON.stringify(metadata);
      routes[metadataUrl] = JSON.stringify(metadata);
      routes[tarballUrl] = archive;
      return archive;
    };

    it("lays each package out under one node_modules", async () => {
      await servePackage({ "package/server.js": "module.exports = 1;\n" });
      const adapter = register(npmDescriptor());

      const record = await managed.install("ide-test");

      expect(record.source).toBe("npm");
      expect(record.version).toBe("1.1.411");
      const install = managed.installFor(adapter);
      expect(install.binaryPath).toBe(null);
      expect(install.modulePath).toBe(
        path.join(storageRoot, "ide-test", "node_modules", "testpkg", "server.js"),
      );
      expect(fs.existsSync(install.modulePath)).toBe(true);
    });

    it("discards a package that does not match its integrity hash", async () => {
      await servePackage({ "package/server.js": "x" });
      const metadata = JSON.parse(routes[metadataUrl]);
      metadata.dist.integrity = `sha512-${Buffer.from("wrong").toString("base64")}`;
      routes[metadataUrl] = JSON.stringify(metadata);
      const adapter = register(npmDescriptor());

      await expectAsync(managed.install("ide-test")).toBeRejectedWithError(/integrity hash/);
      expect(managed.installFor(adapter)).toBe(null);
    });

    it("refuses a package the registry publishes no integrity hash for", async () => {
      await servePackage({ "package/server.js": "x" });
      const metadata = JSON.parse(routes[metadataUrl]);
      delete metadata.dist.integrity;
      routes[metadataUrl] = JSON.stringify(metadata);
      register(npmDescriptor());
      await expectAsync(managed.install("ide-test")).toBeRejectedWithError(/no integrity hash/);
    });
  });

  describe("resolution and removal", () => {
    const url =
      "https://github.com/example/testlang/releases/download/v1.2.3/testlang-x86_64.tar.gz";

    const install = async () => {
      const archive = await tarball({ testlang: "#!/bin/sh\n" });
      routes["https://api.github.com/repos/example/testlang/releases/latest"] = JSON.stringify({
        tag_name: "v1.2.3",
      });
      routes[url] = archive;
      routes[`${url}.sha256`] = sha256(archive);
      const adapter = register(githubDescriptor());
      await managed.install("ide-test");
      return adapter;
    };

    it("hands the install to resolveServer through the adapter context", async () => {
      const adapter = await install();
      const context = manager.adapterContext(adapter, scratch);
      expect(context.managedServer.version).toBe("1.2.3");
      expect(context.managedServer.binaryPath).toBe(path.join(storageRoot, "ide-test", "testlang"));
      // The pre-existing field keeps its meaning: where this adapter's files go.
      expect(context.managedStoragePath.endsWith(path.join("language-servers", "ide-test"))).toBe(
        true,
      );
    });

    it("reports no install once it is removed, leaving nothing behind", async () => {
      const adapter = await install();
      await managed.uninstall("ide-test");
      expect(managed.installFor(adapter)).toBe(null);
      expect(fs.existsSync(path.join(storageRoot, "ide-test"))).toBe(false);
      expect(manager.adapterContext(adapter, scratch).managedServer).toBe(null);
    });

    it("ignores a record whose payload has gone missing", async () => {
      const adapter = await install();
      fs.rmSync(path.join(storageRoot, "ide-test", "testlang"), { force: true });
      managed.refresh();
      // Better to fall back to PATH than to launch a path that is not there.
      expect(managed.installFor(adapter)).toBe(null);
    });

    it("refuses to act on an adapter that declares no managed server", () => {
      manager.registerAdapter({
        id: "plain",
        displayName: "Plain",
        grammarScopes: ["source.plain"],
        resolveServer: async () => null,
      });
      expect(() => managed.adapterFor("plain")).toThrowError(/does not declare/);
      expect(managed.adapters()).toEqual([]);
    });

    it("does not reinstall when the newest release is already installed", async () => {
      await install();
      const record = await managed.update("ide-test");
      expect(record.upToDate).toBe(true);
      expect(record.version).toBe("1.2.3");
    });

    it("installs the newer release when there is one", async () => {
      await install();
      const archive = await tarball({ testlang: "newer" });
      const next =
        "https://github.com/example/testlang/releases/download/v1.3.0/testlang-x86_64.tar.gz";
      routes["https://api.github.com/repos/example/testlang/releases/latest"] = JSON.stringify({
        tag_name: "v1.3.0",
      });
      routes[next] = archive;
      routes[`${next}.sha256`] = sha256(archive);

      const record = await managed.update("ide-test");

      expect(record.version).toBe("1.3.0");
      expect(fs.readFileSync(path.join(storageRoot, "ide-test", "testlang"), "utf8")).toBe("newer");
    });
  });

  describe("release lookup", () => {
    it("resolves to null rather than throwing when the lookup fails", async () => {
      const adapter = register(githubDescriptor());
      routes["https://api.github.com/repos/example/testlang/releases/latest"] = () => missing(403);
      expect(await managed.latestVersion(adapter)).toBe(null);
    });

    it("caches a lookup so opening the list twice costs one request", async () => {
      const adapter = register(githubDescriptor());
      routes["https://api.github.com/repos/example/testlang/releases/latest"] = JSON.stringify({
        tag_name: "v1.2.3",
      });
      await managed.latestVersion(adapter);
      await managed.latestVersion(adapter);
      expect(requested.length).toBe(1);
    });

    it("describes an adapter that has never been looked up or installed", () => {
      const adapter = register(githubDescriptor());
      expect(managed.describe(adapter)).toEqual(
        jasmine.objectContaining({
          displayName: "Testlang",
          installed: null,
          available: null,
          updatable: false,
          hasFallback: false,
        }),
      );
    });

    it("marks an adapter whose package ships the server as having a fallback", () => {
      const adapter = register(npmDescriptor({ bundled: true }));
      expect(managed.describe(adapter).hasFallback).toBe(true);
    });
  });

  describe("staging leftovers", () => {
    it("sweeps stage and backup directories from an interrupted install", async () => {
      fs.mkdirSync(path.join(storageRoot, ".stage-ide-test-1-1"), { recursive: true });
      fs.mkdirSync(path.join(storageRoot, ".backup-ide-test-1-1"), { recursive: true });
      fs.mkdirSync(path.join(storageRoot, "ide-test"), { recursive: true });

      await managed.sweep();

      expect(fs.readdirSync(storageRoot)).toEqual(["ide-test"]);
    });

    it("is a no-op when nothing has ever been installed", async () => {
      await expectAsync(managed.sweep()).toBeResolved();
    });
  });

  describe("zip extraction", () => {
    // Only bsdtar reads zip. Windows ships it in System32 and macOS is /usr/bin/tar;
    // Linux has GNU tar, which cannot, and every Linux release asset is a tarball.
    const tarBinary = bsdtarPath();
    const available = tarBinary && fs.existsSync(tarBinary);

    it("refuses, rather than fails obscurely, where bsdtar is absent", async () => {
      // Driven through the export instead of the host platform, so the refusal
      // is covered on all three rather than only wherever CI happens to lack it.
      spyOn(ManagedServers, "bsdtarPath").and.returnValue(null);
      const destination = fs.mkdtempSync(path.join(scratch, "unzip-"));
      await expectAsync(
        managed.extract(path.join(scratch, "x.zip"), destination, "x.zip"),
      ).toBeRejectedWithError(/cannot be extracted/);
    });

    it("rejects an archive kind it does not handle", async () => {
      // Every outcome of extract() is a rejection, never a synchronous throw.
      const destination = fs.mkdtempSync(path.join(scratch, "unknown-"));
      await expectAsync(
        managed.extract(path.join(scratch, "x.rar"), destination, "x.rar"),
      ).toBeRejectedWithError(/Unsupported archive/);
    });

    const itWithBsdtar = available ? it : () => {};

    itWithBsdtar("extracts a zip with bsdtar", async () => {
      const destination = fs.mkdtempSync(path.join(scratch, "unzip-"));
      const source = fs.mkdtempSync(path.join(scratch, "zip-src-"));
      fs.writeFileSync(path.join(source, "testlang"), "zipped");
      const archive = path.join(scratch, "testlang.zip");
      await new Promise((resolve, reject) =>
        require("child_process").execFile(
          tarBinary,
          ["-a", "-cf", archive, "-C", source, "testlang"],
          (error) => (error ? reject(error) : resolve()),
        ),
      );

      await managed.extract(archive, destination, "testlang.zip");

      expect(fs.readFileSync(path.join(destination, "testlang"), "utf8")).toBe("zipped");
    });
  });
});
