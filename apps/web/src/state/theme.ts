import { Store } from "./store";

export type ThemeChoice = "dark" | "light" | "system";
const KEY = "dm-theme";
const isChoice = (v: unknown): v is ThemeChoice => v === "dark" || v === "light" || v === "system";

export interface ThemeEnv {
  document: Document;
  matchMedia(
    query: string,
  ): Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;
  localStorage?: Pick<Storage, "getItem" | "setItem">;
}

function stored(env: ThemeEnv): ThemeChoice {
  try {
    const v = env.localStorage?.getItem(KEY);
    return isChoice(v) ? v : "system";
  } catch {
    return "system"; // storage blocked (private window, site data off): the preference is a convenience
  }
}

/** The theme preference. The only value the UI writes to browser storage; no token and no content ever is. */
export class ThemeStore extends Store<ThemeChoice> {
  private media: ReturnType<ThemeEnv["matchMedia"]> | undefined;
  constructor(private readonly env: ThemeEnv = window) {
    super(stored(env));
    this.subscribe(() => this.apply());
  }
  choose(choice: ThemeChoice): void {
    try {
      this.env.localStorage?.setItem(KEY, choice);
    } catch {
      // blocked: the choice still applies for this page
    }
    this.set(choice);
    this.apply(); // also when the choice equals the current one
  }
  /** Sets `data-theme` to `dark` or `light` on the root element, following the system when the choice is `system`. */
  apply(): void {
    this.media ??= this.env.matchMedia("(prefers-color-scheme: light)");
    const choice = this.get();
    const resolved = choice === "system" ? (this.media.matches ? "light" : "dark") : choice;
    this.env.document.documentElement.dataset.theme = resolved;
  }
  /** Re-applies when the OS theme flips, while the choice is `system`. */
  watchSystem(): () => void {
    this.media ??= this.env.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => this.get() === "system" && this.apply();
    this.media.addEventListener("change", onChange);
    return () => this.media?.removeEventListener("change", onChange);
  }
}
