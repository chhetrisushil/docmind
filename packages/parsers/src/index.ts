import { txtParser } from "./txt";
import type { DocumentParser } from "./types";

export * from "./types";
export { ParserRegistry } from "./registry";
export { txtParser };
export const createDefaultParsers = (): DocumentParser[] => [txtParser];
