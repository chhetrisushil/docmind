import { afterEach, vi } from "vitest";

// Elements a test mounts must not outlive it: several of them listen on `window` or `document` while connected.
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
