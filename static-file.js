import * as nodePath from 'node:path';

// The file under `dir` for a URL path ("/" and other folders mean their index.html),
// or null if the path is malformed or points outside `dir`. `path` is node:path, or
// path.win32 / path.posix in tests, so Windows separators are covered too.
export function staticFile(dir, pathname, path = nodePath) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0')) return null;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(dir, '.' + rel);
  return file.startsWith(dir + path.sep) ? file : null;
}
