#!/usr/bin/env node
// HiveBoss Connect plugin: the Bee's answer of a terminal Bee session (bee-sessions-from-terminal; Hamza, 2026-11-17,
// the card's section 7: "only the Bee's steps and answer" show in HiveBoss, never the person's own prompts).
//
//   terminal-answer.mjs      Stop (async): hands the Stop hook's last_assistant_message to `hiveboss terminal-answer`
//
// The diary rule (decision 2026-10-07-gather-diary) stays: no mcp_tool hook ever carries the last message, because an
// mcp_tool hook cannot be made conditional on HiveBoss's answer. This script only starts the HiveBoss CLI on this
// computer, which first asks HiveBoss (hook_answer, without the answer) whether this session is an ACTIVE terminal Bee
// session (the switch on, the Bee's "Show terminal sessions" toggle on, the session resolved to a bee_session row), and
// sends the answer only on that yes. The person's prompt is never read or sent.
//
// Auth and network: none here. This script never opens a socket and never reads a token (decision
// 2026-10-05-connector-plugin); the CLI holds the computer's sign-in, as it does for the MCP header. Without the CLI,
// in a run HiveBoss started, or with a headless Bee key, it does nothing. Never prints, always exits 0.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The HiveBoss CLI on this computer (the same place scripts/mcp-headers.mjs looks). */
export function cliFileOf(env = process.env) {
	return join(env.HIVEBOSS_CLI_HOME || join(homedir(), ".hiveboss", "cli"), "hiveboss.mjs");
}

/** What the CLI is handed, or null when nothing is to be sent (no answer, no ids, a woken or Bee-key run, re-entry is fine). */
export function payloadOf(hook, env = process.env) {
	if (!hook || typeof hook !== "object") return null;
	if (env.HIVEBOSS_WAKE_ID || env.HIVEBOSS_BEE_KEY || env.HIVEBOSS_BEE_KEY_FILE) return null;
	const str = (v) => (typeof v === "string" ? v : "");
	const answer = str(hook.last_assistant_message).trim();
	if (!answer || !str(hook.session_id) || !str(hook.prompt_id)) return null;
	return { session_id: hook.session_id, cwd: str(hook.cwd), prompt_id: hook.prompt_id, answer, mcp_url: str(env.CLAUDE_PLUGIN_OPTION_MCP_URL) };
}

async function main() {
	try {
		const chunks = [];
		for await (const chunk of process.stdin) chunks.push(chunk);
		const payload = payloadOf(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		const cli = cliFileOf();
		if (!payload || !existsSync(cli)) return;
		const child = spawn(process.execPath, [cli, "terminal-answer"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
		child.on("error", () => {});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(payload));
		await new Promise((resolve) => child.on("close", resolve));
	} catch {
		// Never fails the person's turn.
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
