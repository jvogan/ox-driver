import assert from "node:assert/strict";
import test from "node:test";

import { clamp } from "../src/clamp.mjs";

test("clamp keeps a value inside the inclusive bounds", () => {
	assert.equal(clamp(-2, 0, 10), 0);
	assert.equal(clamp(4, 0, 10), 4);
	assert.equal(clamp(12, 0, 10), 10);
});
