import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { IntegrationReceiptStore } from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "../controller/helpers/tracked-temp.mjs";

const ORCHESTRATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function outcome() {
	return {
		orchestrationId: ORCHESTRATION_ID, status: "integrated",
		workspace: { id: WORKSPACE_ID, path: "/tmp/example-worktree", source: "/tmp/example-source", baseCommit: "a".repeat(40) },
		selectedLanes: [{ laneId: "writer", patchSha256: "b".repeat(64) }],
		applied: [{ laneId: "writer", patchSha256: "b".repeat(64) }],
		declaredChecks: ["fixture-check"], checksDeclared: true,
		checks: [{ command: "fixture-check", passed: true, exitCode: 0, timedOut: false, backgroundProcessesDetected: false, processTreeReaped: true, terminationEscalated: false }],
		finalWorkspaceSha256: "c".repeat(64),
	};
}

test("integration inspection creates no state and requires private regular receipts", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-integration-store-"));
	const state = join(root, "missing");
	await assert.rejects(new IntegrationReceiptStore(state).inspect(ORCHESTRATION_ID), { code: "ENOENT" });
	await assert.rejects(access(state));
	const store = new IntegrationReceiptStore(join(root, "records"));
	const receipt = await store.persist(outcome());
	const copy = await new IntegrationReceiptStore(store.root).inspect(receipt.integrationId, receipt.receiptSha256);
	assert.deepEqual(copy, receipt);
	await assert.rejects(store.inspect(receipt.integrationId, "0".repeat(64)), /digest mismatch/);
	const linked = "33333333-3333-4333-8333-333333333333";
	await symlink(receipt.receiptPath, join(store.root, `${linked}.json`));
	await assert.rejects(store.inspect(linked), /regular file/);
	assert.equal(JSON.parse(await readFile(receipt.receiptPath, "utf8")).receipt.integrationId, receipt.integrationId);
});

test("integration receipts reject contradictory success and retain check failures", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-integration-evidence-"));
	const store = new IntegrationReceiptStore(root);
	for (const changed of [
		{ applied: [] },
		{ applied: [{ laneId: "other", patchSha256: "b".repeat(64) }] },
		{ checks: [{ ...outcome().checks[0], passed: false }] },
		{ checks: [{ ...outcome().checks[0], processTreeReaped: false }] },
		{ checks: [{ ...outcome().checks[0], backgroundProcessesDetected: true }] },
		{ checksDeclared: false },
	]) await assert.rejects(store.persist({ ...outcome(), ...changed }), /integration receipt/);
	const failed = await store.persist({ ...outcome(), status: "checks-failed", checks: [{ ...outcome().checks[0], passed: false, exitCode: 1 }] });
	assert.equal((await store.inspect(failed.integrationId)).status, "checks-failed");
	const missingDigest = await store.persist({ ...outcome(), status: "evidence-failed", finalWorkspaceSha256: null, evidenceError: "workspace snapshot unavailable" });
	assert.equal((await store.inspect(missingDigest.integrationId)).finalWorkspaceSha256, null);
	const publicDirectory = join(root, "shared");
	await mkdir(publicDirectory, { mode: 0o755 });
	await assert.rejects(new IntegrationReceiptStore(publicDirectory).prepare(), /private/);
});
