import * as fs from "node:fs";
import * as path from "node:path";

export const PLAN_DIR_NAME = "plans";
export const PLAN_FILE_MAX = 10;

function get_pi_home(): string {
	const home =
		process.env.PI_HOME ||
		path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
	return home;
}

export function get_plans_dir(): string {
	return path.join(get_pi_home(), PLAN_DIR_NAME);
}

function ensure_plans_dir(): void {
	fs.mkdirSync(get_plans_dir(), { recursive: true });
}

function make_plan_filename(): string {
	const timestamp = Date.now();
	const date = new Date(timestamp).toISOString().replace(/[:.]/g, "-").slice(0, -5);
	return `plan-${date}-${timestamp}.txt`;
}

export interface PlanFileMeta {
	readonly path: string;
	readonly filename: string;
	readonly createdAt: number;
}

export function write_plan_file(planText: string, meta?: { fromSession?: string }): PlanFileMeta {
	ensure_plans_dir();
	const filename = make_plan_filename();
	const filePath = path.join(get_plans_dir(), filename);
	const header = meta?.fromSession ? `<!-- parent-session: ${meta.fromSession} -->\n` : "";
	fs.writeFileSync(filePath, `${header}${planText}`, "utf-8");
	prune_plan_files(PLAN_FILE_MAX);
	return { path: filePath, filename, createdAt: Date.now() };
}

export function read_plan_file(filePath: string): string {
	return fs.readFileSync(filePath, "utf-8");
}

export function list_plan_files(): { path: string; mtime: number }[] {
	const dir = get_plans_dir();
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.startsWith("plan-") && f.endsWith(".txt"))
			.map((f) => {
				const p = path.join(dir, f);
				const stat = fs.statSync(p);
				return { path: p, mtime: stat.mtimeMs };
			})
			.sort((a, b) => a.mtime - b.mtime);
	} catch {
		return [];
	}
}

export function prune_plan_files(max = PLAN_FILE_MAX): void {
	const files = list_plan_files();
	if (files.length <= max) return;
	const toDelete = files.slice(0, files.length - max);
	for (const f of toDelete) {
		try {
			fs.unlinkSync(f.path);
		} catch {
			// ignore
		}
	}
}
