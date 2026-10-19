import { docParser } from "./doc";
import { docxParser } from "./docx";
import { mdParser } from "./md";
import { orgParser } from "./org";
import { pdfParser } from "./pdf";
import { txtParser } from "./txt";
import type { DocumentParser } from "./types";

export const createDefaultParsers = (): DocumentParser[] => [
  txtParser,
  mdParser,
  orgParser,
  docxParser,
  docParser,
  pdfParser,
];
