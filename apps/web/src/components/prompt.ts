import "./dm-dialog";

/**
 * A modal text prompt on `document.body`. Resolves the trimmed new value, or undefined for Cancel, Escape, an empty
 * value, no change, or an aborted `signal` (the page that asked has gone). The value is user content: never log it.
 */
export function promptDialog(
  heading: string,
  label: string,
  initial: string,
  confirmLabel: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }
    const dialog = document.createElement("dm-dialog") as HTMLElement & { open: boolean };
    dialog.setAttribute("heading", heading);
    dialog.open = true;
    const input = document.createElement("input");
    input.className = "input";
    input.value = initial;
    input.maxLength = 200;
    input.setAttribute("aria-label", label);
    input.autofocus = true;
    const cancel = document.createElement("button");
    cancel.slot = "actions";
    cancel.className = "btn secondary";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.slot = "actions";
    ok.className = "btn primary";
    ok.textContent = confirmLabel;
    const done = (value: string | undefined) => {
      signal?.removeEventListener("abort", onAbort);
      dialog.remove();
      resolve(value);
    };
    const onAbort = () => done(undefined);
    const save = () => {
      const v = input.value.trim();
      done(v === "" || v === initial ? undefined : v);
    };
    signal?.addEventListener("abort", onAbort);
    cancel.addEventListener("click", () => done(undefined));
    ok.addEventListener("click", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
    dialog.addEventListener("dm-close", () => done(undefined));
    dialog.append(input, cancel, ok);
    document.body.append(dialog);
  });
}
