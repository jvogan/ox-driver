import assert from "node:assert/strict";
import test from "node:test";

import { FakeAdapter } from "../../packages/adapters/fake/dist/index.js";
import {
	AdapterRegistry,
	officialTargetAdapterBindings,
} from "../../packages/core/dist/index.js";

test("official controller construction accepts only exact target harness and adapter bindings", () => {
	const registry = new AdapterRegistry({ approvedAdapters: officialTargetAdapterBindings });
	assert.throws(
		() => registry.register(new FakeAdapter()),
		/not the approved target binding/,
	);
	assert.throws(
		() => registry.register({ ...new FakeAdapter(), harness: "pi", id: "pi-lookalike" }),
		/not the approved target binding/,
	);
	registry.register({ ...new FakeAdapter(), harness: "pi", id: "pi-v1" });
	assert.equal(registry.get("pi").id, "pi-v1");
});

test("approved target policy cannot include controller hosts or duplicate harnesses", () => {
	for (const harness of ["codex", "codex-app-server", "claude_code", "openai-codex", "anthropic"]) {
		assert.throws(
			() => new AdapterRegistry({ approvedAdapters: [{ harness, adapterId: "host-lookalike" }] }),
			/outer controller host/,
		);
		assert.throws(
			() => new AdapterRegistry().register({ ...new FakeAdapter(), harness, id: "host-lookalike" }),
			/reserved for an outer controller host/,
		);
	}
	assert.throws(
		() => new AdapterRegistry({ approvedAdapters: [
			{ harness: "pi", adapterId: "pi-v1" },
			{ harness: "pi", adapterId: "pi-v2" },
		] }),
		/duplicate approved target harness/,
	);
});
