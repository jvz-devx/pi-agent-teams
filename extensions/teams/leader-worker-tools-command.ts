import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getTeamDir } from "./paths.js";
import type { TeamConfig, WorkerToolsPolicy } from "./team-config.js";
import { updateWorkerToolsPolicy } from "./team-config.js";
import {
	formatWorkerToolsPolicy,
	isValidWorkerToolName,
	isWorkerToolHardBlocked,
	WORKER_TOOL_HARD_BLOCKLIST,
} from "./worker-tool-policy.js";

const HELP = [
	"Usage:",
	"  /team-tools list",
	"  /team-tools add <toolName> [--extension <extensionSpec>]",
	"  /team-tools remove <toolName>",
	"  /team-tools clear",
	"  /team-tools blocked",
	"  /team-tools inherit-safe on|off",
	"",
	"New workers inherit this policy. Existing workers must be restarted.",
].join("\n");

function unique(values: readonly string[] | undefined): string[] {
	const result: string[] = [];
	for (const raw of values ?? []) {
		const value = raw.trim();
		if (value && !result.includes(value)) result.push(value);
	}
	return result;
}

function parseExtension(rest: string[]): { args: string[]; extensionSpec?: string; error?: string } {
	const args: string[] = [];
	let extensionSpec: string | undefined;
	for (let i = 0; i < rest.length; i += 1) {
		const part = rest[i];
		if (!part) continue;
		if (part === "--extension") {
			const next = rest[i + 1];
			if (!next) return { args, error: "Missing value for --extension" };
			extensionSpec = next;
			i += 1;
			continue;
		}
		args.push(part);
	}
	return { args, extensionSpec };
}

function renderPolicy(policy: WorkerToolsPolicy | null | undefined): string {
	return ["Worker tool policy:", ...formatWorkerToolsPolicy(policy)].join("\n");
}

export async function handleTeamToolsCommand(opts: {
	ctx: ExtensionCommandContext;
	args: string;
	teamId: string;
	getTeamConfig: () => TeamConfig | null;
	refreshTasks: () => Promise<void>;
}): Promise<void> {
	const { ctx, args, teamId, getTeamConfig, refreshTasks } = opts;
	const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
	const [subRaw, ...restRaw] = parts;
	const sub = subRaw ?? "list";
	const teamDir = getTeamDir(teamId);

	if (sub === "help" || sub === "--help" || sub === "-h") {
		ctx.ui.notify(HELP, "info");
		return;
	}

	if (sub === "blocked") {
		ctx.ui.notify(`Hard-blocked worker tools:\n${WORKER_TOOL_HARD_BLOCKLIST.join("\n")}`, "info");
		return;
	}

	if (sub === "list" || sub === "") {
		await refreshTasks();
		ctx.ui.notify(renderPolicy(getTeamConfig()?.workerTools), "info");
		return;
	}

	if (sub === "add") {
		const parsed = parseExtension(restRaw);
		if (parsed.error) {
			ctx.ui.notify(parsed.error, "error");
			return;
		}
		const toolName = parsed.args[0]?.trim();
		if (!toolName || parsed.args.length !== 1) {
			ctx.ui.notify("Usage: /team-tools add <toolName> [--extension <extensionSpec>]", "error");
			return;
		}
		if (!isValidWorkerToolName(toolName)) {
			ctx.ui.notify(`Invalid worker tool name: ${toolName}. Use only letters, numbers, underscore, dot, colon, and hyphen.`, "error");
			return;
		}
		if (isWorkerToolHardBlocked(toolName)) {
			ctx.ui.notify(`Refusing to allow hard-blocked worker tool: ${toolName}`, "error");
			return;
		}

		const updated = await updateWorkerToolsPolicy(teamDir, (current) => ({
			...current,
			extraTools: unique([...(current.extraTools ?? []), toolName]),
			extraExtensions: parsed.extensionSpec ? unique([...(current.extraExtensions ?? []), parsed.extensionSpec]) : unique(current.extraExtensions),
		}));
		await refreshTasks();
		ctx.ui.notify(`${renderPolicy(updated?.workerTools)}\n\nNew workers will use this policy; restart existing workers to apply it.`, "info");
		return;
	}

	if (sub === "remove") {
		const toolName = restRaw[0]?.trim();
		if (!toolName) {
			ctx.ui.notify("Usage: /team-tools remove <toolName>", "error");
			return;
		}
		const updated = await updateWorkerToolsPolicy(teamDir, (current) => ({
			...current,
			extraTools: unique(current.extraTools).filter((tool) => tool !== toolName),
		}));
		await refreshTasks();
		ctx.ui.notify(`${renderPolicy(updated?.workerTools)}\n\nRemoved tool '${toolName}'. Extra extensions are left configured; use clear to remove all.`, "info");
		return;
	}

	if (sub === "clear") {
		const updated = await updateWorkerToolsPolicy(teamDir, () => undefined);
		await refreshTasks();
		ctx.ui.notify(renderPolicy(updated?.workerTools), "info");
		return;
	}

	if (sub === "inherit-safe") {
		const value = restRaw[0];
		if (value !== "on" && value !== "off") {
			ctx.ui.notify("Usage: /team-tools inherit-safe on|off", "error");
			return;
		}
		const updated = await updateWorkerToolsPolicy(teamDir, (current) => ({
			...current,
			inheritSafeExtensions: value === "on",
		}));
		await refreshTasks();
		ctx.ui.notify(renderPolicy(updated?.workerTools), "info");
		return;
	}

	ctx.ui.notify(`Unknown /team-tools subcommand: ${sub}\n\n${HELP}`, "error");
}
