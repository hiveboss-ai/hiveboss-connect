// HiveBoss Connect plugin: a person's own Claude token counts for their work diary (Polis agents-log-work-sessions
// REQ-ALS18, a SHOULD awaiting Adam's yes; canon skills/diary step 5: a person's own AI cost and tokens, from their own
// sessions on their own machine). Off by default; opt-in per person: "localSpend": true in ~/.config/hiveboss/diary.json
// (the canon skill's own config file), or HIVEBOSS_DIARY_LOCAL_SPEND=on. A Hive owner can turn on "Share token counts"
// for the whole Hive (diary_settings); then it is on for every member unless they opted out ("localSpend": false or
// HIVEBOSS_DIARY_LOCAL_SPEND=off), which always wins.
//
// Code only, never a model: it reads this computer's Claude Code transcripts (~/.claude/projects/*/*.jsonl, or
// $CLAUDE_CONFIG_DIR/projects), takes only each assistant message's usage token counts (input, output, cache write,
// cache read) and model for the local day, counts each message once, and sums them. No text, no file contents, no
// command lines are read into the result. The cost stays "not connected" (plan users pay no per-token price): no
// dollar figure is ever derived. Bounded: files modified today only, at most 300 files and 64 MB read.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOCAL_USAGE_SOURCE = "local transcript";
const MAX_FILES = 300;
const MAX_BYTES = 64 * 1024 * 1024;

const envOf = (env, name) => (typeof env[name] === "string" && env[name] !== "" ? env[name] : "");
const isOn = (v) => ["on", "true", "1", "yes"].includes(String(v ?? "").trim().toLowerCase());

/** The local date (YYYY-MM-DD) of a time. */
export function localDateOf(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const isOffWord = (v) => ["off", "false", "0", "no"].includes(String(v ?? "").trim().toLowerCase());

/**
 * REQ-ALS18: the person's own choice on this computer: true (opted in), false (opted out: "localSpend": false in
 * ~/.config/hiveboss/diary.json or HIVEBOSS_DIARY_LOCAL_SPEND=off), or null (no choice made). The environment wins.
 */
export function localSpendChoice(env = process.env) {
	if (isOn(env.HIVEBOSS_DIARY_LOCAL_SPEND)) return true;
	if (isOffWord(env.HIVEBOSS_DIARY_LOCAL_SPEND)) return false;
	try {
		const cfg = JSON.parse(readFileSync(join(envOf(env, "HOME") || homedir(), ".config", "hiveboss", "diary.json"), "utf8"));
		if (cfg?.localSpend === true) return true;
		if (cfg?.localSpend === false) return false;
	} catch {}
	return null;
}

/**
 * REQ-ALS18: whether this computer adds the person's token counts. Off by default. With the Hive's "Share token counts"
 * on (decision 2026-11-26-hive-share-token-counts), on unless the person opted out; with it off, only their own opt-in.
 */
export function localSpendOn(env = process.env, hiveShares = false) {
	const choice = localSpendChoice(env);
	return choice === null ? hiveShares === true : choice;
}

const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

/** Today's token counts from this computer's Claude Code transcripts, or null when there are none. */
export function localUsageToday(env = process.env, now = Date.now()) {
	const root = join(envOf(env, "CLAUDE_CONFIG_DIR") || join(envOf(env, "HOME") || homedir(), ".claude"), "projects");
	const today = localDateOf(now);
	const startOfDay = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
	const files = [];
	let projects = [];
	try {
		projects = readdirSync(root);
	} catch {
		return null;
	}
	for (const p of projects) {
		let names = [];
		try {
			names = readdirSync(join(root, p));
		} catch {
			continue;
		}
		for (const f of names) {
			if (!f.endsWith(".jsonl")) continue;
			try {
				const st = statSync(join(root, p, f));
				if (st.isFile() && st.mtimeMs >= startOfDay) files.push({ path: join(root, p, f), size: st.size, mtime: st.mtimeMs });
			} catch {}
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	const seen = new Set();
	const sum = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
	const models = new Set();
	/** The same counts per model (at most 10 models; the rest under "other models"; at most 12 rows), so a reader can see Opus versus Sonnet. */
	const perModel = new Map();
	let bytes = 0;
	for (const f of files.slice(0, MAX_FILES)) {
		if (bytes + f.size > MAX_BYTES) break;
		bytes += f.size;
		let text = "";
		try {
			text = readFileSync(f.path, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.includes('"usage"')) continue;
			let d;
			try {
				d = JSON.parse(line);
			} catch {
				continue;
			}
			const m = d?.message;
			const u = m?.usage;
			if (d?.type !== "assistant" || !u || typeof u !== "object") continue;
			const at = Date.parse(d.timestamp ?? "");
			if (!Number.isFinite(at) || localDateOf(at) !== today) continue;
			// One message is written as several lines with the same usage: count it once.
			const id = typeof m.id === "string" ? m.id : typeof d.requestId === "string" ? d.requestId : `${f.path}:${d.uuid ?? line.length}`;
			if (seen.has(id)) continue;
			seen.add(id);
			sum.input += n(u.input_tokens);
			sum.output += n(u.output_tokens);
			sum.cacheWrite += n(u.cache_creation_input_tokens);
			sum.cacheRead += n(u.cache_read_input_tokens);
			const model = typeof m.model === "string" && m.model ? m.model.slice(0, 80) : "";
			if (model && models.size < 10) models.add(model);
			const key = !model ? "model not reported" : perModel.has(model) || perModel.size < 10 ? model : "other models";
			const pm = perModel.get(key) ?? { model: key, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
			pm.input += n(u.input_tokens);
			pm.output += n(u.output_tokens);
			pm.cacheWrite += n(u.cache_creation_input_tokens);
			pm.cacheRead += n(u.cache_read_input_tokens);
			perModel.set(key, pm);
		}
	}
	if (seen.size === 0) return null;
	return { ...sum, ...(models.size ? { models: [...models] } : {}), ...(perModel.size ? { byModel: [...perModel.values()] } : {}), source: LOCAL_USAGE_SOURCE };
}
