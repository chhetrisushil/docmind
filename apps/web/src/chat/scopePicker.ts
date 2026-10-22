import type { ChatScope, DocumentStatus } from "@docmind/contracts";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";

// The chat's "Search in" picker as data: which documents it offers, which are chosen, and what a new
// choice saves as. Pure, apart from the two list/lookup calls. The page publishes `pickerValue` as the
// MultiSelectInput's bound value and keeps its option ids, which are all a SELECT_MANY may name.

/** At most this many recent documents are offered (the library's own cap). */
export const PICKER_CAP = 200;
const REMOVED = "Removed document";
const UNTITLED = "Untitled document";

export interface ScopeDoc {
  readonly id: string;
  readonly title: string;
  readonly status: DocumentStatus;
}
export interface PickerValue {
  options: { value: string; label: string; hint?: string }[];
  selected: string[];
  note?: string;
}

const key = (id: string): string => id.toLowerCase();
const labelOf = (d: ScopeDoc): string => d.title.trim().slice(0, 200) || UNTITLED;
const hintOf = (d: ScopeDoc): string | undefined =>
  d.status === "ready" ? undefined : d.status === "failed" ? "failed" : "processing";
const option = (d: ScopeDoc) => {
  const hint = hintOf(d);
  return { value: d.id, label: labelOf(d), ...(hint !== undefined && { hint }) };
};

/** The most recent documents, a page of 100 at a time, up to `cap`; `capped` when more exist. */
export async function listRecent(
  api: Pick<Api, "listDocuments">,
  cap = PICKER_CAP,
): Promise<{ docs: ScopeDoc[]; capped: boolean }> {
  const docs: ScopeDoc[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listDocuments(cursor);
    docs.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && docs.length < cap);
  return { docs: docs.slice(0, cap), capped: cursor !== undefined || docs.length > cap };
}

/** Each id read on its own: found, or removed on a 404. Another failure is neither, so a flaky network never drops a document from a scope. */
export async function lookUp(
  api: Pick<Api, "getDocument">,
  ids: readonly string[],
): Promise<{ found: Map<string, ScopeDoc>; removed: Set<string> }> {
  const found = new Map<string, ScopeDoc>();
  const removed = new Set<string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        found.set(key(id), await api.getDocument(id));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) removed.add(key(id));
      }
    }),
  );
  return { found, removed };
}

/** The picker's bound value: the chat's documents first (in scope order), then every other ready one. */
export function pickerValue(
  listed: readonly ScopeDoc[],
  scope: ChatScope,
  found: ReadonlyMap<string, ScopeDoc>,
  capped: boolean,
): PickerValue {
  const selected = scope === "all" ? [] : [...scope.documentIds];
  const byId = new Map(listed.map((d) => [key(d.id), d]));
  const chosen = new Set(selected.map(key));
  const options: PickerValue["options"] = selected.map((id) => {
    const d = byId.get(key(id)) ?? found.get(key(id));
    return d === undefined ? { value: id, label: REMOVED } : { ...option(d), value: id };
  });
  for (const d of listed)
    if (d.status === "ready" && !chosen.has(key(d.id))) options.push(option(d));
  return {
    options,
    selected,
    ...(capped && { note: `Showing the ${PICKER_CAP} most recent documents` }),
  };
}

/** What a chosen set saves as: removed documents dropped (the server refuses them), none left is "all". */
export function scopeFor(values: readonly string[], removed: ReadonlySet<string>): ChatScope {
  const keep = values.filter((v) => !removed.has(key(v)));
  return keep.length === 0 ? "all" : { documentIds: keep };
}
