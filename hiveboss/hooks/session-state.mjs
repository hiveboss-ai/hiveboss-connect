#!/usr/bin/env node
// HiveBoss Connect plugin: local hook helper, run with Node so it works the same on
// macOS, Linux and Windows (hooks.json runs `node` with this file as its first argument:
// a .sh file cannot be started on Windows, EFTYPE; decision 2026-11-04-plugin-hooks-node).
//
//   session-state.mjs session-start    SessionStart: names the git repo for bare commands (none outside git);
//                                      on a computer with no browser (SSH, or Linux with no display) that has no
//                                      HiveBoss sign-in, says to run `hiveboss connect` there (a code, no browser)
//   session-state.mjs mark-changed     PostToolUse on Edit|Write|MultiEdit|NotebookEdit
//   session-state.mjs mark-published   PostToolUse on publish_page
//   session-state.mjs busy             UserPromptSubmit: marks the session busy (the listener never wakes it then)
//   session-state.mjs stop             Stop: clears the busy mark; offers a publish at most once per session
//                                      and shows HiveBoss's "/hiveboss" nudge to the person once
//   session-state.mjs pre-compact      PreCompact: in an agent's home, marks that STATE.md needs updating
//   session-state.mjs after-compact    SessionStart (compact): then reminds the agent to update STATE.md
//
// Runs on this machine only: no network, no token, no prompt text sent anywhere (session-start only looks at
// which sign-in fields are present in the CLI's and Claude Code's credential files; no value is read out or kept)
// (the first Stop only searches the session's transcript for HiveBoss's nudge
// line). State is empty marker files per session under the plugin's data directory
// (${CLAUDE_PLUGIN_DATA}/sessions), mode 700, pruned after 7 days. Never blocks:
// every path exits 0, and the Stop answer is a soft `additionalContext` and a
// `systemMessage` to the person, never `decision: block`.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const SID_OK = /^[A-Za-z0-9._-]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const NUDGE_SEEN = "This session isn't one of your agents yet.";
export const NUDGE_SHOWN = "HiveBoss: this session isn't one of your agents yet. To set it up, run hiveboss connect in a terminal.";
export const PUBLISH_OFFER =
	"HiveBoss: this session changed files and nothing was published to HiveBoss. End your reply with one short sentence offering to publish this work to the HiveBoss room as a page, saying in a few words what the page would hold, and wait. Do not call any HiveBoss tool now: publish only after the person says yes. Offer once; do not repeat it.";
export const COMPACT_REMINDER =
	"HiveBoss: this conversation was just compacted. Before going on, update STATE.md with the state_update tool: what you have in flight and your open items, so nothing is lost at the next compaction or run.";

export const REMOTE_SIGN_IN_SHOWN =
	"HiveBoss: this computer is not signed in to HiveBoss. In a terminal on this computer, run: hiveboss connect. Type the code it shows at the address it shows, in a browser where you are signed in to HiveBoss.";
export const REMOTE_SIGN_IN_CONTEXT =
	"HiveBoss: this computer is reached over SSH or has no display, and HiveBoss is not signed in here. The authenticate tool of the HiveBoss server opens a browser sign-in that cannot come back to this computer. If the person wants HiveBoss, tell them to run `hiveboss connect` in a terminal on this computer. They type the code it shows at the address it shows, in a browser where they are signed in to HiveBoss. A new session then has the HiveBoss tools (in this one: /mcp, then reconnect plugin:hiveboss:hiveboss). If `hiveboss` is not found, the installer comes first: curl -fsSL https://hiveboss.ai/connect | sh. Never run hiveboss connect yourself, and never ask for the code.";

/** `${NAME:-}` in sh: unset and empty are the same. */
const envOf = (env, name) => (typeof env[name] === "string" && env[name] !== "" ? env[name] : "");

/** The hook input (Claude Code sends a JSON object): one top-level string field, or "" when absent. */
function inputOf(raw) {
	try {
		const v = JSON.parse(raw);
		if (v && typeof v === "object" && !Array.isArray(v)) return v;
	} catch {}
	return null;
}

function stringField(input, raw, name) {
	if (input) return typeof input[name] === "string" ? input[name] : "";
	// Not JSON: the same loose match the shell version used.
	const m = raw.replace(/\n/g, "").match(new RegExp(`.*"${name}"\\s*:\\s*"([^"]*)"`));
	return m ? m[1] : "";
}

function stopHookActive(input, raw) {
	if (input) return input.stop_hook_active === true;
	return /"stop_hook_active"\s*:\s*true/.test(raw.replace(/\n/g, ""));
}

function touch(path) {
	writeFileSync(path, "", { mode: 0o600 });
}

function sessionsDir(env, sid) {
	const data = envOf(env, "CLAUDE_PLUGIN_DATA");
	if (!data || !sid) return "";
	const dir = join(data, "sessions");
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		return dir;
	} catch {
		return "";
	}
}

// agent-homes REQ-AGH31: the session's folder is an agent's home (the listener writes AGENT.md and STATE.md there).
function inAgentHome(env) {
	const dir = envOf(env, "HIVEBOSS_AGENT_HOME") || envOf(env, "CLAUDE_PROJECT_DIR") || ".";
	const isFile = (p) => {
		try {
			return statSync(p).isFile();
		} catch {
			return false;
		}
	};
	return isFile(join(dir, "AGENT.md")) && isFile(join(dir, "STATE.md"));
}

function repoName(env) {
	const project = envOf(env, "CLAUDE_PROJECT_DIR") || ".";
	let root = "";
	try {
		const r = spawnSync("git", ["-C", project, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 4000 });
		if (r.status === 0 && typeof r.stdout === "string") root = r.stdout.replace(/[\r\n]+$/, "");
	} catch {}
	// Outside a git repository there is no repo to name: a folder such as
	// ~/Downloads must never become a room's name.
	const repo = root ? basename(root) : "";
	if (!repo || repo === "/") return "";
	// Control characters out, as the shell version's `tr -d '\000-\037'`.
	return repo.replace(/[\u0000-\u001f]/g, "");
}

/**
 * Where a browser sign-in cannot come back (the CLI's remoteSession, 2026-10-17 and AGH2): "ssh" over SSH (in tmux,
 * only when tmux says the client attached now is SSH), "headless" on Linux with no display, else null.
 */
export function remoteSession(env, platform = process.platform, tmuxSsh = tmuxSshNow) {
	let ssh = Boolean(envOf(env, "SSH_CONNECTION") || envOf(env, "SSH_TTY"));
	if (ssh && envOf(env, "TMUX")) {
		const now = tmuxSsh(env);
		if (now === false) ssh = false;
		else if (now === null && !envOf(env, "SSH_CONNECTION") && !ttyLive(envOf(env, "SSH_TTY"))) ssh = false;
	}
	if (ssh) return "ssh";
	if (platform === "linux" && !envOf(env, "DISPLAY") && !envOf(env, "WAYLAND_DISPLAY")) return "headless";
	return null;
}

function tmuxSshNow(env) {
	try {
		const r = spawnSync("tmux", ["show-environment", "SSH_CONNECTION"], { encoding: "utf8", env, timeout: 1500, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		const line = r.status === 0 ? String(r.stdout ?? "").trim() : "";
		return line === "-SSH_CONNECTION" ? false : line.startsWith("SSH_CONNECTION=") ? true : null;
	} catch {
		return null;
	}
}

function ttyLive(path) {
	try {
		return Boolean(path) && statSync(path).isCharacterDevice();
	} catch {
		return false;
	}
}

/** True when the HiveBoss CLI on this computer holds a sign-in (its credential.json names a server). */
export function cliSignedIn(env) {
	const home = envOf(env, "HIVEBOSS_CLI_HOME") || (envOf(env, "HOME") ? join(envOf(env, "HOME"), ".hiveboss", "cli") : "");
	if (!home) return true;
	try {
		const record = JSON.parse(readFileSync(join(home, "credential.json"), "utf8"));
		return Boolean(record && typeof record === "object" && record.mcpUrl);
	} catch {
		return false;
	}
}

/**
 * True when Claude Code holds a HiveBoss plugin OAuth sign-in (an access or refresh token on a
 * plugin:hiveboss:hiveboss entry): ~/.claude/.credentials.json (or $CLAUDE_CONFIG_DIR), else on macOS the keychain
 * item Claude Code writes. Only which fields are present is looked at. Unreadable: false.
 */
export function claudePluginSignedIn(env, platform = process.platform, run = spawnSync) {
	const dir = envOf(env, "CLAUDE_CONFIG_DIR") || (envOf(env, "HOME") ? join(envOf(env, "HOME"), ".claude") : "");
	if (!dir) return false;
	let credentials = null;
	try {
		credentials = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
	} catch {}
	if (!credentials && platform === "darwin" && !envOf(env, "CLAUDE_CONFIG_DIR")) {
		try {
			const r = run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
			if (r.status === 0) credentials = JSON.parse(String(r.stdout ?? ""));
		} catch {}
	}
	const entries = credentials && typeof credentials.mcpOAuth === "object" && credentials.mcpOAuth ? Object.entries(credentials.mcpOAuth) : [];
	return entries.some(([key, v]) => key.startsWith("plugin:hiveboss:hiveboss|") && v && typeof v === "object" && Boolean(v.accessToken || v.refreshToken));
}

/**
 * The no-browser sign-in hint, or null: only on a computer where a browser sign-in cannot come back, where the
 * HiveBoss CLI is installed and not signed in, and where Claude Code holds no HiveBoss plugin sign-in.
 */
export function remoteSignInHint(env, platform = process.platform, probes = {}) {
	const home = envOf(env, "HIVEBOSS_CLI_HOME") || (envOf(env, "HOME") ? join(envOf(env, "HOME"), ".hiveboss", "cli") : "");
	if (!home || !existsSync(join(home, "hiveboss.mjs"))) return null;
	if (!(probes.remote ?? remoteSession)(env, platform)) return null;
	if ((probes.cli ?? cliSignedIn)(env)) return null;
	if ((probes.claude ?? claudePluginSignedIn)(env, platform)) return null;
	return { shown: REMOTE_SIGN_IN_SHOWN, context: REMOTE_SIGN_IN_CONTEXT };
}

function prune(dir) {
	try {
		const now = Date.now();
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			try {
				const st = statSync(p);
				// find -mtime +7: more than 7 whole days old.
				if (st.isFile() && Math.floor((now - st.mtimeMs) / DAY_MS) > 7) rmSync(p, { force: true });
			} catch {}
		}
	} catch {}
}

function transcriptNudge(path) {
	if (!path) return "";
	let text;
	try {
		if (!statSync(path).isFile()) return "";
		text = readFileSync(path, "utf8");
	} catch {
		return "";
	}
	const lines = text.split("\n");
	const said = lines.some((l) => l.includes('"attachment":{"type":"hook_additional_context"') && l.includes('"hookEvent":"UserPromptSubmit"') && l.includes(NUDGE_SEEN));
	if (!said) return "";
	// A HiveBoss that already showed it to the person on the prompt (its own systemMessage): not twice.
	const shown = lines.some((l) => l.includes('"attachment":{"type":"hook_system_message"') && l.includes('"hookEvent":"UserPromptSubmit"') && l.toLowerCase().includes("isn't one of your agents yet"));
	return shown ? "" : NUDGE_SHOWN;
}

/** One hook call: the action, the raw hook JSON and the environment in; exit code 0 and stdout out. */
export function run(action, raw, env = process.env) {
	const out = { exitCode: 0, stdout: "" };
	try {
		const input = inputOf(raw);
		let sid = stringField(input, raw, "session_id");
		if (!SID_OK.test(sid)) sid = "";
		const dir = sessionsDir(env, sid);
		const mark = (suffix) => join(dir, `${sid}.${suffix}`);

		switch (action) {
			case "session-start": {
				const repo = repoName(env);
				let hint = null;
				try {
					hint = remoteSignInHint(env);
				} catch {}
				const context = [repo ? `HiveBoss: this session works in the repository "${repo}". Pass repo: "${repo}" to HiveBoss tools so bare commands use its room. Read hiveboss://skill/connector before your first HiveBoss call.` : "", hint ? hint.context : ""].filter(Boolean);
				if (context.length === 0) return out;
				out.stdout = `${JSON.stringify({
					...(hint ? { systemMessage: hint.shown } : {}),
					hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context.join("\n\n") },
				})}\n`;
				return out;
			}
			case "mark-changed":
				if (dir) touch(mark("changed"));
				return out;
			case "mark-published":
				if (dir) touch(mark("published"));
				return out;
			case "busy":
				if (dir) touch(mark("busy"));
				return out;
			case "stop": {
				if (dir) rmSync(mark("busy"), { force: true });
				// A stop that a hook already continued: never nudge again (no loops).
				if (stopHookActive(input, raw)) return out;
				if (!dir) return out;
				prune(dir);
				// connect-session-setup REQ-CSS16: HiveBoss's prompt hook tells only the model that this
				// session is none of the person's agents (additionalContext). On the session's first
				// Stop, the line Claude Code recorded from that hook is shown to the person as well,
				// once. The shown text is this script's own, never text copied from the transcript.
				let nudge = "";
				if (!existsSync(mark("nudge-checked"))) {
					touch(mark("nudge-checked"));
					nudge = transcriptNudge(stringField(input, raw, "transcript_path"));
				}
				let offer = false;
				if (existsSync(mark("changed")) && !existsSync(mark("published")) && !existsSync(mark("offered"))) {
					touch(mark("offered"));
					offer = true;
				}
				const answer = {};
				if (nudge) answer.systemMessage = nudge;
				if (offer) answer.hookSpecificOutput = { hookEventName: "Stop", additionalContext: PUBLISH_OFFER };
				if (nudge || offer) out.stdout = `${JSON.stringify(answer)}\n`;
				return out;
			}
			case "pre-compact":
				// agent-homes REQ-AGH31: Claude Code gives a PreCompact hook no way to speak to the model, so the
				// reminder is marked here and said by the SessionStart hook that runs right after the compaction.
				if (!inAgentHome(env)) return out;
				if (dir) touch(mark("compacted"));
				return out;
			case "after-compact":
				if (!inAgentHome(env)) return out;
				// Without the plugin's data folder there is no mark to read: remind anyway.
				if (dir) {
					if (!existsSync(mark("compacted"))) return out;
					rmSync(mark("compacted"), { force: true });
				}
				out.stdout = `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: COMPACT_REMINDER } })}\n`;
				return out;
			default:
				return out;
		}
	} catch {
		return { exitCode: 0, stdout: "" };
	}
}

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

/** True when Node was started with this file (not when a test imports it). Symlinks and, on Windows, drive-letter case do not matter. */
function invokedDirectly() {
	try {
		const argv1 = process.argv[1];
		if (!argv1) return false;
		const a = realpathSync(argv1);
		const b = realpathSync(fileURLToPath(import.meta.url));
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	} catch {
		return false;
	}
}

if (invokedDirectly()) {
	const res = run(process.argv[2] || "", readStdin());
	if (res.stdout) process.stdout.write(res.stdout);
	process.exitCode = 0;
}
