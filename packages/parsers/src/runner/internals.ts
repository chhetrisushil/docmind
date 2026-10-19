/**
 * Test-only runner settings that must never be reachable through the exported constructor: they
 * widen the child's filesystem grants. Not exported from the package index, and the package's
 * `exports` map hides this file from deep imports.
 */
export interface RunnerInternals {
  /** The compiled child entry. Default: `dist/child/child.cjs` (the bundle); its directory is the read grant. */
  childEntry?: string;
  /** A CommonJS file exporting `parsers`. */
  parserModule?: string;
}
const table = new WeakMap<object, RunnerInternals>();
export const setRunnerInternals = (runner: object, internals: RunnerInternals): void => {
  table.set(runner, internals);
};
export const runnerInternals = (runner: object): RunnerInternals => table.get(runner) ?? {};
