import { existsSync, realpathSync, statSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { StartupConfigError } from "../startupError";
import { type Handler, sendError } from "./respond";

/** The policy of the web app: everything from this origin, no inline script or style, no remote font, image or frame. */
export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// No ".map": source maps are never served.
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** `DOCMIND_WEB_DIR`: unset or empty means the server serves the API only; otherwise a directory with an index.html. */
export function loadWebDir(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const dir = resolve(raw);
  const index = join(dir, "index.html");
  const ok =
    existsSync(dir) && statSync(dir).isDirectory() && existsSync(index) && statSync(index).isFile();
  if (!ok)
    throw new StartupConfigError("DOCMIND_WEB_DIR must be a directory that holds index.html");
  return dir;
}

/** Serves the built app: files by path, and `index.html` for any path with no extension (a client route). GET and HEAD. */
export function staticHandler(dir: string): Handler {
  const root = resolve(dir);
  const realRoot = realpathSync(root); // once, at startup
  const indexPath = join(root, "index.html");
  const notFound = (res: Parameters<Handler>[1]) =>
    sendError(res, 404, "not_found", "no such file");
  /** A dot-segment anywhere, or a source map, in a path relative to the root (any case). */
  const forbidden = (path: string) =>
    path.split(/[\\/]/).some((part) => part.startsWith(".")) ||
    extname(path).toLowerCase() === ".map";
  return async (req, res) => {
    let rel: string;
    try {
      // The raw target, not a parsed URL: `new URL` would fold an encoded "%2e%2e" into the path before it is checked.
      const target = req.url ?? "/";
      const end = target.search(/[?#]/);
      rel = decodeURIComponent(end === -1 ? target : target.slice(0, end));
    } catch {
      return sendError(res, 400, "bad_request", "invalid path");
    }
    // Origin-form only: an absolute-form target is refused rather than guessed at.
    if (!rel.startsWith("/") || rel.includes("\u0000") || rel.includes("\\"))
      return sendError(res, 400, "bad_request", "invalid path");
    // The router does not see /API, //api or /api%2f as API paths; the handler must not answer them with the page.
    if (/^\/*api\//i.test(rel)) return sendError(res, 404, "not_found", "no such route");
    if (forbidden(rel)) return notFound(res);
    const ext = extname(rel).toLowerCase();
    const wanted = resolve(root, `.${rel}`);
    if (wanted !== root && !wanted.startsWith(root + sep)) return notFound(res);
    const page = ext === "";
    const file = page ? indexPath : wanted; // a path with no extension is a client route
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // The real path must stay inside the real root: a symlink in the directory cannot lead out of it.
      const real = await realpath(file);
      if (!real.startsWith(realRoot + sep)) throw new Error("outside");
      // What the symlinks resolved to is held to the same rules (a link to a dotfile or a map, or a different case).
      if (!page && forbidden(relative(realRoot, real))) throw new Error("forbidden");
      handle = await open(real, "r"); // then fstat the open descriptor: no gap between the check and the read
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("not a file");
      const type = TYPES[extname(real).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, {
        "content-type": type,
        "content-length": info.size,
        "cache-control": page
          ? "no-cache"
          : rel.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        "content-security-policy": WEB_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      if (req.method === "HEAD") {
        await handle.close();
        return void res.end();
      }
      const body = handle.createReadStream({ autoClose: true }); // owns the descriptor from here
      handle = undefined;
      await new Promise<void>((done) => {
        body.on("error", () => {
          res.destroy();
          done();
        });
        res.on("close", () => {
          body.destroy();
          done();
        });
        body.pipe(res);
      });
    } catch {
      await handle?.close().catch(() => undefined);
      if (res.headersSent) res.destroy();
      else notFound(res);
    }
  };
}
