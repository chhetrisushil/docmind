import { Store } from "./store";

/** The erasure receipt, kept in memory for this page only: never stored, never logged, gone on reload. */
export class ReceiptStore extends Store<string | undefined> {
  constructor() {
    super(undefined);
  }
}
