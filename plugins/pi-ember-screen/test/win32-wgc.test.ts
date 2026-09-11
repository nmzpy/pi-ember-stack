import { describe, expect, test } from "bun:test";
import { pack_int32_pair, winrt_guid } from "../platform/win32-wgc.ts";

/**
 * The two ABI encodings the compositor capture depends on. Both are pure, so
 * they are pinned here rather than discovered at capture time — a wrong byte
 * order or a wrong register packing shows up as E_NOINTERFACE or a frame pool
 * that accepts a nonsense size, far from the cause.
 */

describe("winrt_guid", () => {
	test("lays a GUID out as the memory a REFIID points at", () => {
		// IGraphicsCaptureItem, as published in the Windows Runtime IDL.
		const bytes = winrt_guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
		expect(bytes.length).toBe(16);
		expect(bytes.toString("hex")).toBe("5bf9c379f731c24ea464632ef5d30760");
	});

	test("keeps the 4-2-2-2-6 groups in one piece", () => {
		// The trailing group is 6 bytes, not 2: dropping it silently produced a
		// different interface (and an E_NOINTERFACE from the activation factory).
		const bytes = winrt_guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356");
		expect(bytes.toString("hex")).toBe("1be82836ac3c604cb7f423ce0e0c3356");
		// IUnknown: only the last group carries data.
		expect(winrt_guid("00000000-0000-0000-c000-000000000046").toString("hex")).toBe(
			"0000000000000000c000000000000046",
		);
	});

	test("rejects a malformed GUID instead of producing a wrong interface", () => {
		expect(() => winrt_guid("79c3f95b-31f7-4ec2-a464")).toThrow();
	});
});

describe("pack_int32_pair", () => {
	test("puts the first value in the low half and the second in the high half", () => {
		expect(pack_int32_pair(2146, 1551)).toBe((1551n << 32n) | 2146n);
		expect(pack_int32_pair(1, 0)).toBe(1n);
		expect(pack_int32_pair(0, 1)).toBe(1n << 32n);
	});

	test("carries negative coordinates as two's complement", () => {
		// A window at x = -11 (a maximized frame overhangs the screen edge).
		expect(pack_int32_pair(-11, -11)).toBe(0xfffffff5_fffffff5n);
	});
});
