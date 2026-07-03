import { expectTypeOf, it } from "vitest";
import type { EditCheck, RuleContext, RuleResult } from "./index.js";

it("defines the evaluation contract shared by client and server", () => {
  expectTypeOf<EditCheck["evaluate"]>().parameter(0).toEqualTypeOf<RuleContext>();
  expectTypeOf<EditCheck["evaluate"]>().returns.toEqualTypeOf<RuleResult>();
});
