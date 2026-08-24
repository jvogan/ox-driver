import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Normalize two empty, zero-usage provider anomalies into Pi's transient-error
 * classifier. Pi then applies its bounded retry policy and normal backoff.
 */
export default function piResilience(pi: ExtensionAPI) {
	if (process.env.OX_DRIVER_GUARD_READY !== "1") return;
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const message = event.message;
		const usage = message.usage;
		const hasUsage = usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
		if (hasUsage) return;

		const emptySuccess = message.stopReason === "stop" && message.content.length === 0;
		const bareProviderError =
			message.stopReason === "error" &&
			message.content.length === 0 &&
			message.errorMessage?.trim().toUpperCase() === "ERROR";
		if (!emptySuccess && !bareProviderError) return;

		return {
			message: {
				...message,
				stopReason: "error",
				errorMessage: bareProviderError
					? "Provider returned error: ERROR; retrying as a transient failure"
					: "Provider returned error: empty successful response; retrying as a transient failure",
			},
		};
	});
}
