export {
	applyEdit,
	buildIdx,
	changedRange,
	fmtRegion,
} from "./apply.ts";
export {
	_lineHashesPure,
	ANCHOR_LEN,
	canon,
	HASH_CLASS,
	HASH_LEN,
	HASH_PROBE_STRIDE,
	HASH_SEP,
	HASH_SPACE,
	initHasher,
	lineHashes,
	MAX_HASH_LINES,
} from "./hash.ts";
export {
	type Anchor,
	parseHashRef,
	parseText,
} from "./parse.ts";
export {
	AnchorMismatchError,
	type AutoFix,
	assertRangeServed,
	type BDup,
	findNewEdge,
	type HEdit,
	type HTEdit,
	type NEdit,
	RangeStaleError,
	type RHEdit,
	resEdit,
	stripBarePrefixes,
	stripDiffPrefixes,
	swapReversedRanges,
	valEdit,
} from "./resolve.ts";
