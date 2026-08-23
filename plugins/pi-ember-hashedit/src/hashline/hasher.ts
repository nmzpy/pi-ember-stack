export type Hasher = {
	h32(input: string, seed?: number): number;
	h64ToString(input: string, seed?: bigint): string;
};

const xxhash_module_name: string = "xxhash-wasm";

let hasher: Hasher | null = null;

export function getH(): Hasher {
	if (hasher) return hasher;
	throw new Error(
		"xxhash-wasm hasher not initialized; await initHasher() before calling hashline APIs.",
	);
}

const hasherP: Promise<Hasher> = import(xxhash_module_name)
	.then((module: unknown) => {
		const factory = (module as { default?: unknown }).default;
		if (typeof factory !== "function") {
			throw new Error("xxhash-wasm module does not export a factory.");
		}
		return (factory as () => Promise<Hasher>)();
	})
	.then((h: Hasher) => {
		hasher = h;
		return h;
	})
	.catch((err: unknown) => {
		console.error("xxhash-wasm initialization failed:", err);
		throw err;
	});

export function initHasher(): Promise<Hasher> {
	return hasherP;
}

export function xxh32(input: string, seed = 0): number {
	return getH().h32(input, seed) >>> 0;
}

export function contentChecksum(content: string): string {
	return getH().h64ToString(content);
}
