const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

// Language servers the editor installs and keeps up to date on the user's
// behalf, so a missing server is a command rather than a trip to a shell.
//
// An adapter opts in by declaring `managedServer` (see docs/ide-client.md). Two
// kinds of source are understood:
//
//   github-release — a per-platform archive or executable attached to a GitHub
//     release. This is how native servers with no npm distribution are fetched.
//   npm — a package from the registry. Adapters whose server already ships as
//     an npm dependency use this as an *upgrade tier* only: the pinned copy
//     stays the floor, so uninstalling can never leave the user with nothing.
//
// Everything lands in <configDir>/language-servers/<adapter.id>/, one directory
// per adapter whatever the source, which is what keeps `installFor` and
// `uninstall` down to a single path each.

// A release lookup is one request per adapter; the answer is stable for far
// longer than a window lives, and the unauthenticated GitHub API allows only 60
// requests an hour per address.
const LATEST_CACHE_MS = 10 * 60 * 1000;

// How deep the staged tree is searched for the declared binary. Release
// archives put it either at the root or one directory down, and which of the
// two is not worth asking every descriptor to predict.
const BINARY_SEARCH_DEPTH = 3;

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Lumine.ide-client",
};

// bsdtar reads zip as well as tar; GNU tar does not. Windows has shipped bsdtar
// in System32 since 1803 and macOS's /usr/bin/tar is bsdtar, but neither may be
// reached as a bare `tar` — a developer machine commonly has GNU tar earlier on
// PATH (Git for Windows installs one), and that build fails on a zip with a
// message about the archive format rather than about itself.
function bsdtarPath() {
  if (process.platform === "win32")
    return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  if (process.platform === "darwin") return "/usr/bin/tar";
  return null;
}

// Ordered comparison of two release versions, newest first when positive.
//
// Deliberately not semver: the only question asked here is "is the release
// newer than what is installed", every source involved tags plain numeric
// versions, and a prerelease simply loses to the release it precedes. That is
// small enough not to be worth a dependency.
function compareVersions(a, b) {
  const parse = (value) => {
    const normalized = String(value ?? "").replace(/^v/, "");
    const calendar = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (calendar) {
      return { parts: calendar.slice(1).map(Number), prerelease: null };
    }
    const separator = normalized.indexOf("-");
    const core = separator === -1 ? normalized : normalized.slice(0, separator);
    const prerelease = separator === -1 ? null : normalized.slice(separator + 1);
    return {
      parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      prerelease,
    };
  };
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference) return difference;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

// The hex digest a `.sha256` sidecar states. Both shapes published in the wild
// are accepted: a bare digest, and the `<digest>  <filename>` that sha256sum
// writes.
function parseSidecar(text) {
  const match = String(text || "").match(/\b([0-9a-f]{64})\b/i);
  return match ? match[1].toLowerCase() : null;
}

module.exports = class ManagedServers {
  constructor(manager, options = {}) {
    this.manager = manager;
    // Injected by the specs so nothing in the suite reaches the network.
    this.fetchUrl =
      options.fetchUrl || ((url, init) => fetch(url, { redirect: "follow", ...init }));
    this.storageRoot =
      options.storageRoot || path.join(lumine.getConfigDirPath(), "language-servers");
    // adapter.id -> install record, or null for "looked and found nothing".
    this.installs = new Map();
    // adapter.id -> { version, fetchedAt, … } from the last release lookup.
    this.latest = new Map();
    this.counter = 0;
  }

  // Every registered adapter that declares a managed source.
  adapters() {
    return [...this.manager.adapters.values()].filter((adapter) => adapter.managedServer);
  }

  adapterFor(adapterId) {
    const adapter = this.manager.adapters.get(adapterId);
    if (!adapter?.managedServer)
      throw new Error(`'${adapterId}' does not declare a managed language server`);
    return adapter;
  }

  directoryFor(adapter) {
    return path.join(this.storageRoot, adapter.id);
  }

  recordPath(adapter) {
    return path.join(this.directoryFor(adapter), "install.json");
  }

  // The installed copy, as `resolveServer` wants it, or null when there is
  // none. Synchronous because `adapterContext` is, and cached because it is
  // consulted on every attach — `refresh()` drops the cache, and every mutation
  // here does that for the adapter it touched.
  installFor(adapter) {
    if (!adapter?.managedServer) return null;
    if (this.installs.has(adapter.id)) return this.installs.get(adapter.id);

    let record;
    try {
      record = JSON.parse(fs.readFileSync(this.recordPath(adapter), "utf8"));
    } catch {
      // Not installed, or a record left half-written by a killed process.
      this.installs.set(adapter.id, null);
      return null;
    }

    const directory = this.directoryFor(adapter);
    const resolved = {
      version: record.version,
      source: record.source,
      installedAt: record.installedAt,
      binaryPath: record.binary ? path.join(directory, record.binary) : null,
      modulePath: record.module ? path.join(directory, record.module) : null,
      directory,
    };
    // A record naming a payload that is not there is worse than no record: the
    // adapter would launch a path that does not exist instead of falling back.
    const payload = resolved.binaryPath || resolved.modulePath;
    if (payload && !fs.existsSync(payload)) {
      this.installs.set(adapter.id, null);
      return null;
    }
    this.installs.set(adapter.id, resolved);
    return resolved;
  }

  refresh(adapter) {
    if (adapter) this.installs.delete(adapter.id);
    else this.installs.clear();
  }

  // What the manage-servers list shows for one adapter. `available` is only
  // filled in once a lookup has run, so opening the list costs no requests.
  describe(adapter) {
    const installed = this.installFor(adapter);
    const latest = this.latest.get(adapter.id);
    return {
      adapter,
      displayName: adapter.managedServer.displayName || adapter.displayName,
      source: adapter.managedServer.source,
      // An adapter whose server also ships with the package is never "missing":
      // uninstalling only drops back to the copy the package brought.
      hasFallback: !!adapter.managedServer.bundled,
      installed: installed?.version || null,
      available: latest?.version || null,
      updatable: !!(installed && latest && compareVersions(latest.version, installed.version) > 0),
    };
  }

  // The newest release, cached briefly. Failures resolve to null rather than
  // throwing: a rate limit or an offline machine must not turn opening the list
  // into an error dialog.
  async latestVersion(adapter, { force = false } = {}) {
    const cached = this.latest.get(adapter.id);
    if (!force && cached && Date.now() - cached.fetchedAt < LATEST_CACHE_MS) return cached;
    let found;
    try {
      found =
        adapter.managedServer.source === "npm"
          ? await this.latestFromNpm(adapter)
          : await this.latestFromGithub(adapter);
    } catch {
      return null;
    }
    if (!found) return null;
    const entry = { ...found, fetchedAt: Date.now() };
    this.latest.set(adapter.id, entry);
    return entry;
  }

  async latestFromGithub(adapter) {
    const { repository } = adapter.managedServer;
    const response = await this.fetchUrl(
      `https://api.github.com/repos/${repository}/releases/latest`,
      { headers: GITHUB_HEADERS },
    );
    if (!response.ok) return null;
    const release = await response.json();
    if (!release?.tag_name) return null;
    return { version: String(release.tag_name).replace(/^v/, ""), tag: release.tag_name };
  }

  async latestFromNpm(adapter) {
    const [name] = adapter.managedServer.packages;
    const response = await this.fetchUrl(`https://registry.npmjs.org/${name}/latest`);
    if (!response.ok) return null;
    const metadata = await response.json();
    if (!metadata?.version) return null;
    return { version: metadata.version };
  }

  async install(adapterId, { version } = {}) {
    const adapter = this.adapterFor(adapterId);
    const descriptor = adapter.managedServer;
    const resolved = version
      ? { version, tag: version }
      : await this.latestVersion(adapter, { force: true });
    if (!resolved)
      throw new Error(
        `Could not find out which version of ${descriptor.displayName || adapter.displayName} to install. Check the network connection and try again.`,
      );

    await fs.promises.mkdir(this.storageRoot, { recursive: true });
    this.counter += 1;
    const stage = path.join(
      this.storageRoot,
      `.stage-${adapter.id}-${process.pid}-${this.counter}`,
    );
    await fs.promises.mkdir(stage, { recursive: true });

    let record;
    try {
      record =
        descriptor.source === "npm"
          ? await this.stageNpm(adapter, stage, resolved)
          : await this.stageGithubRelease(adapter, stage, resolved);
      await fs.promises.writeFile(
        path.join(stage, "install.json"),
        `${JSON.stringify(record, null, 2)}\n`,
      );
    } catch (error) {
      await this.remove(stage);
      throw error;
    }

    await this.swap(adapter, stage);
    return record;
  }

  async update(adapterId) {
    const adapter = this.adapterFor(adapterId);
    const latest = await this.latestVersion(adapter, { force: true });
    const installed = this.installFor(adapter);
    if (latest && installed && compareVersions(latest.version, installed.version) <= 0)
      return { upToDate: true, version: installed.version };
    return this.install(adapterId);
  }

  // Removes only what this class installed. A binary the user put on PATH, and
  // a server the adapter package ships as a dependency, are untouched — which
  // is why uninstalling is safe to offer at all.
  async uninstall(adapterId) {
    const adapter = this.adapterFor(adapterId);
    await this.stopSessions(adapter);
    await this.remove(this.directoryFor(adapter));
    this.refresh(adapter);
    await this.manager.reattachAll();
  }

  // ---- staging -------------------------------------------------------------

  async stageGithubRelease(adapter, stage, resolved) {
    const descriptor = adapter.managedServer;
    const asset = descriptor.assetFor({
      platform: process.platform,
      arch: process.arch,
      version: resolved.version,
    });
    if (!asset)
      throw new Error(
        `${descriptor.displayName || adapter.displayName} publishes no build for ${process.platform}-${process.arch}.`,
      );

    const tag = resolved.tag || resolved.version;
    const url = `https://github.com/${descriptor.repository}/releases/download/${tag}/${asset}`;
    const payload = await this.download(url, `${descriptor.displayName} ${resolved.version}`);
    await this.verify(payload, url, descriptor.checksum);

    if (descriptor.assetType === "binary") {
      const binary = descriptor.binary;
      const binaryPath = path.join(stage, binary);
      await fs.promises.writeFile(binaryPath, payload);
      if (process.platform !== "win32") await fs.promises.chmod(binaryPath, 0o755);
      return {
        source: "github-release",
        version: resolved.version,
        repository: descriptor.repository,
        asset,
        assetType: "binary",
        checksum: descriptor.checksum,
        binary,
        installedAt: new Date().toISOString(),
      };
    }

    const archivePath = path.join(stage, asset);
    await fs.promises.writeFile(archivePath, payload);
    await this.extract(archivePath, stage, asset, descriptor.strip ?? 0);
    await this.remove(archivePath);

    const binary = this.locateBinary(stage, descriptor.binary);
    if (!binary) throw new Error(`The downloaded archive does not contain '${descriptor.binary}'.`);
    if (process.platform !== "win32") await fs.promises.chmod(path.join(stage, binary), 0o755);

    return {
      source: "github-release",
      version: resolved.version,
      repository: descriptor.repository,
      asset,
      assetType: "archive",
      checksum: descriptor.checksum,
      binary,
      installedAt: new Date().toISOString(),
    };
  }

  async stageNpm(adapter, stage, resolved) {
    const descriptor = adapter.managedServer;
    const modules = path.join(stage, "node_modules");
    await fs.promises.mkdir(modules, { recursive: true });

    for (const name of descriptor.packages) {
      // Every package the descriptor lists is pinned to the version resolved
      // for the first one, so a multi-package server cannot end up half
      // upgraded. Only the leading package decides the version.
      const wanted = name === descriptor.packages[0] ? resolved.version : "latest";
      const response = await this.fetchUrl(`https://registry.npmjs.org/${name}/${wanted}`);
      if (!response.ok)
        throw new Error(`The npm registry answered ${response.status} for ${name}@${wanted}.`);
      const metadata = await response.json();
      const tarball = metadata?.dist?.tarball;
      if (!tarball) throw new Error(`npm published no tarball for ${name}@${wanted}.`);

      const payload = await this.download(tarball, `${name} ${metadata.version}`);
      this.verifyIntegrity(payload, metadata.dist.integrity, name);

      const target = path.join(modules, ...name.split("/"));
      await fs.promises.mkdir(target, { recursive: true });
      const archivePath = path.join(stage, `.${path.basename(name)}.tgz`);
      await fs.promises.writeFile(archivePath, payload);
      // Every npm tarball wraps its files in a single `package/` directory.
      await this.extract(archivePath, target, archivePath, 1);
      await this.remove(archivePath);
    }

    return {
      source: "npm",
      version: resolved.version,
      packages: [...descriptor.packages],
      checksum: "npm-integrity",
      module: descriptor.module,
      installedAt: new Date().toISOString(),
    };
  }

  // ---- transfer ------------------------------------------------------------

  async download(url, label) {
    let response;
    try {
      response = await this.fetchUrl(url);
    } catch (error) {
      throw new Error(`Could not download ${label}: ${error.message}`, { cause: error });
    }
    if (!response.ok)
      throw new Error(`Could not download ${label}: the server answered ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  }

  // `checksum` is stated by the descriptor rather than guessed, so a source
  // that publishes nothing to check against — texlab today — is a visible
  // decision in the adapter instead of a silently skipped step here.
  async verify(payload, url, checksum) {
    if (checksum === "none") return;
    if (checksum !== "sha256-sidecar") throw new Error(`Unknown checksum policy '${checksum}'.`);

    const response = await this.fetchUrl(`${url}.sha256`);
    if (!response.ok)
      throw new Error(`Could not download the checksum: the server answered ${response.status}.`);
    const expected = parseSidecar(await response.text());
    if (!expected) throw new Error("The published checksum could not be read.");
    const actual = crypto.createHash("sha256").update(payload).digest("hex");
    if (actual !== expected)
      throw new Error(
        `The download does not match its published checksum and was discarded.\nexpected ${expected}\nreceived ${actual}`,
      );
  }

  // npm states integrity as SRI — `<algorithm>-<base64>`.
  verifyIntegrity(payload, integrity, name) {
    if (!integrity) throw new Error(`npm published no integrity hash for ${name}.`);
    const [algorithm, expected] = String(integrity).split("-");
    if (!algorithm || !expected) throw new Error(`Unreadable integrity hash for ${name}.`);
    const actual = crypto.createHash(algorithm).update(payload).digest("base64");
    if (actual !== expected)
      throw new Error(`${name} does not match its published integrity hash and was discarded.`);
  }

  // `async` so every outcome is a rejected promise. Refusing an archive kind
  // synchronously while the rest of the method returns one made the contract
  // depend on which branch was taken, which is exactly the sort of thing a
  // caller gets wrong once and then never again.
  async extract(archivePath, destination, archiveName, strip = 0) {
    if (/\.(tar\.gz|tgz)$/i.test(archiveName)) {
      const tar = require("tar");
      return tar.x({
        file: archivePath,
        cwd: destination,
        strip,
        // A package shipping a symlink still extracts on a Windows without
        // developer mode, minus the link.
        onwarn: () => {},
      });
    }
    if (/\.zip$/i.test(archiveName)) return this.extractZip(archivePath, destination, strip);
    throw new Error(`Unsupported archive '${path.basename(archiveName)}'.`);
  }

  async extractZip(archivePath, destination, strip) {
    // Through the export so a spec can decide what is available rather than
    // asserting whatever the machine it runs on happens to have.
    const tarBinary = module.exports.bsdtarPath();
    if (!tarBinary)
      throw new Error(
        `Zip archives cannot be extracted on ${process.platform}. Install the server manually, or set its path in the package settings.`,
      );
    const args = ["-xf", archivePath, "-C", destination];
    if (strip) args.push(`--strip-components=${strip}`);
    return new Promise((resolve, reject) => {
      execFile(tarBinary, args, (error) =>
        error
          ? reject(new Error(`Could not extract the archive: ${error.message}`, { cause: error }))
          : resolve(),
      );
    });
  }

  // The declared binary's path relative to `root`. Release archives put it
  // either at the top level or inside one directory named after the build, and
  // searching costs less than asking every descriptor to know which.
  locateBinary(root, name, depth = BINARY_SEARCH_DEPTH) {
    if (!name) return null;
    const walk = (directory, relative, remaining) => {
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const entry of entries)
        if (entry.isFile() && entry.name === name) return path.join(relative, entry.name);
      if (remaining <= 1) return null;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = walk(
          path.join(directory, entry.name),
          path.join(relative, entry.name),
          remaining - 1,
        );
        if (found) return found;
      }
      return null;
    };
    return walk(root, "", depth);
  }

  // ---- swapping ------------------------------------------------------------

  // Windows refuses to replace a running executable, so the adapter's sessions
  // stop before the directory moves and start again after it.
  async swap(adapter, stage) {
    const target = this.directoryFor(adapter);
    const backup = path.join(
      this.storageRoot,
      `.backup-${adapter.id}-${process.pid}-${this.counter}`,
    );
    await this.stopSessions(adapter);

    let movedAside = false;
    let swapped = false;
    try {
      if (fs.existsSync(target)) {
        await fs.promises.rename(target, backup);
        movedAside = true;
      }
      await fs.promises.rename(stage, target);
      swapped = true;
    } finally {
      if (swapped) {
        // Only now is the previous install genuinely superseded.
        if (movedAside) await this.remove(backup).catch(() => {});
      } else {
        await this.remove(stage).catch(() => {});
        // Put the previous install back. The backup is left alone if that
        // fails — a directory the user can still be pointed at beats deleting
        // the only copy of a working server.
        if (movedAside && !fs.existsSync(target))
          await fs.promises.rename(backup, target).catch(() => {});
      }
      this.refresh(adapter);
      await this.manager.reattachAll();
    }
  }

  async stopSessions(adapter) {
    const owned = this.manager.allSessions().filter((session) => session.adapter === adapter);
    await Promise.all(owned.map((session) => this.manager.disconnect(session).catch(() => {})));
  }

  // A managed install holds no symlinks, so this only ever meets real files and
  // directories. The retries are for Windows, which can hold a handle open
  // briefly after the process using it exits.
  remove(target) {
    return fs.promises.rm(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }

  // Deletes the staging and backup directories an interrupted install left
  // behind. Safe at any time: both names carry the pid that made them and are
  // only ever reachable through this class.
  async sweep() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.storageRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!/^\.(stage|backup)-/.test(entry.name)) continue;
      await this.remove(path.join(this.storageRoot, entry.name)).catch(() => {});
    }
  }
};

module.exports.compareVersions = compareVersions;
module.exports.parseSidecar = parseSidecar;
module.exports.bsdtarPath = bsdtarPath;
