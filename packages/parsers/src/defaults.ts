import { mdParser } from "./md";
import { orgParser } from "./org";
import { txtParser } from "./txt";
import type { DocumentParser } from "./types";

export const createDefaultParsers = (): DocumentParser[] => [txtParser, mdParser, orgParser];
