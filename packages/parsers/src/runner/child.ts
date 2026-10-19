// Process entry. Bare specifiers never resolve through node_modules in the child: the parent
// passes a specifier -> real built file map (argv[2]); anything else bare is refused. Must run
// before anything else is required.
import Module from "node:module";
import { isAbsolute } from "node:path";

const map = JSON.parse(process.argv[2] ?? "{}") as Record<string, string>;
const mod = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const original = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  if (request.startsWith(".") || isAbsolute(request) || Module.isBuiltin(request)) {
    return original.call(this, request, ...rest);
  }
  const file = map[request];
  if (!file) throw new Error("bare specifier not allowed");
  return file;
};

require("./childMain");
