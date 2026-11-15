// project-file.ts — one file of the project read whole by figma_write, safely: a token file (seed-file.ts) or an image
// (image-file.ts). The path is checked by name first (the caller's `resolve`, write-out.ts assertInsideCwd); then its
// real path, its symbolic links followed, must be inside the real path of the directory the server was started in, and
// that real path is opened without following a final link and without blocking on a pipe, must be a regular file, and
// is read up to a size cap. The threat is a static link (or `..`) leading out of the project; a process that rewrites
// the project directory while it is read is out of scope.
import fs from "node:fs";
import path from "node:path";

/** The file system calls readProjectFile makes: Node's, or a test's (to swap a file between two of them). */
export interface ProjectIo {
  realpath(file: string): string;
  /** opens a file to read without following a final symbolic link (where the platform can) and without blocking on a
   *  pipe; returns its descriptor */
  open(file: string): number;
  fstat(fd: number): fs.Stats;
  stat(file: string): fs.Stats;
  /** reads the open file from its start, at most `max` bytes: null when there are more */
  read(fd: number, max: number): Buffer | null;
  close(fd: number): void;
}
/** The flags a file is opened with: O_NOFOLLOW (a final component swapped for a link after the check is refused) and
 *  O_NONBLOCK (a named pipe is opened without waiting for a writer, then refused as not a file), each where the
 *  platform has it (Windows has neither). */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
export const nodeProjectIo: ProjectIo = {
  realpath: (file) => fs.realpathSync(file),
  open: (file) => fs.openSync(file, OPEN_FLAGS),
  fstat: (fd) => fs.fstatSync(fd),
  stat: (file) => fs.statSync(file),
  read: (fd, max) => {
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let got = 1; got > 0 && n <= max;) { got = fs.readSync(fd, buf, n, buf.length - n, n); n += got; }
    return n > max ? null : buf.subarray(0, n);
  },
  close: (fd) => fs.closeSync(fd),
};

/** Is `p` inside directory `root` (or `root` itself), by path segments? */
export function insideDir(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

/** How a refusal names the file: `noun` ("a token file"), what must be inside the directory (`inside`, "a token file and
 *  every $ref it names"), and what to do when it changed while read (`retry`, "seed again"). */
export interface ProjectFileWords { noun: string; inside: string; retry: string }

/** A file read whole, or why it is not: missing, outside `realRoot` once its links are followed, not a file, more than
 *  `max` bytes. `at` starts every refusal (the op field's path). */
export function readProjectFile(file: string, at: string, realRoot: string, max: number, words: ProjectFileWords, io: ProjectIo = nodeProjectIo): { bytes: Buffer } | { error: string } {
  let real: string;
  try { real = io.realpath(file); } catch { return { error: `${at}: no file at ${file}` }; }
  if (!insideDir(realRoot, real)) {
    return { error: `${at}: ${file} leads, through a symbolic link, to ${real}, outside the directory this server was started in (${realRoot}); ${words.inside} must be inside it` };
  }
  let fd: number;
  try { fd = io.open(real); } catch (e) {
    const code = e instanceof Error && "code" in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code === "ELOOP") return { error: `${at}: ${file} changed while it was read (${real} is now a symbolic link); ${words.retry}` };
    // Windows opens no directory: say what is there. Nothing is read from this path.
    let there: fs.Stats | null = null;
    try { there = io.stat(real); } catch { /* nothing there */ }
    return { error: there === null ? `${at}: no file at ${file}` : !there.isFile() ? `${at}: ${file} is not a file` : `${at}: ${file} could not be opened` };
  }
  try {
    let opened: fs.Stats;
    try { opened = io.fstat(fd); } catch { return { error: `${at}: no file at ${file}` }; }
    if (!opened.isFile()) return { error: `${at}: ${file} is not a file` };
    if (opened.size > max) return { error: `${at}: ${file} is ${opened.size} bytes; ${words.noun} is at most ${max}` };
    let bytes: Buffer | null;
    try { bytes = io.read(fd, max); } catch (e) { return { error: `${at}: ${file} could not be read (${e instanceof Error ? e.message : String(e)})` }; }
    if (bytes === null) return { error: `${at}: ${file} is more than ${max} bytes; ${words.noun} is at most ${max}` };
    return { bytes };
  } finally {
    try { io.close(fd); } catch { /* already closed: nothing to give back */ }
  }
}
