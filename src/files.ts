import { constants } from "node:fs";
import { access, lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

// O_NOFOLLOW is not defined on every platform; 0 simply means "no extra flag".
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Local paths come from the AI client and can be influenced by site content, so nothing in a
 * hidden folder (.ssh, .aws, .config and similar) is ever read or written. A segment is hidden when
 * it starts with ".". This is checked on the path as written and again on the resolved path, so a
 * symlink cannot lead into a hidden place.
 */
export function assertNotHidden(label: string, path: string, resolvedFrom?: string): void {
  const segments = path.split(/[\\/]/);
  // ".." is not a hidden name. Say what is wrong instead of blaming a hidden folder.
  if (segments.includes("..")) {
    throw new Error(`${label} must not contain ".." segments; give the full path without them: ${path}`);
  }
  if (segments.some((segment) => segment.startsWith(".") && segment.length > 1)) {
    const origin = resolvedFrom ? ` (${resolvedFrom} resolves to ${path})` : `: ${path}`;
    throw new Error(
      `${label} must not point into a hidden file or folder (a path segment starting with ".")${origin}`
    );
  }
}

function describe(error: unknown): string {
  const failure = error as NodeJS.ErrnoException;
  return failure?.code ?? failure?.message ?? String(error);
}

/**
 * Reads a local file for an upload.
 *
 * The path must be absolute and, once every symlink is resolved, free of hidden segments. The
 * resolved file is opened without following a final symlink and must be the same regular file that
 * was validated, so a file swapped in between the check and the read is refused. A local process
 * that can rewrite directories while a call is running is outside what this can defend against.
 */
export async function readUploadFile(
  label: string,
  path: string
): Promise<{ buffer: Buffer; name: string }> {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path: ${path}`);
  }
  assertNotHidden(label, path);

  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    throw new Error(`${label} cannot be read (${describe(error)}): ${path}`);
  }
  assertNotHidden(label, resolved, path);

  const expected = await stat(resolved);
  if (!expected.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }

  const handle = await open(resolved, constants.O_RDONLY | NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error(`${label} changed while it was being opened: ${path}`);
    }
    return { buffer: await handle.readFile(), name: basename(path) };
  } finally {
    await handle.close();
  }
}

export interface Reservation {
  /** Writes the response into the reserved file and closes it. */
  write(buffer: Buffer): Promise<void>;
  /** Removes the reserved file if this call created it. Safe to call more than once. */
  discard(): Promise<void>;
}

/**
 * Reserves a new file for a download before the request is sent.
 *
 * The parent directory must exist, be a directory, be writable, and, once resolved, contain no
 * hidden segment. The file itself is created exclusively (never following a symlink, owner-only
 * permissions), so an existing file, a symlink or a concurrent call makes this fail instead of
 * overwriting anything. Every check happens before the request, so a bad path never leaves a
 * half-done change in Ghost.
 */
export async function reserveDownload(saveTo: string): Promise<Reservation> {
  if (!isAbsolute(saveTo)) {
    throw new Error(`save_to must be an absolute path: ${saveTo}`);
  }
  // Checked on the spelling as given: basename() and join() below would silently drop a trailing
  // separator, create a file the caller did not name, and report a path that cannot be opened.
  if (/[\\/]$/.test(saveTo)) {
    throw new Error(`save_to must name a file, not a folder: remove the trailing separator from ${saveTo}`);
  }
  if (/[\u0000-\u001f]/.test(saveTo)) {
    throw new Error("save_to must not contain control characters.");
  }
  assertNotHidden("save_to", saveTo);
  const name = basename(saveTo);
  if (name === "" || name === "." || name === "..") {
    throw new Error(`save_to must end with a file name: ${saveTo}`);
  }

  const parent = dirname(saveTo);
  let resolvedParent: string;
  try {
    resolvedParent = await realpath(parent);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(`save_to directory does not exist: ${parent}`);
    }
    if (code === "ENOTDIR") {
      throw new Error(`save_to parent is not a directory: ${parent}`);
    }
    throw new Error(`save_to directory cannot be used (${describe(error)}): ${parent}`);
  }
  assertNotHidden("save_to", resolvedParent, parent);

  if (!(await stat(resolvedParent)).isDirectory()) {
    throw new Error(`save_to parent is not a directory: ${parent}`);
  }
  try {
    await access(resolvedParent, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`save_to directory is not writable: ${parent}`);
  }

  const target = join(resolvedParent, name);
  let handle;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST" || code === "ELOOP") {
      throw new Error(`save_to already exists, choose a new file name: ${saveTo}`);
    }
    throw new Error(`save_to cannot be created (${describe(error)}): ${saveTo}`);
  }

  const created = await handle.stat();
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close().catch(() => undefined);
    }
  };

  return {
    async write(buffer) {
      try {
        await handle.writeFile(buffer);
      } finally {
        await close();
      }
    },
    async discard() {
      await close();
      try {
        const current = await lstat(target);
        // Only remove the file this call created, never a different file that took its place.
        if (current.ino === created.ino && current.dev === created.dev) {
          await unlink(target);
        }
      } catch {
        // already gone
      }
    },
  };
}
