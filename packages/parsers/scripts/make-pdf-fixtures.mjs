// Regenerates test-fixtures/{two-pages,textless-middle}.pdf. Run: node scripts/make-pdf-fixtures.mjs
// The outputs are committed: pdf-lib's save() is async and the conformance suite is built at module level.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const out = join(dirname(fileURLToPath(import.meta.url)), "../test-fixtures");
const FIXED = new Date("2026-01-01T00:00:00Z");

const make = async (name, draw) => {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(FIXED);
  pdf.setModificationDate(FIXED);
  pdf.setProducer("docmind-fixtures");
  pdf.setCreator("docmind-fixtures");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const item of draw) {
    const page = pdf.addPage([300, 200]);
    if (item === null)
      page.drawRectangle({ x: 50, y: 50, width: 100, height: 60, color: rgb(0.8, 0.8, 0.8) });
    else page.drawText(item, { x: 50, y: 100, size: 18, font });
  }
  writeFileSync(join(out, name), await pdf.save({ useObjectStreams: false }));
};

await make("two-pages.pdf", ["Page one text", "Page two text"]);
await make("textless-middle.pdf", ["First", null, "Third"]);
