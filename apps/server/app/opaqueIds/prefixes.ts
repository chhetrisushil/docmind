/**
 * User-owned execution ids start with one of these: `u_<uuid>` (every run before the deploy) and `h_<handle>` (every run after). The log
 * lists ids in code-point order, so each is one contiguous run: a walk seeks to the prefix and stops at the first id past it.
 */
export const USER_ID_PREFIXES = ["u_", "h_"] as const;

/** The id prefixes of one user's executions: `u_<uuid>` always, `h_<handle>` once the user has a handle. */
export const userPrefixes = (userId: string, handle?: string | null): string[] => [
  `u_${userId}`,
  ...(handle ? [`h_${handle}`] : []),
];

/** What extends one user prefix into an id: `<prefix>:...` (a flow) and `<prefix>.c-...` (a chat conversation). For `starts_with` listers. */
export const prefixExtensions = (prefix: string): [string, string] => [
  `${prefix}:`,
  `${prefix}.c-`,
];

/** Whether an execution id is the user's: a prefix itself, `<prefix>:...` (a flow) or `<prefix>.c-...` (a chat conversation, any generation). */
export const isOwnedBy = (executionId: string, userId: string, handle?: string | null): boolean =>
  userPrefixes(userId, handle).some(
    (p) => executionId === p || prefixExtensions(p).some((x) => executionId.startsWith(x)),
  );

/**
 * What a `starts_with` lister matches: each prefix by equality, and its `:` and `.c-` forms by prefix. Bound as text, never `LIKE`:
 * `_` is a wildcard there and the prefix holds one.
 */
export const listerPrefixes = (
  userId: string,
  handle?: string | null,
): { exact: string[]; starts: string[] } => {
  const exact = userPrefixes(userId, handle);
  return { exact, starts: exact.flatMap((p) => [`${p}:`, `${p}.c-`]) };
};

/** The same match for ONE handle's executions only (the `h_` half of `listerPrefixes`): the tombstone scrub in erasure's `rows` step. */
export const handleListerPrefixes = (handle: string): { exact: string; starts: string[] } => {
  const exact = `h_${handle}`;
  return { exact, starts: [`${exact}:`, `${exact}.c-`] };
};
