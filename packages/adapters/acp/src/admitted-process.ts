import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type {
	HarnessProcessAdmissionInput,
	HarnessProcessAdmissions,
	HarnessProcessCompletion,
} from "@ox-driver/core";

export interface AdmittedProcessExit extends HarnessProcessCompletion {
	exitCode: number | null;
}

export interface AdmittedChildProcess {
	child: ChildProcess;
	admissionId: string;
	exit: Promise<AdmittedProcessExit>;
	complete(): Promise<AdmittedProcessExit>;
}

function forceTerminate(child: ChildProcess, detachedProcessGroup: boolean): void {
	if (detachedProcessGroup && process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Fall back to the direct child handle below.
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// The child may already have exited.
	}
}

export async function spawnAdmittedProcess(
	executable: string,
	args: readonly string[],
	options: SpawnOptions,
	processes: HarnessProcessAdmissions,
	input: HarnessProcessAdmissionInput,
): Promise<AdmittedChildProcess> {
	const admission = await processes.admit(input);
	let child: ChildProcess;
	try {
		child = spawn(executable, [...args], options);
	} catch (error) {
		await admission.abandon("spawn-error");
		throw error;
	}

	let resolveSpawnError: (error: Error) => void = () => undefined;
	const spawnError = new Promise<Error>((resolve) => { resolveSpawnError = resolve; });
	child.once("error", resolveSpawnError);
	const exit = new Promise<AdmittedProcessExit>((resolve) => {
		child.once("close", (exitCode, terminationSignal) => resolve({
			exitCode,
			...(terminationSignal ? { terminationSignal } : {}),
		}));
	});

	if (!child.pid) {
		const error = await spawnError;
		await admission.abandon("spawn-error");
		throw error;
	}
	try {
		await admission.bind(child.pid);
	} catch (error) {
		forceTerminate(child, input.detachedProcessGroup);
		await exit;
		await admission.abandon("bind-error");
		throw error;
	}

	let completed = false;
	return {
		child,
		admissionId: admission.admissionId,
		exit,
		complete: async () => {
			if (completed) throw new Error(`harness process admission ${admission.admissionId} is already complete`);
			const result = await exit;
			await admission.complete(result);
			completed = true;
			return result;
		},
	};
}
