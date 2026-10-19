import { ParseRunner, type ParseRunnerOptions } from "./ParseRunner";

class TestParseRunner extends ParseRunner {
  constructor(
    options: ParseRunnerOptions,
    private readonly node: string,
  ) {
    super(options);
  }
  protected override executable(): string {
    return this.node;
  }
}

/** Tests only (not exported from the package index): a runner that spawns `executable` instead of Node. */
export const createTestParseRunner = (
  options: ParseRunnerOptions,
  executable: string,
): ParseRunner => new TestParseRunner(options, executable);
