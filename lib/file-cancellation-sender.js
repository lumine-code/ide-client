const fs = require("fs");
const path = require("path");

// A vscode-jsonrpc CancellationSenderStrategy backed by marker files. Some
// language servers use this channel to share cancellation with worker threads.
module.exports = class FileCancellationSender {
  constructor(folder) {
    if (!path.isAbsolute(folder)) throw new Error("File cancellation folder must be absolute");
    this.folder = folder;
    this.disposed = false;
    fs.mkdirSync(folder, { recursive: true });
  }
  file(id) {
    return path.join(this.folder, `cancellation-${String(id)}.tmp`);
  }
  sendCancellation(_connection, id) {
    try {
      fs.writeFileSync(this.file(id), "", { flag: "w" });
    } catch {
      // Cancellation is advisory. The request can still complete normally if
      // the marker cannot be written, so do not turn abort into a process fault.
    }
    return Promise.resolve();
  }
  cleanup(id) {
    try {
      fs.unlinkSync(this.file(id));
    } catch {
      // A server or an earlier cleanup may already have removed the marker.
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // The directory is unique to this connection. It should contain only
    // cancellation marker files, but refuse to recurse if anything else has
    // appeared there so cleanup can never follow an unexpected directory.
    try {
      for (const name of fs.readdirSync(this.folder)) {
        const item = path.join(this.folder, name);
        const stat = fs.lstatSync(item);
        if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(item);
      }
      fs.rmdirSync(this.folder);
    } catch {
      // Best-effort teardown, matching cancellation's advisory semantics.
    }
  }
};
