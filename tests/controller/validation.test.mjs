import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { validateRunSpec } from "../../packages/core/dist/index.js";

function spec(timeoutSeconds) {
	return {
		version: 1,
		tier: "attested",
		harness: "fake",
		task: { objective: "fixture", cwd: "/tmp", ownedPaths: [], excludedPaths: [] },
		execution: {
			session: "ephemeral",
			topology: "solo",
			writerPolicy: "read-only",
			network: "none",
			timeoutSeconds,
		},
		acceptance: { commands: [], requireCleanUnownedPaths: true },
	};
}

test("caps controller timeouts at one day", () => {
	assert.equal(validateRunSpec(spec(86_400)).execution.timeoutSeconds, 86_400);
	for (const value of [0, 86_401, Number.MAX_SAFE_INTEGER, 1.5]) {
		assert.throws(
			() => validateRunSpec(spec(value)),
			/execution\.timeoutSeconds must be an integer between 1 and 86400/,
		);
	}
});

test("defaults and bounds per-command acceptance controls", () => {
	const normalized = validateRunSpec(spec(10));
	assert.equal(normalized.acceptance.timeoutSeconds, 120);
	assert.equal(normalized.acceptance.continueOnFailure, false);

	for (const value of [0, 86_401, Number.MAX_SAFE_INTEGER, 1.5]) {
		assert.throws(
			() => validateRunSpec({ ...spec(10), acceptance: { ...spec(10).acceptance, timeoutSeconds: value } }),
			/acceptance\.timeoutSeconds must be an integer between 1 and 86400/,
		);
	}
	assert.throws(
		() => validateRunSpec({ ...spec(10), acceptance: { ...spec(10).acceptance, continueOnFailure: "yes" } }),
		/acceptance\.continueOnFailure must be a boolean/,
	);
	const configured = validateRunSpec({
		...spec(10),
		acceptance: { ...spec(10).acceptance, timeoutSeconds: 86_400, continueOnFailure: true },
	});
	assert.equal(configured.acceptance.timeoutSeconds, 86_400);
	assert.equal(configured.acceptance.continueOnFailure, true);
});

test("requires an explicit trust tier and validates report-only cost ceilings", () => {
	assert.equal(validateRunSpec(spec(10)).tier, "attested");
	assert.throws(() => validateRunSpec({ ...spec(10), tier: undefined }), /tier is invalid/);
	assert.throws(() => validateRunSpec({ ...spec(10), tier: "local" }), /tier is invalid/);
	const trusted = validateRunSpec({
		...spec(10),
		tier: "trusted-host",
		execution: { ...spec(10).execution, reportOnlyCostUsdMicros: 50_000 },
	});
	assert.equal(trusted.execution.reportOnlyCostUsdMicros, 50_000);
	assert.throws(
		() => validateRunSpec({ ...trusted, execution: { ...trusted.execution, reportOnlyCostUsdMicros: -1 } }),
		/reportOnlyCostUsdMicros is invalid/,
	);
	assert.throws(
		() => validateRunSpec({ ...trusted, execution: { ...trusted.execution, maxCostUsdMicros: 50_000 } }),
		/cannot be combined/,
	);
});

test("validates and preserves an exact handoff workspace digest", () => {
	const digest = "a".repeat(64);
	const normalized = validateRunSpec({ ...spec(10), task: { ...spec(10).task, expectedWorkspaceSha256: digest } });
	assert.equal(normalized.task.expectedWorkspaceSha256, digest);
	assert.throws(
		() => validateRunSpec({ ...spec(10), task: { ...spec(10).task, expectedWorkspaceSha256: "A".repeat(64) } }),
		/lowercase SHA-256 digest/,
	);
});

test("validates and preserves an admitted route-profile digest", () => {
	const digest = "b".repeat(64);
	const value = spec(10);
	const normalized = validateRunSpec({ ...value, execution: { ...value.execution, expectedRouteProfileSha256: digest } });
	assert.equal(normalized.execution.expectedRouteProfileSha256, digest);
	assert.throws(
		() => validateRunSpec({ ...value, execution: { ...value.execution, expectedRouteProfileSha256: "B".repeat(64) } }),
		/lowercase SHA-256 digest/,
	);
});

test("keeps the run-spec schema timeout cap aligned with runtime validation", async () => {
	const schema = JSON.parse(await readFile(join(process.cwd(), "schemas", "run-spec.schema.json"), "utf8"));
	assert.deepEqual(schema.properties.execution.properties.timeoutSeconds, {
		type: "integer",
		minimum: 1,
		maximum: 86_400,
	});
	assert.deepEqual(schema.properties.acceptance.properties.timeoutSeconds, {
		type: "integer",
		minimum: 1,
		maximum: 86_400,
		default: 120,
	});
	assert.deepEqual(schema.properties.acceptance.properties.continueOnFailure, {
		type: "boolean",
		default: false,
	});
	assert.equal(schema.properties.acceptance.required.includes("timeoutSeconds"), false);
	assert.equal(schema.properties.acceptance.required.includes("continueOnFailure"), false);
});
