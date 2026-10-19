import { expect, it } from "vitest";
import { VectorDimensionError } from "./index";

it("VectorDimensionError has a fixed message that names no values", () => {
  const e = new VectorDimensionError();
  expect(e.message).toBe("vector has the wrong size or a non-finite value");
  expect(e.name).toBe("VectorDimensionError");
});
