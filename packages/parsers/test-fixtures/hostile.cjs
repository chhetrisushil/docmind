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
