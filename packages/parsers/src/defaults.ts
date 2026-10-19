import { txtParser } from "./txt";
import type { DocumentParser } from "./types";

export const createDefaultParsers = (): DocumentParser[] => [txtParser];
