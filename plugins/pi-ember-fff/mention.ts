import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { FileFinder, MixedItem } from "@ff-labs/fff-node";

const MENTION_MAX_RESULTS = 20;

function extractAtPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
	return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
	return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function createFffMentionProvider(
	getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] || "";
			const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
			if (!prefix || options.signal.aborted) return null;

			const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
			const items = await getItems(query, options.signal);
			return options.signal.aborted || items.length === 0 ? null : { items, prefix };
		},
		applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
			const currentLine = _lines[cursorLine] || "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol);
			const newLine = before + item.value + after;
			const newCursorCol = cursorCol - prefix.length + item.value.length;
			return {
				lines: [..._lines.slice(0, cursorLine), newLine, ..._lines.slice(cursorLine + 1)],
				cursorLine,
				cursorCol: newCursorCol,
			};
		},
	};
}

export function createMentionItemsLoader(
	ensureFinder: (cwd: string) => Promise<FileFinder>,
	getActiveCwd: () => string,
) {
	return async function getMentionItems(
		query: string,
		signal: AbortSignal,
	): Promise<AutocompleteItem[]> {
		if (signal.aborted) return [];
		const f = await ensureFinder(getActiveCwd());
		if (signal.aborted) return [];

		const result = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
		if (!result.ok) return [];

		return result.value.items.slice(0, MENTION_MAX_RESULTS).map((mixed: MixedItem) => {
			if (mixed.type === "directory") {
				return {
					value: buildAtCompletionValue(mixed.item.relativePath),
					label: mixed.item.dirName,
					description: mixed.item.relativePath,
				};
			}
			return {
				value: buildAtCompletionValue(mixed.item.relativePath),
				label: mixed.item.fileName,
				description: mixed.item.relativePath,
			};
		});
	};
}

export function registerAutocompleteProvider(
	ctx: {
		ui: {
			addAutocompleteProvider?: (
				factory: (current: AutocompleteProvider) => AutocompleteProvider,
			) => void;
		};
	},
	getMentionItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): void {
	if (typeof ctx.ui.addAutocompleteProvider !== "function") return;

	ctx.ui.addAutocompleteProvider((current) => {
		const mentionProvider = createFffMentionProvider(getMentionItems);

		return {
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				try {
					const mentionResult = await mentionProvider.getSuggestions(
						lines,
						cursorLine,
						cursorCol,
						options,
					);
					if (mentionResult) return mentionResult;
				} catch {
					// Delegate when FFF lookup is unavailable.
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return (
					current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
				);
			},
		};
	});
}
