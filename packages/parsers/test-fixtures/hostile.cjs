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
    const fs = require("node:fs");
    for (let off = 0; off < frame.length; ) off += fs.writeSync(3, frame, off);
    return new Promise(() => {});
  },
});
const frame = (v) => {
  const b = Buffer.from(typeof v === "string" ? v : JSON.stringify(v));
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length);
  return Buffer.concat([h, b]);
};
const CAP1 = 12 + 8 * 1024 * 1024; // the reply cap at maxChars 1
const padded = (bodyLen) => {
  const head = JSON.stringify({ ok: true, doc: ok("x"), pad: "" });
  const body = JSON.stringify({ ok: true, doc: ok("x"), pad: "p".repeat(bodyLen - head.length) });
  const h = Buffer.alloc(4);
  h.writeUInt32BE(body.length);
  return Buffer.concat([h, Buffer.from(body)]);
};
exports.parsers.push(
  { id: "longvalid", ...raw(frame({ ok: true, doc: ok("x".repeat(1000)) })) },
  { id: "atcap", ...raw(padded(CAP1)) },
  { id: "overcap", ...raw(Buffer.concat([Buffer.from([0, 0x80, 0, 0x0d]), Buffer.alloc(8)])) },
  { id: "huge", accepts: () => true, parse: () => ok("x".repeat(9 * 1024 * 1024)) },
  {
    // Short whole-document text, but sections that carry far more than maxChars between them.
    id: "sectionbulk",
    accepts: () => true,
    parse: () => ({
      text: "x",
      sections: Array.from({ length: 5 }, () => ({
        headingPath: [],
        text: "y".repeat(30),
        locator: { kind: "chars", start: 0, end: 1 },
      })),
      media: [],
    }),
  },
  {
    // Heading text is content: a few sections whose heading paths alone are far over maxChars.
    id: "headingbulk",
    accepts: () => true,
    parse: () => ({
      text: "x",
      sections: [
        {
          headingPath: Array.from({ length: 16 }, () => "h".repeat(500)),
          text: "",
          locator: { kind: "chars", start: 0, end: 1 },
        },
      ],
      media: [],
    }),
  },
  {
    id: "mediabulk",
    accepts: () => true,
    parse: () => ({
      text: "x",
      sections: [],
      media: Array.from({ length: 101 }, () => ({
        mime: "image/png",
        locator: { kind: "chars", start: 0, end: 1 },
      })),
    }),
  },
  {
    id: "sectioncount",
    accepts: () => true,
    parse: () => ({
      text: "x",
      sections: Array.from({ length: 101 }, () => ({
        headingPath: [],
        text: "",
        locator: { kind: "chars", start: 0, end: 1 },
      })),
      media: [],
    }),
  },
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
  {
    id: "hang",
    accepts: () => true,
    parse: () => new Promise(() => setInterval(() => {}, 1000)), // alive, but never answers
  },
  { id: "xcpu", accepts: () => true, parse: () => process.kill(process.pid, "SIGXCPU") },
  {
    id: "patched-hang",
    accepts: () => true,
    parse: () => {
      process.exit = () => {};
      process.kill = () => {};
      return new Promise(() => setInterval(() => {}, 1000));
    },
  },
  {
    id: "patched-kill-hang",
    accepts: () => true,
    parse: () => {
      process._kill = () => 0;
      process.exit = () => {};
      process.kill = () => {};
      return new Promise(() => setInterval(() => {}, 1000));
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
  {
    id: "close3spin",
    accepts: () => true,
    parse: () => {
      require("node:fs").closeSync(3);
      for (;;) {}
    },
  },
  {
    id: "probe",
    accepts: () => true,
    parse: () => {
      const fs = require("node:fs");
      const code = (f) => {
        try {
          f();
          return "allowed";
        } catch (e) {
          return e.code;
        }
      };
      const result = {
        read: code(() => fs.readFileSync("/etc/hosts")),
        write: code(() => fs.writeFileSync(`${require("node:os").tmpdir()}/dm-probe`, "x")),
        spawn: code(() => require("node:child_process").execSync("true")),
        env: Object.keys(process.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING"),
      };
      return ok(JSON.stringify(result));
    },
  },
);
