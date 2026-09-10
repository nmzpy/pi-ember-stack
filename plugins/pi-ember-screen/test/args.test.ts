import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMIT, DEFAULT_MIN_SIZE, parse_screen_args, ScreenArgsError } from "../args.ts";
import { DEFAULT_FORMAT, format_extension, format_mime_type, parse_format } from "../encode.ts";

/**
 * Argument contract between the plugin and the helper process.
 *
 * The helper is spawned per call with argv, so a parsing drift silently
 * changes capture behavior (wrong window, wrong size) instead of failing
 * loudly. These pin the defaults and the rejection paths.
 */

describe("screen helper arguments", () => {
	test("defaults: no mode flags, full listing budget, no scaling", () => {
		const options = parse_screen_args([]);
		expect(options.list).toBe(false);
		expect(options.diagnose).toBe(false);
		expect(options.limit).toBe(DEFAULT_LIMIT);
		expect(options.minSize).toBe(DEFAULT_MIN_SIZE);
		expect(options.scale).toBe(1);
		expect(options.maxWidth).toBe(0);
		expect(options.match).toBeUndefined();
		expect(options.handle).toBeUndefined();
	});

	test("list and diagnose flags", () => {
		expect(parse_screen_args(["--list"]).list).toBe(true);
		expect(parse_screen_args(["--diagnose"]).diagnose).toBe(true);
	});

	test("capture target flags", () => {
		const options = parse_screen_args(["--match", "brave", "--out", "C:/tmp/a.png"]);
		expect(options.match).toBe("brave");
		expect(options.out).toBe("C:/tmp/a.png");
	});

	test("handle is truncated to an integer address", () => {
		expect(parse_screen_args(["--handle", "131742"]).handle).toBe(131742);
		expect(parse_screen_args(["--handle", "131742.9"]).handle).toBe(131742);
	});

	test("scaling flags feed one resize decision", () => {
		const options = parse_screen_args(["--scale", "0.5", "--max-width", "900"]);
		expect(options.scale).toBe(0.5);
		expect(options.maxWidth).toBe(900);
	});

	test("non-positive scale falls back to no scaling", () => {
		expect(parse_screen_args(["--scale", "0"]).scale).toBe(1);
		expect(parse_screen_args(["--scale", "-2"]).scale).toBe(1);
	});

	test("listing bounds are repaired rather than trusted", () => {
		expect(parse_screen_args(["--limit", "0"]).limit).toBe(DEFAULT_LIMIT);
		expect(parse_screen_args(["--limit", "-5"]).limit).toBe(DEFAULT_LIMIT);
		expect(parse_screen_args(["--min-size", "-1"]).minSize).toBe(DEFAULT_MIN_SIZE);
		expect(parse_screen_args(["--min-size", "64"]).minSize).toBe(64);
	});

	test("format defaults to png and accepts the measured-better options", () => {
		const defaults = parse_screen_args([]);
		expect(defaults.format).toBe(DEFAULT_FORMAT);
		expect(DEFAULT_FORMAT).toBe("webp");
		expect(defaults.quality).toBe(0);
		expect(parse_screen_args(["--format", "webp"]).format).toBe("webp");
		expect(parse_screen_args(["--format", "jpeg"]).format).toBe("jpeg");
		expect(parse_screen_args(["--format", "webp", "--quality", "80"]).quality).toBe(80);
	});

	test("an unsupported format is rejected instead of silently falling back", () => {
		expect(() => parse_screen_args(["--format", "avif"])).toThrow();
		expect(() => parse_format("gif")).toThrow();
		expect(parse_format(undefined)).toBe(DEFAULT_FORMAT);
	});

	test("format drives the file extension and the tool-result MIME type", () => {
		expect(format_extension("png")).toBe("png");
		expect(format_extension("webp")).toBe("webp");
		expect(format_extension("jpeg")).toBe("jpg");
		expect(format_mime_type("png")).toBe("image/png");
		expect(format_mime_type("webp")).toBe("image/webp");
		expect(format_mime_type("jpeg")).toBe("image/jpeg");
	});

	test("unknown flags and missing values fail loudly", () => {
		expect(() => parse_screen_args(["--nope"])).toThrow(ScreenArgsError);
		expect(() => parse_screen_args(["--match"])).toThrow(ScreenArgsError);
		expect(() => parse_screen_args(["--handle"])).toThrow(ScreenArgsError);
		expect(() => parse_screen_args(["--handle", "abc"])).toThrow(ScreenArgsError);
		expect(() => parse_screen_args(["--out"])).toThrow(ScreenArgsError);
	});

	test("a flag stray value becomes an unknown argument", () => {
		expect(() => parse_screen_args(["--list", "brave"])).toThrow(ScreenArgsError);
	});
});
