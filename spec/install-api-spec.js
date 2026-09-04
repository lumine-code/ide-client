const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const tar = require("tar");
const LanguageServerManager = require("../lib/language-server-manager");
const ManagedServers = require("../lib/managed-servers");
const InstallApi = require("../lib/install-api");

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

// The primitives an adapter uses to fetch its own server, and the hook that
// hands them over. Zed's model: the host supplies the capabilities, the adapter
// decides what to do with them, and both paths report the same way.
describe("InstallApi", () => {
  let manager, managed, scratch, storageRoot, routes, api, adapter;

  const tarball = async (files) => {
    const source = fs.mkdtempSync(path.join(scratch, "src-"));
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(source, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    const archive = path.join(scratch, `a-${Object.keys(routes).length}.tar.gz`);
    await tar.c({ file: archive, cwd: source, gzip: true }, fs.readdirSync(source));
    const buffer = fs.readFileSync(archive);
    fs.rmSync(archive, { force: true });
    return buffer;
  };

  beforeEach(() => {
    manager = new LanguageServerManager();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "install-api-"));
    storageRoot = path.join(scratch, "language-servers");
    routes = {};
    managed = new ManagedServers(manager, {
      storageRoot,
      fetchUrl: async (url) => {
        const route = routes[url];
        if (route === undefined) return missing();
        return typeof route === "function" ? route() : respond(route);
      },
    });
    manager.setManagedServers(managed);
    adapter = {
      id: "ide-custom",
      displayName: "Custom Server",
      grammarScopes: ["source.custom"],
      resolveServer: async () => null,
    };
    api = managed.apiFor(adapter);
  });

  afterEach(async () => {
    await manager.deactivate();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("release discovery", () => {
    it("flattens a GitHub release to its version, tag and assets", async () => {
      routes["https://api.github.com/repos/example/tool/releases/latest"] = JSON.stringify({
        tag_name: "v2.1.0",
        assets: [
          {
            name: "tool-linux",
            browser_download_url: "https://x/tool-linux",
            size: 12,
            digest: `sha256:${"a".repeat(64)}`,
          },
        ],
      });
      const release = await api.latestGithubRelease("example/tool");
      expect(release.version).toBe("2.1.0");
      expect(release.tag).toBe("v2.1.0");
      expect(release.assets).toEqual([
        {
          name: "tool-linux",
          url: "https://x/tool-linux",
          size: 12,
          digest: `sha256:${"a".repeat(64)}`,
        },
      ]);
    });

    it("fetches a release by tag", async () => {
      routes["https://api.github.com/repos/example/tool/releases/tags/v1.0.0"] = JSON.stringify({
        tag_name: "v1.0.0",
        assets: [],
      });
      expect((await api.githubReleaseByTag("example/tool", "v1.0.0")).version).toBe("1.0.0");
    });

    it("throws with the status rather than resolving to nothing", async () => {
      // An adapter calling this is mid-install; a silent null would surface far
      // from the cause.
      await expectAsync(api.latestGithubRelease("example/tool")).toBeRejectedWithError(/404/);
    });

    it("reads the installed npm version, and null when there is none", async () => {
      const directory = path.join(scratch, "inst");
      const manifest = path.join(directory, "node_modules", "thing", "package.json");
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, JSON.stringify({ version: "3.2.1" }));
      expect(api.npmPackageInstalledVersion("thing", directory)).toBe("3.2.1");
      expect(api.npmPackageInstalledVersion("absent", directory)).toBe(null);
    });
  });

  describe("downloadFile", () => {
    it("writes an uncompressed payload straight to the path", async () => {
      routes["https://x/tool"] = "#!/bin/sh\n";
      const target = path.join(scratch, "out", "tool");
      await api.downloadFile("https://x/tool", target);
      expect(fs.readFileSync(target, "utf8")).toBe("#!/bin/sh\n");
    });

    it("unpacks a gzip-tar into the destination directory", async () => {
      const payload = await tarball({ "tool/tool": "payload" });
      routes["https://x/tool.tar.gz"] = payload;
      const target = path.join(scratch, "unpacked");
      const digest = `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
      await api.downloadFile("https://x/tool.tar.gz", target, { type: "gzip-tar", digest });
      expect(fs.readFileSync(path.join(target, "tool", "tool"), "utf8")).toBe("payload");
      // The archive itself is not left in the install.
      expect(fs.readdirSync(target)).toEqual(["tool"]);
    });

    it("rejects a download before writing or extracting a checksum mismatch", async () => {
      routes["https://x/wrong.tar.gz"] = await tarball({ "tool/tool": "payload" });
      const target = path.join(scratch, "wrong");
      await expectAsync(
        api.downloadFile("https://x/wrong.tar.gz", target, {
          type: "gzip-tar",
          digest: `sha256:${"0".repeat(64)}`,
        }),
      ).toBeRejectedWithError(/published checksum/);
      expect(fs.existsSync(target)).toBe(false);
    });

    it("verifies a file that an adapter already downloaded", async () => {
      const target = path.join(scratch, "tool");
      fs.writeFileSync(target, "payload");
      const digest = `sha256:${crypto.createHash("sha256").update("payload").digest("hex")}`;
      await expectAsync(api.verifyFileChecksum(target, digest)).toBeResolved();
      await expectAsync(
        api.verifyFileChecksum(target, `sha256:${"0".repeat(64)}`),
      ).toBeRejectedWithError(/published checksum/);
    });

    it("refuses a type it does not know", async () => {
      routes["https://x/tool"] = "x";
      await expectAsync(
        api.downloadFile("https://x/tool", path.join(scratch, "d"), { type: "rar" }),
      ).toBeRejectedWithError(/Unknown download type/);
    });
  });

  describe("npmInstallPackage", () => {
    it("refuses a package name or version that is not one", async () => {
      // These reach a shell on Windows, so they are checked rather than trusted.
      await expectAsync(
        api.npmInstallPackage("evil; rm -rf /", "1.0.0", scratch),
      ).toBeRejectedWithError(/odd package name/);
      await expectAsync(
        api.npmInstallPackage("thing", "1.0.0 && whoami", scratch),
      ).toBeRejectedWithError(/odd version range/);
    });

    it("spawns a Windows .cmd through a shell, and an exe directly", () => {
      // Node >= 18.20 rejects a .cmd spawned without one (CVE-2024-27980).
      expect(InstallApi.npmSpawnOptions("npm.cmd", { cwd: "x" }).shell).toBe(
        process.platform === "win32" ? true : undefined,
      );
      expect(InstallApi.npmSpawnOptions("npm", { cwd: "x" }).shell).toBeUndefined();
    });
  });

  describe("installation status", () => {
    it("reports through the adapter it was built for", () => {
      const seen = [];
      managed.onDidChangeInstallation((event) => seen.push(event));
      api.setServerInstallationStatus("downloading");
      expect(managed.installationStatus("ide-custom")).toBe("downloading");
      api.setServerInstallationStatus(null);
      expect(managed.installationStatus("ide-custom")).toBe(null);
      expect(seen).toEqual([
        { adapterId: "ide-custom", status: "downloading" },
        { adapterId: "ide-custom", status: null },
      ]);
    });
  });

  describe("the installServer hook", () => {
    const withHook = (installServer, extra = {}) => {
      const hooked = { ...adapter, installServer, ...extra };
      manager.registerAdapter(hooked);
      return hooked;
    };

    it("stages, swaps and records exactly as a descriptor install does", async () => {
      const hooked = withHook(async ({ storagePath, api: given }) => {
        await given.downloadFile("https://x/custom", path.join(storagePath, "custom"));
        await given.makeFileExecutable(path.join(storagePath, "custom"));
        return { version: "9.9.9", binary: "custom" };
      });
      routes["https://x/custom"] = "#!/bin/sh\n";

      const record = await managed.install("ide-custom");

      expect(record.source).toBe("adapter");
      expect(record.version).toBe("9.9.9");
      const install = managed.installFor(hooked);
      expect(install.version).toBe("9.9.9");
      expect(fs.readFileSync(install.binaryPath, "utf8")).toBe("#!/bin/sh\n");
      // The same record file, in the same place, as every other install.
      expect(fs.existsSync(path.join(storageRoot, "ide-custom", "install.json"))).toBe(true);
    });

    it("hands the install to resolveServer through the adapter context", async () => {
      const hooked = withHook(async ({ storagePath }) => {
        fs.writeFileSync(path.join(storagePath, "custom"), "x");
        return { version: "1.0.0", binary: "custom" };
      });
      await managed.install("ide-custom");
      expect(manager.adapterContext(hooked, scratch).managedServer.version).toBe("1.0.0");
    });

    it("refuses a hook that does not say what to launch", async () => {
      withHook(async () => ({ version: "1.0.0" }));
      await expectAsync(managed.install("ide-custom")).toBeRejectedWithError(
        /did not say which file/,
      );
      expect(fs.existsSync(path.join(storageRoot, "ide-custom"))).toBe(false);
    });

    it("allows a bundled server adapter to install only companion tools", async () => {
      const hooked = withHook(
        async ({ storagePath }) => {
          fs.writeFileSync(path.join(storagePath, "tool"), "tool");
          return { version: "1.0.0" };
        },
        { bundledServer: true, managedServerDisplayName: "Custom Toolchain" },
      );

      await managed.install("ide-custom");

      const install = managed.installFor(hooked);
      expect(install.binaryPath).toBe(null);
      expect(install.modulePath).toBe(null);
      expect(fs.readFileSync(path.join(install.directory, "tool"), "utf8")).toBe("tool");
      expect(managed.describe(hooked).displayName).toBe("Custom Toolchain");
      expect(managed.describe(hooked).hasFallback).toBe(true);
    });

    it("reports failure and leaves nothing behind when the hook throws", async () => {
      withHook(async () => {
        throw new Error("upstream is down");
      });
      const seen = [];
      managed.onDidChangeInstallation(({ status }) => seen.push(status));

      await expectAsync(managed.install("ide-custom")).toBeRejectedWithError(/upstream is down/);

      expect(seen.at(-1)).toBe("failed");
      expect(fs.existsSync(path.join(storageRoot, "ide-custom"))).toBe(false);
      expect(fs.readdirSync(storageRoot).filter((n) => n.startsWith(".stage-"))).toEqual([]);
    });

    it("walks one status vocabulary whichever way the server is acquired", async () => {
      withHook(async ({ storagePath }) => {
        fs.writeFileSync(path.join(storagePath, "custom"), "x");
        return { version: "1.0.0", binary: "custom" };
      });
      const seen = [];
      managed.onDidChangeInstallation(({ status }) => seen.push(status));
      await managed.install("ide-custom");
      expect(seen).toEqual(["checking", "downloading", "installing", null]);
    });

    it("lists a hook-based adapter beside the descriptor ones", async () => {
      const hooked = withHook(async () => ({ version: "1", binary: "x" }));
      expect(managed.adapters()).toContain(hooked);
      expect(managed.describe(hooked)).toEqual(
        jasmine.objectContaining({ displayName: "Custom Server", source: "adapter" }),
      );
    });

    it("takes the version an adapter reports for the list", async () => {
      const hooked = withHook(async () => ({ version: "4.5.6", binary: "x" }), {
        latestServerVersion: async () => "4.5.6",
      });
      expect((await managed.latestVersion(hooked, { force: true })).version).toBe("4.5.6");
    });
  });

  describe("registration", () => {
    it("rejects an adapter that declares a descriptor and a hook", () => {
      expect(() =>
        manager.registerAdapter({
          ...adapter,
          installServer: async () => ({}),
          managedServer: {
            source: "github-release",
            repository: "example/tool",
            assetFor: () => "tool",
            checksum: "none",
            binary: "tool",
          },
        }),
      ).toThrowError(/managedServer with installServer/);
    });
  });
});
