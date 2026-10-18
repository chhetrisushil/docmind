import { describe, expectTypeOf, it } from "vitest";
import type { Cursor, Email, IsoDateTime, Uuid } from "./index";

describe("common contract types", () => {
  it("export a type with the same name as each schema", () => {
    expectTypeOf<Uuid>().toEqualTypeOf<string>();
    expectTypeOf<IsoDateTime>().toEqualTypeOf<string>();
    expectTypeOf<Cursor>().toEqualTypeOf<string>();
    expectTypeOf<Email>().toEqualTypeOf<string>();
  });
});
