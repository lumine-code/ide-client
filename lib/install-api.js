const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// The capabilities an adapter needs to fetch its own server.
//
// Modelled on `zed_extension_api`, whose names these mirror, and for the same
// reason: a descriptor can only describe the shapes it was designed for, and an
// adapter whose server does not fit one — several binaries, a dependency tree,
// a release layout nobody anticipated — would otherwise have no way in at all.
//
// The declarative `managedServer` descriptor stays the default and is written
// in terms of these same calls, so the two paths cannot drift: whatever an
// adapter does here, it stages, swaps and reports exactly as the built-in path
// does.
//
// One deliberate difference from Zed: the descriptor path verifies every
// download against the checksum its source publishes, and `downloadFile` cannot
// force that on a caller. An adapter reaching for it owns its own verification.

// npm is spelled differently on Windows, and the shim has a trap. A `.cmd` must
// be spawned through a shell or Node >= 18.20 refuses it outright with EINVAL
// (CVE-2024-27980). The editor's own package installer carries the same two
// lines; a package cannot require them out of `src/`, so they live here too.
const npmCommand = () => (process.platform === "win32" ? "npm.cmd" : "npm");
const npmSpawnOptions = (command, options) =>
  process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
    ? { ...options, shell: true }
    : options;

// A package name and version reach a shell on Windows because of the above, so
// they are checked rather than trusted. They come from a descriptor rather than
// from the user, which makes this cheap insurance and not a real threat model.
const SAFE_PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const SAFE_VERSION = /^[a-zA-Z0-9.\-+~^<>=| ]+$/;

module.exports = class InstallApi {
  constructor(managed, adapter) {
    this.managed = managed;
    this.adapter = adapter;
  }

  // ---- release discovery ---------------------------------------------------

  // The newest release of a GitHub repository. Throws rather than resolving to
  // null: an adapter calling this is mid-install and wants to know why.
  async latestGithubRelease(repository, { preRelease = false } = {}) {
    const release = preRelease
      ? (await this.managed.githubReleases(repository)).find(Boolean)
      : await this.managed.githubRelease(repository, "latest");
    return this.managed.toRelease(release, repository);
  }

  async githubReleaseByTag(repository, tag) {
    return this.managed.toRelease(
      await this.managed.githubRelease(repository, `tags/${tag}`),
      repository,
    );
  }

  npmPackageLatestVersion(name) {
    return this.managed.npmMetadata(name, "latest").then((metadata) => metadata.version);
  }

  // The version already sitting in `directory`, or null. An adapter uses this
  // to skip work it has already done.
  npmPackageInstalledVersion(name, directory) {
    try {
      const manifest = path.join(directory, "node_modules", ...name.split("/"), "package.json");
      return JSON.parse(fs.readFileSync(manifest, "utf8")).version || null;
    } catch {
      return null;
    }
  }

  // ---- transfer ------------------------------------------------------------

  // Installs a package and everything it needs into `directory`.
  //
  // Development dependencies are skipped and install scripts are refused: every
  // server reached this way is plain JavaScript, and a postinstall is a build
  // step this has no business running. A server that genuinely needs one fails
  // loudly at launch rather than installing something subtly wrong.
  async npmInstallPackage(name, version, directory) {
    if (!SAFE_PACKAGE.test(name))
      throw new Error(`Refusing to install an odd package name: ${name}`);
    if (version && !SAFE_VERSION.test(String(version)))
      throw new Error(`Refusing to install an odd version range: ${version}`);
    await fs.promises.mkdir(directory, { recursive: true });
    // npm refuses to treat a directory as a project without one, and writes the
    // tree beside it rather than walking up to somewhere it does not own.
    const manifest = path.join(directory, "package.json");
    if (!fs.existsSync(manifest))
      await fs.promises.writeFile(manifest, `${JSON.stringify({ private: true }, null, 2)}\n`);

    const command = npmCommand();
    const specifier = version ? `${name}@${version}` : name;
    await new Promise((resolve, reject) => {
      execFile(
        command,
        ["install", specifier, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        npmSpawnOptions(command, { cwd: directory }),
        (error, stdout, stderr) => {
          if (!error) return resolve();
          const detail = String(stderr || stdout || error.message).trim();
          reject(
            error.code === "ENOENT"
              ? new Error(
                  `Could not find \`${command}\` on your PATH, which is needed to install ${name}.`,
                )
              : new Error(`npm could not install ${specifier}:\n${detail}`),
          );
        },
      );
    });
  }

  // Fetches a URL to `destination`, unpacking it when `type` says to. The types
  // mirror Zed's `DownloadedFileType` so an adapter ported from there reads the
  // same.
  async downloadFile(url, destination, { type = "uncompressed", digest } = {}) {
    const payload = await this.managed.download(url, path.basename(destination));
    if (digest) this.managed.verifyDigest(payload, digest, path.basename(destination));
    if (type === "uncompressed") {
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, payload);
      return destination;
    }
    // Everything else lands in a directory, so `destination` names one.
    await fs.promises.mkdir(destination, { recursive: true });
    const suffix = { gzip: ".gz", "gzip-tar": ".tar.gz", zip: ".zip" }[type];
    if (!suffix) throw new Error(`Unknown download type '${type}'.`);
    const archive = path.join(destination, `.download${suffix}`);
    await fs.promises.writeFile(archive, payload);
    try {
      await this.managed.extract(archive, destination, archive);
    } finally {
      await this.managed.remove(archive).catch(() => {});
    }
    return destination;
  }

  makeFileExecutable(filePath) {
    // Windows decides by extension, so there is nothing to set.
    if (process.platform === "win32") return Promise.resolve();
    return fs.promises.chmod(filePath, 0o755);
  }

  async verifyFileChecksum(filePath, digest) {
    const payload = await fs.promises.readFile(filePath);
    this.managed.verifyDigest(payload, digest, path.basename(filePath));
  }

  // ---- reporting -----------------------------------------------------------

  // What the user is shown while this runs. The whole point of routing every
  // adapter through one vocabulary: whatever an install does underneath, it
  // reports the same way and the list renders it the same way.
  setServerInstallationStatus(status) {
    this.managed.setInstallationStatus(this.adapter.id, status);
  }
};

module.exports.npmCommand = npmCommand;
module.exports.npmSpawnOptions = npmSpawnOptions;
