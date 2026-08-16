import { afterEach, describe, expect, test } from "bun:test";
import { getCapabilities, setCapabilities, type TerminalCapabilities } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piEmberImagesPlugin from "../index.ts";

type InputHandler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI;
	handlers: Map<string, InputHandler[]>;
	sentMessages: unknown[];
}

const FALLBACK_CAPS: TerminalCapabilities = { images: null, trueColor: true, hyperlinks: true };
const SUPPORTED_CAPS: TerminalCapabilities = { images: "kitty", trueColor: true, hyperlinks: true };

/** Ambient pi-tui capability snapshot captured before any test mutation. */
const ORIGINAL_CAPS = getCapabilities();

/** A tiny 2x2 PNG base64. */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAABytlL0AAAAAA0lEQVR42mNhgQIAADgAWf044wAAAAAASUVORK5CYII=";

const tempDirs: string[] = [];

afterEach(() => {
	// Restore the global terminal-capability state so other test files in the
	// same process observe the same environment pi-tui would detect.
	setCapabilities(ORIGINAL_CAPS);
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeFakePi(): FakePi {
	const handlers = new Map<string, InputHandler[]>();
	const sentMessages: unknown[] = [];
	const pi = {
		on(event: string, handler: InputHandler): void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerMessageRenderer(): void {},
		registerCommand(): void {},
		sendMessage(message: unknown): void {
			sentMessages.push(message);
		},
	};
	return { pi: pi as unknown as FakePi["pi"], handlers, sentMessages };
}

function makeFakeCtx(cwd: string, options: { idle?: boolean } = {}): unknown {
	return {
		cwd,
		ui: { notify() {} },
		isIdle: () => options.idle ?? true,
	};
}

function makeTempImage(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ember-img-"));
	tempDirs.push(dir);
	const file = join(dir, "shot.png");
	writeFileSync(file, Buffer.from(TINY_PNG_BASE64, "base64"));
	return file;
}

async function runInput(
	handlers: Map<string, InputHandler[]>,
	text: string,
	ctx: unknown,
	images?: Array<{ type: "image"; mimeType: string; data: string }>,
): Promise<{ action: "continue" } | { action: "transform"; text: string; images?: unknown[] } | undefined> {
	const handler = handlers.get("input")?.[0];
	expect(handler).toBeDefined();
	const result = await handler?.(
		{ type: "input", text, images, source: "interactive" },
		ctx,
	);
	return result as ReturnType<typeof runInput>;
}

async function runBeforeAgentStart(
	handlers: Map<string, InputHandler[]>,
	ctx: unknown,
): Promise<unknown> {
	const handler = handlers.get("before_agent_start")?.[0];
	expect(handler).toBeDefined();
	return handler?.({ type: "before_agent_start", prompt: "x" }, ctx);
}

describe("pi-ember-images fallback preview placement", () => {
	test("fallback: renders labels inside user-message text and injects no preview", async () => {
		setCapabilities(FALLBACK_CAPS);
		const { pi, handlers, sentMessages } = makeFakePi();
		piEmberImagesPlugin(pi);
		const file = makeTempImage();
		const ctx = makeFakeCtx(tmpdir());

		const result = await runInput(handlers, `Review ${file} please`, ctx);
		expect(result?.action).toBe("transform");
		if (result?.action !== "transform") return;
		expect(result.text).toBe("Review [image 1: 2x2] please");
		expect(result.images).toHaveLength(1);
		expect(result.images?.[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(sentMessages).toHaveLength(0);
		expect(await runBeforeAgentStart(handlers, ctx)).toBeUndefined();
	});

	test("fallback: image-only prompt keeps the label as the whole message text", async () => {
		setCapabilities(FALLBACK_CAPS);
		const { pi, handlers } = makeFakePi();
		piEmberImagesPlugin(pi);
		const file = makeTempImage();

		const result = await runInput(handlers, file, makeFakeCtx(tmpdir()));
		expect(result?.action).toBe("transform");
		if (result?.action !== "transform") return;
		expect(result.text).toBe("[image 1: 2x2]");
		expect(result.images).toHaveLength(1);
	});

	test("fallback: multiple images keep submission order with per-image dimensions", async () => {
		setCapabilities(FALLBACK_CAPS);
		const { pi, handlers } = makeFakePi();
		piEmberImagesPlugin(pi);
		const fileA = makeTempImage();
		const fileB = makeTempImage();

		const result = await runInput(handlers, `${fileA} then ${fileB}`, makeFakeCtx(tmpdir()));
		expect(result?.action).toBe("transform");
		if (result?.action !== "transform") return;
		expect(result.text).toBe("[image 1: 2x2] then [image 2: 2x2]");
		expect(result.images).toHaveLength(2);
		expect(result.images?.[0]).toMatchObject({ mimeType: "image/png" });
		expect(result.images?.[1]).toMatchObject({ mimeType: "image/png" });
	});

	test("fallback: pre-existing attached images are preserved alongside new ones", async () => {
		setCapabilities(FALLBACK_CAPS);
		const { pi, handlers } = makeFakePi();
		piEmberImagesPlugin(pi);
		const file = makeTempImage();
		const existing = [{ type: "image" as const, mimeType: "image/webp", data: "existing" }];

		const result = await runInput(
			handlers,
			`see ${file}`,
			makeFakeCtx(tmpdir()),
			existing,
		);
		expect(result?.action).toBe("transform");
		if (result?.action !== "transform") return;
		expect(result.images).toHaveLength(2);
		expect(result.images?.[0]).toEqual(existing[0]);
		expect(result.images?.[1]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	test("supported protocol: unchanged preview path keeps placeholder-free text and defers preview when idle", async () => {
		setCapabilities(SUPPORTED_CAPS);
		const { pi, handlers, sentMessages } = makeFakePi();
		piEmberImagesPlugin(pi);
		const file = makeTempImage();
		const ctx = makeFakeCtx(tmpdir(), { idle: true });

		const result = await runInput(handlers, `Review ${file} please`, ctx);
		expect(result?.action).toBe("transform");
		if (result?.action !== "transform") return;
		expect(result.text).toBe("Review please");
		expect(result.images).toHaveLength(1);
		expect(sentMessages).toHaveLength(0);
		const injected = await runBeforeAgentStart(handlers, ctx);
		expect(injected).toEqual({
			message: {
				customType: "pi-ember-images-preview",
				content: "[image 1]",
				display: true,
				details: { placeholders: ["[image 1]"] },
			},
		});
	});

	test("supported protocol: non-idle submission sends the preview follow-up message", async () => {
		setCapabilities(SUPPORTED_CAPS);
		const { pi, handlers, sentMessages } = makeFakePi();
		piEmberImagesPlugin(pi);
		const file = makeTempImage();

		const result = await runInput(handlers, file, makeFakeCtx(tmpdir(), { idle: false }));
		expect(result?.action).toBe("transform");
		if (result?.action !== "transform") return;
		expect(result.text).toBe("");
		expect(result.images).toHaveLength(1);
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]).toMatchObject({
			customType: "pi-ember-images-preview",
			display: true,
			details: { placeholders: ["[image 1]"] },
		});
	});

	test("supported protocol: pre-existing attached images are preserved", async () => {
		setCapabilities(SUPPORTED_CAPS);
		const { pi, handlers } = makeFakePi();
		piEmberImagesPlugin(pi);
		const file = makeTempImage();
		const existing = [{ type: "image" as const, mimeType: "image/webp", data: "existing" }];

		const result = await runInput(
			handlers,
			`see ${file}`,
			makeFakeCtx(tmpdir()),
			existing,
		);
		expect(result?.action).toBe("transform");
		if (result?.action !== "transform") return;
		expect(result.images).toHaveLength(2);
		expect(result.images?.[0]).toEqual(existing[0]);
		expect(result.images?.[1]).toMatchObject({ type: "image", mimeType: "image/png" });
	});
});
