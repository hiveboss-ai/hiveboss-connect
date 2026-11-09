#!/usr/bin/env node
// HiveBoss Connect plugin: the work diary hooks (Polis agents-log-work-sessions, REQ-ALS1, REQ-ALS2, REQ-ALS8,
// REQ-ALS11, REQ-ALS13, REQ-ALS16; canon skills/diary/SKILL.md and fleet/decisions/2026-11-04-daily-work-diary.md; decision
// apps/backend/docs/decisions/2026-11-04-agents-log-work-sessions.md). Prior art: brains' ~/memory-server/bin/session-hooks.mjs.
//
//   session-log.mjs stop      Stop: when the session did 4 or more real-work tool uses since its last log_session
//                             (file edits, commits, pushes, deploys, HiveBoss posts, publishes and sends), asks the
//                             agent once to add the session to today's work diary with log_session (the computer's
//                             local date), then to end with "I've added this session to today's work diary." In a
//                             person's own session it says to show the person the notes first. It never asks twice for
//                             the same work, never when the hook already continued the turn (stop_hook_active), never
//                             in a headless run (claude -p, the SDK, a listener wake), and only while HiveBoss says
//                             the work diary is on: the newest "HiveBoss work diary: on|off" line HiveBoss's prompt hook
//                             put in the transcript, or a newer change seen by `capture`. No line: never.
//   session-log.mjs capture   PostToolUse on log_session and agent_change: keeps the person's setting as HiveBoss last
//                             said it (so "stop my work diary" applies at once), and writes the day's whole entry, as
//                             HiveBoss sent it back (a person's preview before it is sent, then the sent entry), to ~/diary/<date>-<name>.md (a Bee's: ~/hiveboss/agents/<slug>/diary/),
//                             replacing it on each send (REQ-ALS8). Capped (REQ-ALS13): 64 KB a file, 20 MB of copies a
//                             folder, the oldest copies this hook wrote removed first.
//
// Off switches: HIVEBOSS_SESSION_LOG=off (no asks, no copies), HIVEBOSS_SESSION_LOG_LOCAL=off (no copies); the
// person's own setting through agent_change (sessionLogging). Runs on this machine only: no network, no token. State is
// small JSON files under ${CLAUDE_PLUGIN_DATA}/session-log (mode 700). It prints only JSON for Claude Code; on any error
// it prints nothing and exits 0, so a hook problem never blocks a session.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WORK_BEFORE_ASK = 4;
export const DONE_LINE = "I've added this session to today's work diary.";
/** The prefix HiveBoss's prompt hook writes (packages/api/modules/connector/lib/work-diary-flag.ts DIARY_LINE_PREFIX). */
export const LINE_PREFIX = "HiveBoss work diary:";
const LINE_RE = /HiveBoss work diary: (on|off)\b( \(([^)]*)\))?/;
const LOG_TOOL = /__log_session$/;
const CHANGE_TOOL = /__agent_change$/;
const HIVEBOSS_WRITES = /^mcp__.+__(publish_page|edit_page|publish_motion|send_message|post_message|reply|send_hivemail|make_reel|save_note|post_diary|remember_diary|wiki_edit)$/;
const WORK_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$|^mcp__.+__(publish|create|update|send|batch|deploy)(_[a-z_]+)?$/;
const WORK_BASH = /\b(git (commit|push|merge|tag)|gh pr (create|merge)|rsync |launchctl (bootstrap|kickstart|bootout)|npm (install|publish)|pnpm publish|deploy\b|install\.sh)/;
const SID_OK = /^[A-Za-z0-9._:-]{1,128}$/;

const envOf = (env, name) => (typeof env[name] === "string" && env[name] !== "" ? env[name] : "");
const isOff = (v) => ["off", "false", "0", "no"].includes(String(v ?? "").trim().toLowerCase());

/** A run nobody is watching: `claude -p` and the SDK (CLAUDE_CODE_ENTRYPOINT sdk-*), or a listener wake (HIVEBOSS_WAKE_ID). */
export function headless(env) {
	return /^sdk/i.test(envOf(env, "CLAUDE_CODE_ENTRYPOINT")) || envOf(env, "HIVEBOSS_WAKE_ID") !== "";
}

function stateDir(env) {
	const data = envOf(env, "CLAUDE_PLUGIN_DATA");
	const base = data ? join(data, "session-log") : join(envOf(env, "HOME") || homedir(), ".hiveboss", "plugin-session-log");
	mkdirSync(base, { recursive: true, mode: 0o700 });
	return base;
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function writeJson(path, value) {
	writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

const sidOf = (input) => {
	const sid = typeof input?.session_id === "string" ? input.session_id : "";
	return SID_OK.test(sid) ? sid : "";
};
const fileSafe = (sid) => sid.replace(/[^A-Za-z0-9._-]/g, "_");
const timeOf = (t) => {
	const ms = typeof t === "string" ? Date.parse(t) : typeof t === "number" ? t : Number.NaN;
	return Number.isFinite(ms) ? ms : 0;
};

/** True when a tool use is real work (REQ-ALS1). */
export function isRealWork(name, input) {
	const n = String(name || "");
	if (WORK_TOOLS.test(n) || HIVEBOSS_WRITES.test(n)) return true;
	return n === "Bash" && WORK_BASH.test(String(input?.command || ""));
}

/**
 * Reads the transcript: the real-work tool uses after the last log_session call, how many logs there were, and the
 * newest "HiveBoss work diary" line from HiveBoss's prompt hook (with its time, and whether it says "show first").
 */
export function readTranscript(transcriptPath) {
	let work = 0;
	let logs = 0;
	let logging = null;
	let loggingAt = 0;
	let showFirst = false;
	const text = readFileSync(transcriptPath, "utf8");
	for (const line of text.split("\n")) {
		const hasTool = line.includes('"tool_use"');
		const hasLine = line.includes(LINE_PREFIX) && line.includes('"hook_additional_context"');
		if (!hasTool && !hasLine) continue;
		let d;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		if (hasLine) {
			const m = LINE_RE.exec(line);
			if (m) {
				logging = m[1];
				showFirst = /show first/.test(m[3] ?? "");
				loggingAt = timeOf(d?.timestamp);
			}
		}
		const content = d?.message?.content;
		if (!hasTool || !Array.isArray(content)) continue;
		for (const c of content) {
			if (c?.type !== "tool_use") continue;
			const name = String(c.name || "");
			if (LOG_TOOL.test(name)) {
				work = 0;
				logs++;
				continue;
			}
			if (isRealWork(name, c.input)) work++;
		}
	}
	return { work, logs, logging, loggingAt, showFirst };
}

/** The person's setting as the plugin last saw HiveBoss say it (capture), or null. */
export function savedSetting(env) {
	const s = readJson(join(stateDir(env), "setting.json"));
	return s && typeof s.logging === "boolean" ? s : null;
}

/** The computer's local date (YYYY-MM-DD): the person's working day. */
export function localDate(now = Date.now()) {
	const d = new Date(now);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** REQ-ALS1, REQ-ALS2, REQ-ALS11, REQ-ALS16: the Stop hook's answer, or null for nothing. */
export function stopDecision(input, env = process.env, now = Date.now()) {
	if (isOff(env.HIVEBOSS_SESSION_LOG) || headless(env)) return null;
	if (input?.stop_hook_active === true || input?.stop_hook_active === "true") return null;
	const tp = input?.transcript_path;
	if (typeof tp !== "string" || !tp || !existsSync(tp)) return null;
	const t = readTranscript(tp);
	const saved = savedSetting(env);
	// No work diary line from HiveBoss in this session: its switch is off (or the tool is not there), so nothing to ask,
	// whatever setting was saved before (review 2026-11-05).
	if (t.logging === null) return null;
	// A change seen after HiveBoss's newest line wins (it applies at once); HiveBoss's line wins after that.
	const on = saved && timeOf(saved.at) > t.loggingAt ? saved.logging : t.logging === "on";
	if (!on) return null;
	if (t.work < WORK_BEFORE_ASK) return null;
	const sid = sidOf(input);
	if (!sid) return null;
	// Ask once per stretch of work: remember the count we asked at, and ask again only after as much new work.
	const f = join(stateDir(env), `${fileSafe(sid)}.ask.json`);
	const st = readJson(f) ?? {};
	if (st.askedAtWork && st.logs === t.logs && t.work < st.askedAtWork + WORK_BEFORE_ASK) return null;
	writeJson(f, { askedAtWork: t.work, logs: t.logs, at: new Date(now).toISOString() });
	const showFirst = saved && timeOf(saved.at) > t.loggingAt && typeof saved.showFirst === "boolean" ? saved.showFirst : t.showFirst;
	return {
		decision: "block",
		reason: [
			`HiveBoss: before you stop, ${t.logs ? "update this session in" : "add this session to"} today's work diary with the HiveBoss tool log_session (sessionId "${sid}", date "${localDate(now)}"). ${t.work} real-work steps are not in it yet.`,
			"Short, in your own words, about the work and never the person: a 2 to 4 sentence summary, the workstream (arc or Polis card) and its stage if known, done (each with its link: PR, commit, card or arc line), shipped, decisions, blocked (what, on whom, what it cost), next, and activity counts. Never the transcript, never a secret, never anything personal, and never a cost: HiveBoss fills Spend from its records.",
			showFirst
				? "For your person, log_session first sends nothing: it returns today's whole work diary exactly as it will be sent, and this plugin writes it to ~/diary. Show your person that entry in full, and call log_session again with the same notes and its confirm key only after they okay it."
				: "Send them now.",
			"If nothing here is worth adding, or you have no log_session tool, say so in one line and stop.",
			`After it is added, end with one line: "${DONE_LINE}" Do not repeat your last reply.`,
		].join(" "),
	};
}

// ── capture ──────────────────────────────────────────────────────────────────

/** Every string inside a tool response (a string, a list of text blocks, or { content: [...] }), joined. */
export function responseText(r) {
	const out = [];
	const walk = (v, depth) => {
		if (depth > 6 || out.length > 50) return;
		if (typeof v === "string") {
			out.push(v);
			// A response Claude Code kept as JSON text (the MCP content list): read inside it too.
			const t = v.trim();
			if (depth < 2 && (t.startsWith("[") || t.startsWith("{")) && !t.includes("\n")) {
				try {
					walk(JSON.parse(t), depth + 1);
				} catch {}
			}
		}
		else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
		else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
	};
	walk(r, 0);
	return out.join("\n");
}

/** The first JSON object in the response text that has `key`, or null. */
function jsonWith(text, key) {
	for (const part of text.split("\n")) {
		const s = part.trim();
		if (!s.startsWith("{") || !s.includes(`"${key}"`)) continue;
		try {
			const v = JSON.parse(s);
			if (v && typeof v === "object" && key in v) return v;
		} catch {}
	}
	return null;
}

/** REQ-ALS8: where the day's copy goes: a Bee's home's diary/ when the session's folder is inside it, else ~/diary. */
export function diaryFolder(env, cwd) {
	const home = envOf(env, "HOME") || homedir();
	const agents = join(home, "hiveboss", "agents");
	const dir = typeof cwd === "string" && cwd ? cwd : envOf(env, "CLAUDE_PROJECT_DIR");
	if (dir && isAbsolute(dir)) {
		let real = dir;
		let root = agents;
		try {
			real = realpathSync(dir);
		} catch {}
		try {
			root = realpathSync(agents);
		} catch {}
		const rel = relative(root, real);
		const slug = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep)[0] : "";
		if (slug && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && existsSync(join(root, slug))) return join(root, slug, "diary");
	}
	return join(home, "diary");
}

/** REQ-ALS13: at most this many bytes of copies in one diary folder; the oldest copies go first. */
export const FOLDER_CAP_BYTES = 20 * 1024 * 1024;
/** REQ-ALS13: one day's file is at most this many bytes. */
export const FILE_CAP_BYTES = 64 * 1024;
export const FULL_NOTE = "\n\n_This local copy was cut at 64 KB. The whole entry is in HiveBoss._\n";
const FILE_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,60}\.md$/;

/** Text cut to at most `max` UTF-8 bytes, on a character boundary. */
function clipBytes(text, max) {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= max) return text;
	return buf.subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "");
}

/** The copies this hook wrote, by folder: the only files it ever counts or removes. */
function copiesFile(env) {
	return join(stateDir(env), "copies.json");
}

/**
 * REQ-ALS13: keeps the folder's copies at or under `cap` by removing the oldest first (by modified time). Only files this
 * hook wrote (its list) are counted or removed; `keep` (the file just written) is never removed. Returns the removed paths.
 */
export function pruneFolder(env, dir, keep, cap = FOLDER_CAP_BYTES) {
	const list = readJson(copiesFile(env));
	const mine = new Set(Array.isArray(list) ? list.filter((p) => typeof p === "string") : []);
	const copies = [];
	for (const path of mine) {
		if (dirname(path) !== dir) continue;
		let st;
		try {
			st = lstatSync(path);
		} catch {
			mine.delete(path);
			continue;
		}
		if (st.isFile()) copies.push({ path, size: st.size, mtime: st.mtimeMs });
	}
	let total = copies.reduce((n, c) => n + c.size, 0);
	const removed = [];
	for (const c of copies.sort((a, b) => a.mtime - b.mtime || (a.path < b.path ? -1 : 1))) {
		if (total <= cap) break;
		if (c.path === keep) continue;
		try {
			rmSync(c.path, { force: true });
			total -= c.size;
			removed.push(c.path);
			mine.delete(c.path);
		} catch {}
	}
	writeJson(copiesFile(env), [...mine]);
	return removed;
}

/** REQ-ALS8: writes the day's entry, as HiveBoss sent it back, replacing that day's file. Returns its path, or "". */
export function writeDiaryCopy(env, input, diary) {
	const markdown = typeof diary?.markdown === "string" ? diary.markdown : "";
	const name = typeof diary?.fileName === "string" ? diary.fileName : "";
	if (!markdown.trim() || !FILE_NAME.test(name)) return "";
	const dir = diaryFolder(env, input?.cwd);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, name);
	const text = Buffer.byteLength(`${markdown}\n`, "utf8") <= FILE_CAP_BYTES ? `${markdown}\n` : clipBytes(markdown, FILE_CAP_BYTES - Buffer.byteLength(FULL_NOTE, "utf8")) + FULL_NOTE;
	writeFileSync(file, text, { mode: 0o600 });
	const list = readJson(copiesFile(env));
	const mine = new Set(Array.isArray(list) ? list : []);
	mine.add(file);
	writeJson(copiesFile(env), [...mine]);
	pruneFolder(env, dir, file);
	return file;
}

/** PostToolUse on log_session and agent_change (REQ-ALS8, REQ-ALS11, REQ-ALS16). Writes state and the copy; prints nothing. */
export function capture(input, env = process.env, now = Date.now()) {
	const name = String(input?.tool_name ?? "");
	const text = responseText(input?.tool_response);
	const at = new Date(now).toISOString();
	if (CHANGE_TOOL.test(name)) {
		const asked = input?.tool_input?.proposed?.sessionLogging;
		if (!asked || typeof asked !== "object") return { wrote: "" };
		const off = /Work diary is off/.test(text);
		const on = /Work diary is on/.test(text);
		if (!off && !on) return { wrote: "" };
		const prev = savedSetting(env);
		const localCopies = /without local copies/.test(text) ? false : asked.localCopies === true ? true : (prev?.localCopies ?? true);
		const showFirst = /without showing you first/.test(text) ? false : asked.showFirst === true ? true : (prev?.showFirst ?? true);
		writeJson(join(stateDir(env), "setting.json"), { logging: on, localCopies, showFirst, at });
		return { wrote: "setting" };
	}
	if (!LOG_TOOL.test(name)) return { wrote: "" };
	const reply = jsonWith(text, "sessionLogging") ?? jsonWith(text, "diary");
	const s = reply?.sessionLogging;
	if (s && typeof s.logging === "boolean") writeJson(join(stateDir(env), "setting.json"), { logging: s.logging, localCopies: s.localCopies !== false, showFirst: s.showFirst !== false, at });
	// REQ-ALS16: a preview is the day's entry exactly as it will be sent: the file is the thing shown to the person.
	const sent = reply?.ok === true && (reply.status === "added" || reply.status === "updated" || reply.status === "preview");
	if (!sent || isOff(env.HIVEBOSS_SESSION_LOG) || isOff(env.HIVEBOSS_SESSION_LOG_LOCAL) || s?.localCopies === false) return { wrote: s ? "setting" : "" };
	return { wrote: writeDiaryCopy(env, input, reply.diary) };
}

/** One hook call: the action, the raw hook JSON and the environment in; exit code 0 and stdout out. Never throws. */
export function run(action, raw, env = process.env, now = Date.now()) {
	try {
		if (isOff(env.HIVEBOSS_SESSION_LOG) && action === "stop") return { exitCode: 0, stdout: "" };
		let input = {};
		try {
			input = JSON.parse(raw || "{}");
		} catch {}
		if (action === "stop") {
			const d = stopDecision(input, env, now);
			return { exitCode: 0, stdout: d ? `${JSON.stringify(d)}\n` : "" };
		}
		if (action === "capture") {
			capture(input, env, now);
			return { exitCode: 0, stdout: "" };
		}
	} catch {}
	return { exitCode: 0, stdout: "" };
}

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

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
