import { describe, expect, test } from "bun:test";
import {
	DEFAULT_BASH_TIMEOUT_SECONDS,
	LEGACY_BASH_TIMEOUT_SECONDS,
	resolve_bash_timeout_seconds,
} from "../bash-timeout.ts";

describe("bash-timeout", () => {
	test("defaults missing timeout to 20 minutes", () => {
		expect(resolve_bash_timeout_seconds(undefined)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
		expect(resolve_bash_timeout_seconds(null)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
		expect(resolve_bash_timeout_seconds(0)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
	});

	test("upgrades legacy 600s timeout to 20 minutes", () => {
		expect(resolve_bash_timeout_seconds(LEGACY_BASH_TIMEOUT_SECONDS)).toBe(
			DEFAULT_BASH_TIMEOUT_SECONDS,
		);
	});

	test("preserves explicit non-legacy timeouts", () => {
		expect(resolve_bash_timeout_seconds(45)).toBe(45);
		expect(resolve_bash_timeout_seconds(1800)).toBe(1800);
	});
});
