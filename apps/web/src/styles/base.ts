import { css } from "lit";

export const baseStyles = css`
  :host { font-family: var(--dm-font); color: var(--dm-text); }
  *, *::before, *::after { box-sizing: border-box; }
  :focus-visible { outline: var(--dm-focus-ring); outline-offset: 2px; }
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  button { font: inherit; color: inherit; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-weight: 500; padding: 5.6px 10px; min-height: 32px; border-radius: var(--dm-radius-md); border: 1px solid transparent; background: transparent; cursor: pointer; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .btn.primary { color: var(--dm-accent); border-color: var(--dm-accent); }
  .btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dm-accent) 12%, transparent); }
  .btn.primary:active:not(:disabled) { background: color-mix(in srgb, var(--dm-accent) 22%, transparent); }
  .btn.secondary { border-color: var(--dm-divider); }
  .btn.secondary:hover:not(:disabled) { background: color-mix(in srgb, var(--dm-text) 7%, transparent); }
  .btn.ghost { color: var(--dm-accent); }
  .btn.ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--dm-accent) 10%, transparent); }
  .btn.icon { width: 36px; padding: 0; color: var(--dm-muted); }
  .btn.danger { color: var(--dm-err); border-color: var(--dm-err); }
  label { display: block; font-size: 12px; color: color-mix(in srgb, var(--dm-text) 70%, transparent); margin-bottom: 4px; }
  .input { width: 100%; min-height: 36px; padding: 6px 10px; font: inherit; font-size: 14px; color: var(--dm-text); background: var(--dm-surface); border: 1px solid var(--dm-divider); border-radius: var(--dm-radius-md); caret-color: var(--dm-accent); }
  .input:hover { border-color: color-mix(in srgb, var(--dm-text) 45%, transparent); }
  .input:focus { border-color: var(--dm-accent); }
  .input[aria-invalid="true"] { border-color: var(--dm-err); }
  .error { display: flex; gap: 6px; align-items: center; color: var(--dm-err); font-size: 12px; margin-top: 4px; }
  .tag { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 12px; background: var(--dm-neutral-800); color: var(--dm-neutral-100); }
  .tag.accent { background: var(--dm-tag-accent-bg); color: var(--dm-tag-accent-fg); }
  .muted { color: var(--dm-muted); }
  .spin { animation: dm-spin 1s linear infinite; }
  .skeleton { background: var(--dm-neutral-800); border-radius: 4px; animation: dm-pulse 1.4s ease-in-out infinite; }
  @keyframes dm-spin { to { transform: rotate(360deg); } }
  @keyframes dm-pulse { 50% { opacity: 0.45; } }
`;

/** A button the page keeps focusable while it is busy (aria-disabled), drawn as disabled. */
export const ariaDisabledStyles = css`
  .btn[aria-disabled="true"] { opacity: 0.45; cursor: default; }
`;
