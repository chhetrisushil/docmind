// Parsers a hostile or broken document could drive a real parser into. Test-only.
const ok = (text) => ({ text, sections: [], media: [] });
exports.parsers = [
  { id: "echo", accepts: () => true, parse: (b) => ok(Buffer.from(b).toString("utf8")) },
  {
    id: "throws-accepts",
    accepts: () => {
      throw new Error("SECRET-DOC-TEXT");
    },
    parse: () => ok("fine"),
  },
  {
    id: "throws-parse",
    accepts: () => true,
    parse: () => {
      throw new Error("SECRET-DOC-TEXT");
    },
  },
  { id: "bad-shape", accepts: () => true, parse: () => ({ text: 1 }) },
];
const raw = (frame) => ({
  accepts: () => true,
  parse: () => {
    require("node:fs").writeSync(3, frame);
    return new Promise(() => {});
  },
});
const frame = (v) => {
  const b = Buffer.from(typeof v === "string" ? v : JSON.stringify(v));
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length);
  return Buffer.concat([h, b]);
};
exports.parsers.push(
  { id: "big", accepts: () => true, parse: () => ok("x".repeat(1000)) },
  {
    id: "noisy",
    accepts: () => true,
    parse: () => {
      for (let i = 0; i < 4000; i++) {
        process.stdout.write("x".repeat(1000));
        process.stderr.write("y".repeat(1000));
        require("node:fs").writeSync(1, "z".repeat(1000));
      }
      return ok("done");
    },
  },
  {
    id: "spin",
    accepts: () => true,
    parse: () => {
      for (;;) {}
    },
  },
  { id: "exit", accepts: () => true, parse: () => process.exit(3) },
  { id: "exit0", accepts: () => true, parse: () => process.exit(0) },
  { id: "signal", accepts: () => true, parse: () => process.kill(process.pid, "SIGKILL") },
  {
    id: "oom",
    accepts: () => true,
    parse: () => {
      const hog = [];
      for (;;) hog.push(new Array(1e6).fill(hog.length));
    },
  },
  { id: "garbage", ...raw(Buffer.from([0, 0, 0, 8, 0xff, 0xff, 0xff, 0xff, 1, 2, 3, 4])) },
  { id: "notjson", ...raw(frame("not json")) },
  { id: "oversized", ...raw(Buffer.from([0xff, 0xff, 0xff, 0xff, 1])) },
  { id: "truncated", ...raw(Buffer.from([0, 0, 0, 9, 123])) },
  { id: "extra", ...raw(Buffer.concat([frame({ ok: false, kind: "failed" }), Buffer.from("x")])) },
  { id: "badcode", ...raw(frame({ ok: false, kind: "rejected", code: "SMUGGLED-TEXT" })) },
  {
    id: "readsrc",
    accepts: () => true,
    parse: () => {
      const fs = require("node:fs");
      const pkgs = require("node:path").resolve(process.cwd(), "../..", "..");
      const lex = `${pkgs}/parsers/node_modules/@docmind/contracts`;
      const denied = (f, op) => {
        try {
          fs[op](f);
          return false;
        } catch (e) {
          return e.code === "ERR_ACCESS_DENIED";
        }
      };
      const ok =
        denied(`${pkgs}/contracts/src/index.ts`, "readFileSync") &&
        denied(`${lex}/src/index.ts`, "readFileSync") &&
        denied(lex, "readdirSync") &&
        denied(`${pkgs}/parsers/node_modules`, "readdirSync");
      return { text: ok ? "denied" : "READ", sections: [], media: [] };
    },
  },
  {
    id: "bare",
    accepts: () => true,
    parse: () => ({ text: String(require("fs-extra")), sections: [], media: [] }),
  },
);
