function bash_cd_dir(command: string): string | undefined {
	const match = /^\s*cd\s+([^\s&]+)\s*&&\s*/.exec(command);
	return match?.[1];
}

/**
 * Detect bash commands that are grep invocations (optionally preceded by
 * `cd <dir> &&`). Returns the extracted pattern and path so the call
 * can render as "Search" and join the discovery group.
 */
export function bashGrepInfo(command: string): { pattern: string; path: string } | undefined {
	const stripped = command.replace(/^\s*cd\s+([^\s&]+)\s*&&\s*/, "");
	if (!/^\s*grep\b/.test(stripped)) return undefined;
	const cdDir = bash_cd_dir(command);
	const path = cdDir ?? ".";
	const afterGrep = stripped.replace(/^\s*grep\s+/, "");
	const cmdBeforePipe = afterGrep.split(/\s+[|>]/)[0];
	const parts = cmdBeforePipe.trim().split(/\s+/);
	let pattern: string | undefined;
	for (const part of parts) {
		if (!part.startsWith("-")) {
			pattern = part;
			break;
		}
	}
	if (!pattern) return undefined;
	pattern = pattern.replace(/^["']|["']$/g, "");
	return { pattern, path };
}

/**
 * Rewrite a bash grep command to an equivalent rg (ripgrep) command.
 * Returns the rewritten command, or undefined if the command is not a
 * simple grep invocation that can be safely converted.
 */
export function rewriteGrepToRg(command: string): string | undefined {
	const cdMatch = /^(\s*cd\s+([^\s&]+)\s*&&\s*)(.*)$/.exec(command);
	const prefix = cdMatch?.[1] ?? "";
	const body = cdMatch?.[3] ?? command;
	if (!/^\s*grep\b/.test(body)) return undefined;
	const beforePipe = body.split(/\s+\|/)[0].trim();
	const afterGrep = beforePipe.replace(/^\s*grep\s+/, "");
	// Strip stderr redirects (2>/dev/null, 2>&1, etc.) so they don't
	// become false path arguments.
	const cleaned = afterGrep.replace(/\s+2>(?:&\d+|\/dev\/null|\S+)/g, "").trim();
	const tokens = cleaned.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
	if (!tokens) return undefined;

	const rgArgs: string[] = ["rg"];
	let pattern: string | undefined;
	const paths: string[] = [];
	const includeGlobs: string[] = [];
	const excludeGlobs: string[] = [];
	let caseInsensitive = false;
	let fixedStrings = false;
	let wordRegex = false;
	let countOnly = false;
	let filesOnly = false;
	let invertMatch = false;
	let contextAfter = 0;
	let contextBefore = 0;
	let contextBoth = 0;
	let lineNumber = false;
	let noFilename = false;

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === "-i" || tok === "--ignore-case") {
			caseInsensitive = true;
			continue;
		}
		if (tok === "-F" || tok === "--fixed-strings") {
			fixedStrings = true;
			continue;
		}
		if (tok === "-w" || tok === "--word-regexp") {
			wordRegex = true;
			continue;
		}
		if (tok === "-c" || tok === "--count") {
			countOnly = true;
			continue;
		}
		if (tok === "-l" || tok === "--files-with-matches") {
			filesOnly = true;
			continue;
		}
		if (tok === "-v" || tok === "--invert-match") {
			invertMatch = true;
			continue;
		}
		if (tok === "-n" || tok === "--line-number") {
			lineNumber = true;
			continue;
		}
		if (tok === "-h" || tok === "--no-filename") {
			noFilename = true;
			continue;
		}
		if (tok === "-E" || tok === "--extended-regexp") {
			continue;
		}
		if (tok === "-r" || tok === "-R" || tok === "--recursive") {
			continue;
		}
		if (tok === "-s" || tok === "--no-messages") {
			continue;
		}
		if (tok === "-A") {
			contextAfter = parseInt(tokens[++i] ?? "0", 10) || 0;
			continue;
		}
		if (tok === "-B") {
			contextBefore = parseInt(tokens[++i] ?? "0", 10) || 0;
			continue;
		}
		if (tok === "-C") {
			contextBoth = parseInt(tokens[++i] ?? "0", 10) || 0;
			continue;
		}
		if (tok.startsWith("-A")) {
			contextAfter = parseInt(tok.slice(2), 10) || 0;
			continue;
		}
		if (tok.startsWith("-B")) {
			contextBefore = parseInt(tok.slice(2), 10) || 0;
			continue;
		}
		if (tok.startsWith("-C")) {
			contextBoth = parseInt(tok.slice(2), 10) || 0;
			continue;
		}
		if (tok === "--include") {
			includeGlobs.push(tokens[++i] ?? "");
			continue;
		}
		if (tok.startsWith("--include=")) {
			includeGlobs.push(tok.slice(10));
			continue;
		}
		if (tok === "--exclude") {
			excludeGlobs.push(tokens[++i] ?? "");
			continue;
		}
		if (tok.startsWith("--exclude=")) {
			excludeGlobs.push(tok.slice(10));
			continue;
		}
		if (tok === "--exclude-dir") {
			excludeGlobs.push(`${tokens[++i] ?? ""}/`);
			continue;
		}
		if (tok.startsWith("--exclude-dir=")) {
			excludeGlobs.push(`${tok.slice(13)}/`);
			continue;
		}
		// Handle combined short flags like -rn, -in, -rnI, etc.
		if (/^-[a-zA-Z]{2,}$/.test(tok)) {
			let bail = false;
			for (const ch of tok.slice(1)) {
				switch (ch) {
					case "i":
						caseInsensitive = true;
						break;
					case "F":
						fixedStrings = true;
						break;
					case "w":
						wordRegex = true;
						break;
					case "c":
						countOnly = true;
						break;
					case "l":
						filesOnly = true;
						break;
					case "v":
						invertMatch = true;
						break;
					case "n":
						lineNumber = true;
						break;
					case "h":
						noFilename = true;
						break;
					case "E":
					case "r":
					case "R":
					case "s":
						break;
					default:
						bail = true;
						break;
				}
				if (bail) break;
			}
			if (bail) return undefined;
			continue;
		}
		if (tok.startsWith("-")) {
			// Unknown flag — bail to be safe.
			return undefined;
		}
		if (pattern === undefined) {
			pattern = tok.replace(/^["']|["']$/g, "");
		} else {
			paths.push(tok.replace(/^["']|["']$/g, ""));
		}
	}
	if (pattern === undefined) return undefined;

	if (caseInsensitive) rgArgs.push("-i");
	if (fixedStrings) rgArgs.push("-F");
	if (wordRegex) rgArgs.push("-w");
	if (countOnly) rgArgs.push("-c");
	if (filesOnly) rgArgs.push("-l");
	if (invertMatch) rgArgs.push("-v");
	if (lineNumber || noFilename) rgArgs.push("-n");
	if (noFilename) rgArgs.push("--no-filename");
	if (contextAfter > 0) rgArgs.push("-A", String(contextAfter));
	if (contextBefore > 0) rgArgs.push("-B", String(contextBefore));
	if (contextBoth > 0) rgArgs.push("-C", String(contextBoth));
	for (const g of includeGlobs) rgArgs.push("-g", g);
	for (const g of excludeGlobs) rgArgs.push("-g", `!${g}`);
	// rg is recursive by default; add -- to separate pattern from paths.
	rgArgs.push("--", pattern);
	for (const p of paths) rgArgs.push(p);

	const rgCmd = rgArgs
		.map((a) => {
			return /[\s'"!]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
		})
		.join(" ");
	return prefix + rgCmd;
}
