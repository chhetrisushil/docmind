import { DocumentGoneError } from "../ingest-document/errors";

/**
 * The turn's chat is gone: soft-deleted, its owner being erased, or the turn's visuals line erased. A `DocumentGoneError`
 * so the shared step machinery ends the step quietly; the logged outcome word stays the shared `document_gone` (the
 * step outputs, the status model and the event log all share that vocabulary, so the turn flow reuses it).
 */
export class TurnGoneError extends DocumentGoneError {
  constructor() {
    super();
    this.message = "the turn is gone";
    this.name = "TurnGoneError";
  }
}
