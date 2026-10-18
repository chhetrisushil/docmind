import { buildApp } from "./app/config";

// What the loom CLI (`loom gen`, `loom debug`) loads: in-memory storage, no database needed.
// The server builds the durable, encrypted app itself (app/main.ts).
export default buildApp({ kind: "memory" });
