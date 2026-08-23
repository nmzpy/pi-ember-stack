import { isRec, normalizeFilePath } from "./utils.ts";

export function normReq(input: unknown): unknown {
	if (!isRec(input)) {
		return input;
	}

	const record: Record<string, unknown> = { ...(input as Record<string, unknown>) };

	normalizeFilePath(record);

	return record;
}
