import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_COUNT = 4;

type ContentBlock = Record<string, unknown>;
type MessageLike = Record<string, unknown> & { content?: unknown };

export interface ImageBudgetResult<T> {
	messages: T[];
	changed: boolean;
	storedCount: number;
	storedBytes: number;
	retainedCount: number;
	retainedBytes: number;
}

function imageBytes(block: ContentBlock): number | undefined {
	if (block.type !== "image" || typeof block.data !== "string") return undefined;
	return Buffer.byteLength(block.data, "utf8");
}

function omittedImage(bytes: number): ContentBlock {
	const mebibytes = (bytes / (1024 * 1024)).toFixed(1);
	return {
		type: "text",
		text: `[Earlier image omitted from this provider request by pi-image-budget (${mebibytes} MiB encoded). The original image remains in Pi session history.]`,
	};
}

/** Create a provider-safe view without changing the stored session. */
export function applyImageBudget<T extends MessageLike>(
	messages: T[],
	maxBytes = MAX_IMAGE_BYTES,
	maxCount = MAX_IMAGE_COUNT,
): ImageBudgetResult<T> {
	const images: Array<{ messageIndex: number; blockIndex: number; bytes: number }> = [];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		const content = messages[messageIndex]?.content;
		if (!Array.isArray(content)) continue;
		for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
			const block = content[blockIndex];
			if (!block || typeof block !== "object") continue;
			const bytes = imageBytes(block as ContentBlock);
			if (bytes !== undefined) images.push({ messageIndex, blockIndex, bytes });
		}
	}

	const storedBytes = images.reduce((sum, image) => sum + image.bytes, 0);
	if (images.length <= maxCount && storedBytes <= maxBytes) {
		return {
			messages,
			changed: false,
			storedCount: images.length,
			storedBytes,
			retainedCount: images.length,
			retainedBytes: storedBytes,
		};
	}

	const retained = new Set<string>();
	let retainedBytes = 0;
	let retainedCount = 0;
	for (let index = images.length - 1; index >= 0; index -= 1) {
		const image = images[index];
		if (retainedCount >= maxCount || retainedBytes + image.bytes > maxBytes) break;
		retained.add(`${image.messageIndex}:${image.blockIndex}`);
		retainedBytes += image.bytes;
		retainedCount += 1;
	}

	const projected = messages.slice();
	const affected = new Map<number, Set<number>>();
	for (const image of images) {
		if (retained.has(`${image.messageIndex}:${image.blockIndex}`)) continue;
		const indexes = affected.get(image.messageIndex) ?? new Set<number>();
		indexes.add(image.blockIndex);
		affected.set(image.messageIndex, indexes);
	}
	for (const [messageIndex, indexes] of affected) {
		const message = messages[messageIndex];
		const content = message.content as ContentBlock[];
		projected[messageIndex] = {
			...message,
			content: content.map((block, blockIndex) => {
				if (!indexes.has(blockIndex)) return block;
				return omittedImage(imageBytes(block) ?? 0);
			}),
		} as T;
	}

	return {
		messages: projected,
		changed: true,
		storedCount: images.length,
		storedBytes,
		retainedCount,
		retainedBytes,
	};
}

export default function piImageBudget(pi: ExtensionAPI) {
	if (process.env.OX_DRIVER_GUARD_READY !== "1") return;
	let lastNotice = "";
	pi.on("context", async (event, ctx) => {
		const result = applyImageBudget(event.messages as MessageLike[]);
		if (!result.changed) return undefined;
		const notice = `${result.retainedCount}/${result.storedCount}:${result.retainedBytes}/${result.storedBytes}`;
		if (ctx.hasUI && notice !== lastNotice) {
			const removed = result.storedCount - result.retainedCount;
			ctx.ui.notify(
				`Image history budget: omitted ${removed} older image${removed === 1 ? "" : "s"} from this provider request. The saved session is unchanged.`,
				"warning",
			);
			lastNotice = notice;
		}
		return { messages: result.messages as typeof event.messages };
	});
}
