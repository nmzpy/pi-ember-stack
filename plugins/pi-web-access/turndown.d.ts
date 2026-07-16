declare module "turndown" {
	export interface TurndownServiceOptions {
		headingStyle?: "setext" | "atx";
		hr?: string;
		bulletListMarker?: "-" | "+" | "*";
		codeBlockStyle?: "indented" | "fenced";
		fence?: string;
		emDelimiter?: string;
		strongDelimiter?: string;
		linkStyle?: "inlined" | "referenced";
		linkReferenceStyle?: "full" | "collapsed" | "shortcut";
		blankReplacement?: (content: string, node: unknown) => string;
		keepReplacement?: (content: string, node: unknown) => string;
		defaultReplacement?: (content: string, node: unknown) => string;
	}

	export default class TurndownService {
		constructor(options?: TurndownServiceOptions);
		turndown(html: string): string;
	}
}
