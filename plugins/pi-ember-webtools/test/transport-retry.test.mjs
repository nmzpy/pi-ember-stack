// Tests that webtools network fetches are wrapped in the shared transient
// transport retry policy from transport-policy.ts.
//
// These tests use mocked fetch — no real network calls are made.
// Runner: node --test (matches the package's existing .test.mjs convention).

import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchRemoteUrl } from "../ssrf-protection.ts";
import {
	MAX_TRANSPORT_RETRIES,
	TRANSPORT_RETRY_BACKOFF_MS,
} from "../../pi-custom-agents/subagent/extensions/transport-policy.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

/**
 * Create a mock fetch that responds according to a sequence of behaviours.
 * Each entry in `behaviours` is either an Error (thrown) or a Response
 * (returned). If more calls are made than behaviours, the last is reused.
 */
function mockFetch(behaviours) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url: url.toString(), init });
		const idx = Math.min(calls.length - 1, behaviours.length - 1);
		const behaviour = behaviours[idx];
		if (behaviour instanceof Error) {
			throw behaviour;
		}
		return behaviour;
	};
	impl.calls = calls;
	return impl;
}

function okResponse(body = "ok", status = 200) {
	return new Response(body, { status });
}

// ---------------------------------------------------------------------------
// 1. Bare TypeError('fetch failed') retries with the shared policy
// ---------------------------------------------------------------------------

test("fetchRemoteUrl retries on bare TypeError('fetch failed') then succeeds", async () => {
	const fetchImpl = mockFetch([
		new TypeError("fetch failed"),
		okResponse("recovered"),
	]);

	const response = await fetchRemoteUrl(
		"https://example.com/",
		{},
		{ lookup: publicLookup, fetch: fetchImpl, maxRedirects: 0, retryBackoffMs: 0 },
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "recovered");
	assert.equal(fetchImpl.calls.length, 2, "should have retried once");
});

// ---------------------------------------------------------------------------
// 2. Exact 'Terminated' error retries with the shared policy
// ---------------------------------------------------------------------------

test("fetchRemoteUrl retries on exact 'Terminated' error then succeeds", async () => {
	const err = new Error("Terminated");
	const fetchImpl = mockFetch([err, okResponse("recovered")]);

	const response = await fetchRemoteUrl(
		"https://example.com/",
		{},
		{ lookup: publicLookup, fetch: fetchImpl, maxRedirects: 0, retryBackoffMs: 0 },
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "recovered");
	assert.equal(fetchImpl.calls.length, 2, "should have retried once");
});

// ---------------------------------------------------------------------------
// 3. AbortSignal stops retrying immediately
// ---------------------------------------------------------------------------

test("fetchRemoteUrl does not retry when AbortSignal is already aborted", async () => {
	const fetchImpl = mockFetch([new TypeError("fetch failed")]);

	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		fetchRemoteUrl(
			"https://example.com/",
			{ signal: controller.signal },
			{ lookup: publicLookup, fetch: fetchImpl, maxRedirects: 0, retryBackoffMs: 0 },
		),
	);

	// The fetch should never have been called because the signal was already
	// aborted before the first attempt (retry_transient_transport_operation
	// checks signal.aborted at the top of the loop).
	assert.equal(fetchImpl.calls.length, 0, "should not have called fetch at all");
});

test("fetchRemoteUrl stops retrying when signal aborts mid-operation", async () => {
	// First attempt throws a transient error, but we abort the signal during
	// the backoff so the retry should not happen.
	let callCount = 0;
	const controller = new AbortController();
	const fetchImpl = async () => {
		callCount++;
		// Abort during the first error, before the retry.
		controller.abort();
		throw new TypeError("fetch failed");
	};

	await assert.rejects(
		fetchRemoteUrl(
			"https://example.com/",
			{ signal: controller.signal },
			{ lookup: publicLookup, fetch: fetchImpl, maxRedirects: 0, retryBackoffMs: 0 },
		),
	);

	assert.equal(callCount, 1, "should not have retried after abort");
});

// ---------------------------------------------------------------------------
// 4. Permanent 401 HTTP error does not retry
// ---------------------------------------------------------------------------

test("fetchRemoteUrl does not retry on permanent HTTP 401", async () => {
	// A 401 response is NOT an error throw — it's a non-ok Response. The retry
	// wrapper only catches thrown errors. The 401 should be returned as-is
	// without any retry.
	const fetchImpl = mockFetch([
		new Response("Unauthorized", { status: 401 }),
	]);

	const response = await fetchRemoteUrl(
		"https://example.com/",
		{},
		{ lookup: publicLookup, fetch: fetchImpl, maxRedirects: 0, retryBackoffMs: 0 },
	);

	assert.equal(response.status, 401);
	assert.equal(fetchImpl.calls.length, 1, "should not retry on 401");
});

test("fetchRemoteUrl does not retry on non-transient Error", async () => {
	// An error that is NOT classified as transient transport death (e.g. a
	// generic 'Something went wrong') should propagate immediately.
	const fetchImpl = mockFetch([
		new Error("Something went wrong"),
	]);

	await assert.rejects(
		fetchRemoteUrl(
			"https://example.com/",
			{},
			{ lookup: publicLookup, fetch: fetchImpl, maxRedirects: 0, retryBackoffMs: 0 },
		),
		/Something went wrong/,
	);

	assert.equal(fetchImpl.calls.length, 1, "should not retry on non-transient error");
});

// ---------------------------------------------------------------------------
// 5. SSRF rejection happens before any retry/fetch
// ---------------------------------------------------------------------------

test("SSRF rejection happens before any fetch call (no retry)", async () => {
	const fetchImpl = mockFetch([okResponse("should not reach")]);

	// 127.0.0.1 is a blocked internal address — SSRF validation should reject
	// before fetch is ever called.
	await assert.rejects(
		fetchRemoteUrl(
			"http://127.0.0.1/admin",
			{},
			{ fetch: fetchImpl, maxRedirects: 0 },
		),
		/Blocked internal/,
	);

	assert.equal(fetchImpl.calls.length, 0, "SSRF rejection should prevent any fetch call");
});

test("SSRF rejection on redirect target happens before retry", async () => {
	// First fetch returns a redirect to an internal address.
	// The SSRF validation on the redirect target should throw before any
	// second fetch call. The retry wrapper should NOT retry this because
	// SSRF errors are not transient transport deaths.
	const fetchImpl = mockFetch([
		new Response("", { status: 302, headers: { location: "http://10.0.0.1/secret" } }),
		okResponse("should not reach"),
	]);

	await assert.rejects(
		fetchRemoteUrl(
			"https://example.com/",
			{},
			{ lookup: publicLookup, fetch: fetchImpl, maxRedirects: 5 },
		),
		/Blocked internal/,
	);

	// Only the first fetch (which returned the redirect) should have been called.
	// The SSRF rejection on the redirect target should prevent the second fetch.
	assert.equal(fetchImpl.calls.length, 1, "SSRF rejection on redirect should prevent retry");
});

// ---------------------------------------------------------------------------
// 6. Retry exhaustion: transient errors exhaust the budget and throw
// ---------------------------------------------------------------------------

test("fetchRemoteUrl exhausts retries on persistent transient failure", async () => {
	const fetchImpl = mockFetch([new TypeError("fetch failed")]);

	await assert.rejects(
		fetchRemoteUrl(
			"https://example.com/",
			{},
			{ lookup: publicLookup, fetch: fetchImpl, maxRedirects: 0, retryBackoffMs: 0 },
		),
		/fetch failed/,
	);

	// Initial attempt + MAX_TRANSPORT_RETRIES retries = MAX_TRANSPORT_RETRIES + 1 calls
	assert.equal(
		fetchImpl.calls.length,
		MAX_TRANSPORT_RETRIES + 1,
		`should have made ${MAX_TRANSPORT_RETRIES + 1} total attempts (initial + retries)`,
	);
});

// ---------------------------------------------------------------------------
// 7. Shared policy constants are used (no local retry constants)
// ---------------------------------------------------------------------------

test("TRANSPORT_RETRY_BACKOFF_MS has expected shape", () => {
	assert.ok(Array.isArray(TRANSPORT_RETRY_BACKOFF_MS));
	assert.equal(TRANSPORT_RETRY_BACKOFF_MS.length, MAX_TRANSPORT_RETRIES);
	assert.ok(TRANSPORT_RETRY_BACKOFF_MS.every((ms) => typeof ms === "number" && ms > 0));
});
