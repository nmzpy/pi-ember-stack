import { describe, expect, test } from "bun:test";
import { get_token_expiry } from "../src/cloud-direct/auth.ts";
import { decode_connect_unary_body, frame_connect_message } from "../src/cloud-direct/wire.ts";

describe("Cursor OAuth helpers", () => {
	test("parses JWT expiry with safety margin", () => {
		const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
		const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url");
		const token = `${header}.${payload}.sig`;
		const expires = get_token_expiry(token);
		expect(expires).toBe(1_700_000_000 * 1000 - 5 * 60 * 1000);
	});
});

describe("Cursor connect decode", () => {
	test("extracts inner proto from framed unary body", () => {
		const inner = Buffer.from([0x08, 0x01]);
		const framed = frame_connect_message(inner);
		expect(decode_connect_unary_body(framed)?.length).toBe(2);
	});
});
