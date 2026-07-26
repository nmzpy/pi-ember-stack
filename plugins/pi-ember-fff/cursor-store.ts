import type { GrepCursor } from "@ff-labs/fff-node";

export interface CachedGrepCursor {
	cursor: GrepCursor;
	externalDir?: string;
}

const cursorCache = new Map<string, CachedGrepCursor>();
let cursorCounter = 0;

export function storeCursor(cursor: GrepCursor, externalDir?: string): string {
	const id = `fff_c${++cursorCounter}`;
	cursorCache.set(id, { cursor, externalDir });
	if (cursorCache.size > 200) {
		const first = cursorCache.keys().next().value;
		if (first) cursorCache.delete(first);
	}
	return id;
}

export function getCursor(id: string): CachedGrepCursor | undefined {
	return cursorCache.get(id);
}

export interface FindCursor {
	query: string;
	pattern: string;
	pageSize: number;
	nextPageIndex: number;
	externalDir?: string;
}

const findCursorCache = new Map<string, FindCursor>();
let findCursorCounter = 0;

export function storeFindCursor(cursor: FindCursor): string {
	const id = `${++findCursorCounter}`;
	findCursorCache.set(id, cursor);
	if (findCursorCache.size > 200) {
		const first = findCursorCache.keys().next().value;
		if (first) findCursorCache.delete(first);
	}
	return id;
}

export function getFindCursor(id: string): FindCursor | undefined {
	return findCursorCache.get(id);
}

export function clearCursorStores(): void {
	cursorCache.clear();
	findCursorCache.clear();
	cursorCounter = 0;
	findCursorCounter = 0;
}
