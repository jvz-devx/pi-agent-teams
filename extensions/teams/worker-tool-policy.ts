import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { WorkerToolsPolicy } from "./team-config.js";
import { WORKER_COMMUNICATION_TOOLS } from "./worker-tools.js";

export const WORKER_TOOL_HARD_BLOCKLIST = ["teams", "Agent", "get_subagent_result", "steer_subagent"] as const;

const HARD_BLOCKED_TOOLS = new Set<string>(WORKER_TOOL_HARD_BLOCKLIST);
const WORKER_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export interface NormalizedWorkerToolsPolicy {
	extraTools: string[];
	extraExtensions: string[];
	inheritSafeExtensions: boolean;
	blockedTools: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function normalizeName(v: string): string {
	return v.trim();
}

export function isValidWorkerToolName(tool: string): boolean {
	return tool.length > 0 && tool === normalizeName(tool) && WORKER_TOOL_NAME_PATTERN.test(tool);
}

export function isWorkerToolHardBlocked(tool: string): boolean {
	return HARD_BLOCKED_TOOLS.has(normalizeName(tool));
}

export function validateWorkerToolName(tool: string): string | null {
	const normalized = normalizeName(tool);
	if (!normalized) return "Tool name is required.";
	if (!isValidWorkerToolName(tool)) return "Tool names may only contain letters, numbers, underscore, dot, colon, and dash.";
	if (isWorkerToolHardBlocked(normalized)) return `Tool '${normalized}' is hard-blocked for workers.`;
	return null;
}

function uniqueNormalized(values: readonly string[] | undefined): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const raw of values ?? []) {
		const value = normalizeName(raw);
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function addSafeTool(result: string[], blockedTools: string[], raw: string): void {
	const normalized = normalizeName(raw);
	if (!normalized || !isValidWorkerToolName(raw)) return;
	if (isWorkerToolHardBlocked(normalized)) {
		if (!blockedTools.includes(normalized)) blockedTools.push(normalized);
		return;
	}
	if (!result.includes(normalized)) result.push(normalized);
}

function uniqueCoercedToolNames(values: readonly string[] | undefined): string[] {
	const result: string[] = [];
	for (const raw of values ?? []) {
		const tool = normalizeName(raw);
		if (!isValidWorkerToolName(raw) || result.includes(tool)) continue;
		result.push(tool);
	}
	return result;
}

function uniqueSafeToolNames(values: readonly string[] | undefined): { tools: string[]; blockedTools: string[] } {
	const tools: string[] = [];
	const blockedTools: string[] = [];
	for (const raw of values ?? []) addSafeTool(tools, blockedTools, raw);
	return { tools, blockedTools };
}

export function coerceWorkerToolsPolicy(v: unknown): WorkerToolsPolicy | undefined {
	if (!isRecord(v)) return undefined;
	const extraToolValues = Array.isArray(v.extraTools) ? v.extraTools.filter((x): x is string => typeof x === "string") : [];
	const extraTools = uniqueCoercedToolNames(extraToolValues);
	const extraExtensions = Array.isArray(v.extraExtensions) ? uniqueNormalized(v.extraExtensions.filter((x): x is string => typeof x === "string")) : [];
	const inheritSafeExtensions = v.inheritSafeExtensions === true;
	if (extraTools.length === 0 && extraExtensions.length === 0 && !inheritSafeExtensions) return undefined;
	return { extraTools, extraExtensions, inheritSafeExtensions };
}

export function normalizeWorkerToolsPolicy(policy: WorkerToolsPolicy | null | undefined): NormalizedWorkerToolsPolicy {
	const safe = uniqueSafeToolNames(policy?.extraTools);
	return {
		extraTools: safe.tools,
		extraExtensions: uniqueNormalized(policy?.extraExtensions),
		inheritSafeExtensions: policy?.inheritSafeExtensions === true,
		blockedTools: safe.blockedTools,
	};
}

export function appendWorkerPolicyTools(baseTools: readonly string[], policy: WorkerToolsPolicy | null | undefined): { tools: string[]; blockedTools: string[] } {
	const normalized = normalizeWorkerToolsPolicy(policy);
	const tools: string[] = [];
	const blockedTools = [...normalized.blockedTools];
	for (const raw of baseTools) addSafeTool(tools, blockedTools, raw);
	for (const tool of normalized.extraTools) {
		if (!tools.includes(tool)) tools.push(tool);
	}
	for (const tool of WORKER_COMMUNICATION_TOOLS) {
		if (!tools.includes(tool)) tools.push(tool);
	}
	return { tools, blockedTools };
}

function pathExists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

function firstExisting(paths: string[]): string | null {
	for (const p of paths) {
		if (pathExists(p)) return p;
	}
	return null;
}

function resolvePackageRoot(spec: string, cwd: string): string | null {
	try {
		const req = createRequire(path.join(cwd, "pi-agent-teams-worker-policy.cjs"));
		return path.dirname(req.resolve(path.join(spec, "package.json")));
	} catch {
		// ignore
	}

	const candidates: string[] = [];
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (globalRoot) candidates.push(path.join(globalRoot, spec));
	} catch {
		// ignore
	}
	candidates.push(path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", spec));
	return firstExisting(candidates);
}

export function resolveWorkerExtensionEntry(spec: string, cwd: string): string | null {
	const trimmed = normalizeName(spec);
	if (!trimmed) return null;

	const direct = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
	let root: string | null = null;
	if (pathExists(direct)) root = direct;
	else root = resolvePackageRoot(trimmed, cwd);
	if (!root) return null;

	let stat: fs.Stats;
	try {
		stat = fs.statSync(root);
	} catch {
		return null;
	}
	if (stat.isFile()) return root;

	const packageJsonPath = path.join(root, "package.json");
	if (pathExists(packageJsonPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { pi?: { extensions?: unknown }; main?: unknown };
			const extensions = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions.filter((x): x is string => typeof x === "string") : [];
			const ext = firstExisting(extensions.map((entry) => path.resolve(root, entry)));
			if (ext) return ext;
			if (typeof pkg.main === "string") {
				const main = path.resolve(root, pkg.main);
				if (pathExists(main)) return main;
			}
		} catch {
			// ignore malformed package metadata here; fallback below.
		}
	}

	return firstExisting([path.join(root, "index.ts"), path.join(root, "index.js")]);
}

export function buildWorkerExtensionArgs(opts: {
	teamsEntry: string | null;
	policy: WorkerToolsPolicy | null | undefined;
	cwd: string;
}): { args: string[]; warnings: string[] } {
	const normalized = normalizeWorkerToolsPolicy(opts.policy);
	const warnings: string[] = [];
	const extraEntries: string[] = [];
	for (const spec of normalized.extraExtensions) {
		const entry = resolveWorkerExtensionEntry(spec, opts.cwd);
		if (!entry) {
			warnings.push(`Could not resolve worker extension '${spec}'; requested extra tools from it may be unavailable.`);
			continue;
		}
		if (!extraEntries.includes(entry)) extraEntries.push(entry);
	}

	const entries = opts.teamsEntry ? [opts.teamsEntry, ...extraEntries.filter((entry) => entry !== opts.teamsEntry)] : extraEntries;
	if (normalized.inheritSafeExtensions) {
		if (entries.length > 0) warnings.push("workerTools.inheritSafeExtensions=true: loading normal extension discovery plus explicit worker extensions.");
		return { args: entries.flatMap((entry) => ["-e", entry]), warnings };
	}

	if (!opts.teamsEntry) {
		if (extraEntries.length > 0) warnings.push("Could not resolve teams extension entry; not using --no-extensions so worker can still load the teams extension via normal discovery.");
		return { args: extraEntries.flatMap((entry) => ["-e", entry]), warnings };
	}

	return { args: ["--no-extensions", ...entries.flatMap((entry) => ["-e", entry])], warnings };
}

export function formatWorkerToolsPolicy(policy: WorkerToolsPolicy | null | undefined): string[] {
	const normalized = normalizeWorkerToolsPolicy(policy);
	return [
		`extraTools: ${normalized.extraTools.length ? normalized.extraTools.join(",") : "(none)"}`,
		`extraExtensions: ${normalized.extraExtensions.length ? normalized.extraExtensions.join(",") : "(none)"}`,
		`inheritSafeExtensions: ${normalized.inheritSafeExtensions ? "on" : "off"}`,
		...(normalized.blockedTools.length ? [`blocked/ignored: ${normalized.blockedTools.join(",")}`] : []),
	];
}
