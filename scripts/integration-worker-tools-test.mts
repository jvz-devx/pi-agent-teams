/**
 * Integration test: validate /team-tools worker tool allowlist behavior end-to-end.
 *
 * Covers PLAN.md acceptance points:
 * - default worker spawn remains unchanged/no extra policy
 * - hard-blocked recursive/control tools are rejected/filtered
 * - codex_generate_image can be allowlisted with an explicit extension
 * - /team env output reflects the same worker tool policy
 * - spawning still succeeds after applying the extra worker policy
 *
 * Usage:
 *   npx tsx scripts/integration-worker-tools-test.mts
 *   npx tsx scripts/integration-worker-tools-test.mts --timeoutSec 90
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { sleep, terminateAll } from "./lib/pi-workers.js";

interface NotifyEvent {
	notifyType: string;
	message: string;
}

type RpcCommand = { id?: string; type: "get_state" } | { id?: string; type: "prompt"; message: string };

type RpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

type PendingRequest = {
	resolve: (v: RpcResponse) => void;
	reject: (e: Error) => void;
	timeout: NodeJS.Timeout;
};

function parseArgs(argv: readonly string[]): { timeoutSec: number } {
	let timeoutSec = 90;
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--timeoutSec") {
			const v = argv[i + 1];
			if (v) timeoutSec = Number.parseInt(v, 10);
			i += 1;
		}
	}
	if (!Number.isFinite(timeoutSec) || timeoutSec < 20) timeoutSec = 90;
	return { timeoutSec };
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function safeJsonParse(line: string): unknown | null {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return null;
	}
}

function isRpcResponse(v: unknown): v is RpcResponse {
	if (!isRecord(v)) return false;
	if (v.type !== "response") return false;
	if (typeof v.command !== "string") return false;
	if (typeof v.success !== "boolean") return false;
	if (v.id !== undefined && typeof v.id !== "string") return false;
	if (v.error !== undefined && typeof v.error !== "string") return false;
	return true;
}

function isNotifyExtensionUiRequest(v: unknown): v is { notifyType: string; message: string } {
	if (!isRecord(v)) return false;
	if (v.type !== "extension_ui_request") return false;
	if (v.method !== "notify") return false;
	if (typeof v.message !== "string") return false;
	if (typeof v.notifyType !== "string") return false;
	return true;
}

function messagesContain(events: readonly NotifyEvent[], needle: string): boolean {
	const n = needle.toLowerCase();
	return events.some((e) => e.message.toLowerCase().includes(n));
}

async function waitFor(
	fn: () => boolean | Promise<boolean>,
	opts: { timeoutMs: number; pollMs: number; label: string },
): Promise<void> {
	const deadline = Date.now() + opts.timeoutMs;
	while (Date.now() < deadline) {
		if (await fn()) return;
		await sleep(opts.pollMs);
	}
	throw new Error(`Timeout waiting for ${opts.label}`);
}

function extractSessionId(resp: RpcResponse): string | null {
	if (!isRecord(resp.data)) return null;
	const sessionId = resp.data.sessionId;
	return typeof sessionId === "string" ? sessionId : null;
}

function readConfig(teamDir: string): unknown | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")) as unknown;
	} catch {
		return null;
	}
}

function getMember(teamDir: string, name: string): Record<string, unknown> | null {
	const cfg = readConfig(teamDir);
	if (!isRecord(cfg) || !Array.isArray(cfg.members)) return null;
	const member = cfg.members.find((m: unknown) => isRecord(m) && m.name === name);
	return isRecord(member) ? member : null;
}

function memberStatus(teamDir: string, name: string): string | null {
	const member = getMember(teamDir, name);
	return member && typeof member.status === "string" ? member.status : null;
}

function memberMeta(teamDir: string, name: string): Record<string, unknown> | null {
	const member = getMember(teamDir, name);
	return member && isRecord(member.meta) ? member.meta : null;
}

const { timeoutSec } = parseArgs(process.argv.slice(2));

const teamsRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-worker-tools-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const entryPath = path.join(repoRoot, "extensions", "teams", "index.ts");
const fakeExtensionPath = path.join(teamsRootDir, "fake-worker-tool-extension.js");
const workerArgvPath = path.join(teamsRootDir, "painter-worker-argv.json");

if (!fs.existsSync(entryPath)) throw new Error(`Teams extension entry not found: ${entryPath}`);
fs.writeFileSync(
	fakeExtensionPath,
	[
		'import * as fs from "node:fs";',
		'export default function(pi) {',
		'  pi.on("session_start", () => {',
		'    if (process.env.PI_TEAMS_WORKER_ARGV_FILE) {',
		'      fs.appendFileSync(process.env.PI_TEAMS_WORKER_ARGV_FILE, JSON.stringify({ agent: process.env.PI_TEAMS_AGENT_NAME, argv: process.argv, activeTools: pi.getActiveTools?.() ?? [] }) + "\\n", "utf8");',
		'    }',
		'  });',
		'  pi.registerTool({',
		'    name: "fake_worker_tool",',
		'    label: "Fake Worker Tool",',
		'    description: "Fake tool for worker allowlist integration tests",',
		'    parameters: { type: "object", properties: {}, additionalProperties: false },',
		'    async execute() { return { content: [{ type: "text", text: "fake-worker-tool-ok" }] }; },',
		'  });',
		'}',
		'',
	].join("\n"),
	"utf8",
);

console.log(`teamsRootDir: ${teamsRootDir}`);
console.log(`entryPath: ${entryPath}`);
console.log(`fakeExtensionPath: ${fakeExtensionPath}`);

const leaderEnv = {
	...process.env,
	PI_TEAMS_ROOT_DIR: teamsRootDir,
	PI_TEAMS_WORKER: "0",
	PI_TEAMS_TEAM_ID: "",
	PI_TEAMS_AGENT_NAME: "",
	PI_TEAMS_TASK_LIST_ID: "",
	PI_TEAMS_LEAD_NAME: "",
	PI_TEAMS_AUTO_CLAIM: "",
	PI_TEAMS_WORKER_ARGV_FILE: workerArgvPath,
};

const leaderArgs = [
	"--mode",
	"rpc",
	"--no-session",
	"--provider",
	"openai-codex",
	"--model",
	"gpt-5.1-codex-mini",
	"--thinking",
	"minimal",
	"--no-extensions",
	"-e",
	entryPath,
];

const leader = spawn("pi", leaderArgs, {
	cwd: repoRoot,
	env: leaderEnv,
	stdio: ["pipe", "pipe", "pipe"],
});

const procs: ChildProcess[] = [leader];
const notifications: NotifyEvent[] = [];
const pending = new Map<string, PendingRequest>();
let nextId = 1;
let stderr = "";

leader.stderr.on("data", (d: Buffer | string) => {
	stderr += d.toString();
});

leader.on("close", () => {
	for (const [id, p] of pending.entries()) {
		clearTimeout(p.timeout);
		p.reject(new Error(`Leader closed before response (id=${id}). stderr=${stderr}`));
	}
	pending.clear();
});

const rl = readline.createInterface({ input: leader.stdout, crlfDelay: Infinity });
rl.on("line", (line: string) => {
	const obj = safeJsonParse(line);
	if (obj === null) return;

	if (isRpcResponse(obj)) {
		if (!obj.id) return;
		const req = pending.get(obj.id);
		if (!req) return;
		pending.delete(obj.id);
		clearTimeout(req.timeout);
		req.resolve(obj);
		return;
	}

	if (isNotifyExtensionUiRequest(obj)) {
		notifications.push({ notifyType: obj.notifyType, message: obj.message });
		console.log(`[notify:${obj.notifyType}] ${obj.message}`);
	}
});

const send = async (command: RpcCommand): Promise<RpcResponse> => {
	const id = command.id ?? `req-${nextId++}`;
	leader.stdin.write(JSON.stringify({ ...command, id }) + "\n");

	return await new Promise<RpcResponse>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (!pending.has(id)) return;
			pending.delete(id);
			reject(new Error(`Timeout waiting for response to ${command.type}. stderr=${stderr}`));
		}, timeoutSec * 1000);
		pending.set(id, { resolve, reject, timeout });
	});
};

const sendPrompt = async (message: string): Promise<void> => {
	console.log(`prompt: ${message}`);
	const resp = await send({ type: "prompt", message });
	if (!resp.success) throw new Error(`Prompt failed: ${resp.error ?? "unknown error"}`);
};

let teamDir = "";

try {
	const state = await send({ type: "get_state" });
	if (!state.success) throw new Error(`get_state failed: ${state.error ?? "unknown error"}`);
	const leaderSessionId = extractSessionId(state);
	if (!leaderSessionId) throw new Error(`No sessionId in get_state response: ${JSON.stringify(state)}`);
	teamDir = path.join(teamsRootDir, leaderSessionId);
	console.log(`leaderSessionId: ${leaderSessionId}`);
	console.log(`teamDir: ${teamDir}`);

	await sendPrompt("/team spawn baseworker fresh");
	await waitFor(() => memberStatus(teamDir, "baseworker") === "online", {
		timeoutMs: timeoutSec * 1000,
		pollMs: 250,
		label: "baseworker online",
	});
	const defaultConfig = readConfig(teamDir);
	assert(!isRecord(defaultConfig) || defaultConfig.workerTools === undefined, "default team config should not enable extra worker tools");
	console.log("OK: default spawn works without extra worker tool policy");

	const beforeBlocked = notifications.length;
	await sendPrompt("/team-tools add teams");
	await sleep(250);
	const blockedEvents = notifications.slice(beforeBlocked);
	assert(messagesContain(blockedEvents, "blocked") || messagesContain(blockedEvents, "not allowed"), "expected hard-block rejection notification");
	console.log("OK: hard-blocked team control tool rejected");

	const beforeInjected = notifications.length;
	await sendPrompt("/team-tools add safe,teams");
	await sleep(250);
	const injectedEvents = notifications.slice(beforeInjected);
	assert(messagesContain(injectedEvents, "invalid worker tool name"), "expected comma-injection tool name rejection notification");
	console.log("OK: comma-injected worker tool name rejected");

	const beforeExtraArgs = notifications.length;
	await sendPrompt("/team-tools add fake_worker_tool typo_arg");
	await sleep(250);
	const extraArgEvents = notifications.slice(beforeExtraArgs);
	assert(messagesContain(extraArgEvents, "usage"), "expected extra positional args to be rejected");
	console.log("OK: extra positional args rejected");

	await sendPrompt("/team-tools add codex_generate_image --extension pi-codex-image-gen");
	await sendPrompt("/team-tools list");
	await sleep(250);
	assert(messagesContain(notifications, "codex_generate_image"), "expected allowlisted tool in /team-tools list output");
	assert(messagesContain(notifications, "pi-codex-image-gen"), "expected extra extension in /team-tools list output");
	console.log("OK: codex_generate_image allowlist command recorded tool and extension");

	const beforeEnv = notifications.length;
	await sendPrompt("/team env painter");
	await sleep(250);
	const envOutput = notifications.slice(beforeEnv).map((e) => e.message).join("\n");
	assert(envOutput.includes("codex_generate_image"), `/team env missing codex_generate_image: ${envOutput}`);
	assert(envOutput.includes("--tools"), `/team env missing --tools: ${envOutput}`);
	assert(envOutput.includes("-e") && envOutput.includes("pi-codex-image-gen"), `/team env missing extra extension: ${envOutput}`);
	console.log("OK: /team env reflects worker tool policy");

	await sendPrompt(`/team-tools add fake_worker_tool --extension ${fakeExtensionPath}`);
	await sendPrompt("/team-tools list");
	await sleep(250);
	assert(messagesContain(notifications, "fake_worker_tool"), "expected fake worker tool in /team-tools list output");
	assert(messagesContain(notifications, fakeExtensionPath), "expected fake extension path in /team-tools list output");
	console.log("OK: fake worker tool allowlist command recorded tool and extension");

	await sendPrompt("/team spawn painter fresh");
	await waitFor(() => memberStatus(teamDir, "painter") === "online", {
		timeoutMs: timeoutSec * 1000,
		pollMs: 250,
		label: "painter online",
	});
	await waitFor(() => Array.isArray(memberMeta(teamDir, "painter")?.workerTools), {
		timeoutMs: timeoutSec * 1000,
		pollMs: 250,
		label: "painter spawn metadata",
	});
	const painterMeta = memberMeta(teamDir, "painter");
	const workerTools = painterMeta?.workerTools;
	if (!Array.isArray(workerTools)) throw new Error(`painter meta missing workerTools: ${JSON.stringify(painterMeta)}`);
	assert(workerTools.includes("codex_generate_image"), `painter workerTools missing codex_generate_image: ${JSON.stringify(workerTools)}`);
	assert(workerTools.includes("fake_worker_tool"), `painter workerTools missing fake_worker_tool: ${JSON.stringify(workerTools)}`);
	assert(!workerTools.includes("teams"), `painter workerTools includes hard-blocked teams: ${JSON.stringify(workerTools)}`);
	const workerExtensionArgs = painterMeta?.workerExtensionArgs;
	if (!Array.isArray(workerExtensionArgs)) throw new Error(`painter meta missing workerExtensionArgs: ${JSON.stringify(painterMeta)}`);
	assert(workerExtensionArgs.includes("--no-extensions"), `painter workerExtensionArgs missing --no-extensions isolation: ${JSON.stringify(workerExtensionArgs)}`);
	assert(workerExtensionArgs.includes(entryPath), `painter workerExtensionArgs missing teams extension entry: ${JSON.stringify(workerExtensionArgs)}`);
	assert(workerExtensionArgs.includes(fakeExtensionPath), `painter workerExtensionArgs missing fake extension entry: ${JSON.stringify(workerExtensionArgs)}`);
	console.log("OK: spawn metadata records extra worker tools and extension args passed to child");

	await sendPrompt("/team shutdown");
	console.log("PASS: integration worker tools test passed");
} finally {
	try {
		rl.close();
	} catch {
		// ignore
	}
	await terminateAll(procs);
	try {
		fs.rmSync(teamsRootDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}
