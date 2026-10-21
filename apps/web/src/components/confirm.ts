import "./dm-dialog";

/** A modal yes/no on `document.body`. Resolves false for Cancel, Escape and an aborted `signal` (the page that asked has gone); removes itself either way. */
export function confirmDialog(
  heading: string,
  body: string,
  confirmLabel: string,
  danger = false,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dm-dialog") as HTMLElement & {
      open: boolean;
      persistent: boolean;
    };
    dialog.setAttribute("heading", heading);
    dialog.persistent = true; // a stray click outside must not answer a destructive question; Escape and Cancel still do
    dialog.open = true;
    const text = document.createElement("p");
    text.textContent = body;
    const cancel = document.createElement("button");
    cancel.slot = "actions";
    cancel.className = "btn secondary";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.slot = "actions";
    ok.className = `btn ${danger ? "danger" : "primary"}`;
    ok.textContent = confirmLabel;
    const done = (yes: boolean) => {
      signal?.removeEventListener("abort", onAbort);
      dialog.remove();
      resolve(yes);
    };
    const onAbort = () => done(false);
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    signal?.addEventListener("abort", onAbort);
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    dialog.addEventListener("dm-close", () => done(false));
    dialog.append(text, cancel, ok);
    document.body.append(dialog);
  });
}
