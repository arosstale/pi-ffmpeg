/**
 * pi-ffmpeg — ffmpeg Swiss Army knife for pi
 *
 * 13 commands + 12 LLM tools. Zero duplication: each operation is a pure
 * function that returns {ok, text}. Commands and tools both call the same fn.
 *
 * Requires: ffmpeg + ffprobe in PATH
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, basename, extname, dirname, join } from "node:path";
import { platform, tmpdir } from "node:os";

const IS_WIN = platform() === "win32";

// ═══════════════════════════════════════════════════════════════════════════
// Primitives — no pi dependency, pure functions
// ═══════════════════════════════════════════════════════════════════════════

function which(cmd: string): string | null {
	try {
		return execSync(
			IS_WIN ? `where "${cmd}" 2>nul` : `command -v "${cmd}" 2>/dev/null`,
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
		).trim().split(/\r?\n/)[0].trim() || null;
	} catch { return null; }
}

function ff(args: string[]): { stdout: string; stderr: string; ok: boolean } {
	try {
		const stdout = execFileSync("ffmpeg", ["-y", ...args], {
			encoding: "utf-8", timeout: 600_000, maxBuffer: 50 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "", ok: true };
	} catch (e: any) {
		return { stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? e.message, ok: false };
	}
}

function fmtBytes(b: number): string {
	if (b < 1024) return `${b}B`;
	if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
	if (b < 1073741824) return `${(b / 1048576).toFixed(1)}MB`;
	return `${(b / 1073741824).toFixed(2)}GB`;
}

function fmtTime(s: number): string {
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`
		: `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

function autoOut(input: string, suffix: string, ext?: string): string {
	return join(dirname(resolve(input)), basename(input, extname(input)) + suffix + (ext || extname(input)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Operations — each returns { ok: boolean; text: string }
// ═══════════════════════════════════════════════════════════════════════════

interface ProbeInfo {
	duration: number; width: number; height: number; fps: number;
	codec: string; audioCodec: string; bitrate: number; size: string;
	channels: number; sampleRate: number;
}

function opProbe(file: string): { ok: boolean; text: string; info?: ProbeInfo } {
	const r = (() => {
		try {
			return { stdout: execFileSync("ffprobe", [
				"-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", resolve(file),
			], { encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }), ok: true };
		} catch (e: any) {
			return { stdout: "", ok: false, err: e.stderr?.toString() ?? e.message };
		}
	})();
	if (!r.ok) return { ok: false, text: `ffprobe failed: ${(r as any).err?.slice(-200)}` };
	const data = JSON.parse(r.stdout);
	const vs = data.streams?.find((s: any) => s.codec_type === "video");
	const as2 = data.streams?.find((s: any) => s.codec_type === "audio");
	const fmt = data.format || {};
	const [num, den] = (vs?.r_frame_rate || "0/1").split("/").map(Number);
	const info: ProbeInfo = {
		duration: parseFloat(fmt.duration || "0"),
		width: vs?.width || 0, height: vs?.height || 0,
		fps: den ? num / den : num || 0,
		codec: vs?.codec_name || (as2 ? "audio-only" : "unknown"),
		audioCodec: as2?.codec_name || "none",
		bitrate: Math.round(parseInt(fmt.bit_rate || "0") / 1000),
		size: fmt.size ? fmtBytes(parseInt(fmt.size)) : "?",
		channels: as2?.channels || 0,
		sampleRate: parseInt(as2?.sample_rate || "0"),
	};
	const lines = [`📹 ${basename(file)}`];
	lines.push(`   Duration: ${fmtTime(info.duration)}  Size: ${info.size} (${info.bitrate} kbps)`);
	if (info.width) lines.push(`   Video:    ${info.width}×${info.height} @ ${info.fps.toFixed(1)} fps (${info.codec})`);
	if (info.audioCodec !== "none") lines.push(`   Audio:    ${info.audioCodec}${info.channels ? ` ${info.channels}ch` : ""}${info.sampleRate ? ` ${info.sampleRate}Hz` : ""}`);
	return { ok: true, text: lines.join("\n"), info };
}

interface TranscodeOpts {
	input: string; output: string; codec?: string; crf?: number; preset?: string;
	scale?: string; fps?: number; start?: string; duration?: string; noAudio?: boolean;
}

function opTranscode(o: TranscodeOpts): { ok: boolean; text: string } {
	const a: string[] = [];
	if (o.start) a.push("-ss", o.start);
	if (o.duration) a.push("-t", o.duration);
	a.push("-i", resolve(o.input));
	if (o.codec && o.codec !== "copy") a.push("-c:v", o.codec === "h265" ? "libx265" : o.codec === "vp9" ? "libvpx-vp9" : "libx264");
	else if (o.codec === "copy") a.push("-c", "copy");
	if (o.crf !== undefined) a.push("-crf", String(o.crf));
	if (o.preset) a.push("-preset", o.preset);
	if (o.scale) a.push("-vf", `scale=${o.scale}`);
	if (o.fps) a.push("-r", String(o.fps));
	if (o.noAudio) a.push("-an");
	a.push(resolve(o.output));
	const r = ff(a);
	if (!r.ok) return { ok: false, text: r.stderr.slice(-400) };
	const p = opProbe(o.output);
	return { ok: true, text: p.ok ? `✅ ${basename(o.output)} — ${p.text.split("\n").slice(1).join(" ").trim()}` : `✅ ${o.output}` };
}

function opTrim(input: string, start: string, end: string | undefined, output: string): { ok: boolean; text: string } {
	const a: string[] = ["-ss", start];
	if (end) a.push("-to", end);
	a.push("-i", resolve(input), "-c", "copy", resolve(output));
	const r = ff(a);
	if (!r.ok) return { ok: false, text: r.stderr.slice(-400) };
	const p = opProbe(output);
	return { ok: true, text: `✅ ${basename(output)}${p.info ? ` — ${fmtTime(p.info.duration)} ${p.info.size}` : ""}` };
}

function opConcat(files: string[], output: string): { ok: boolean; text: string } {
	const listPath = join(tmpdir(), `.pi-ff-cat-${Date.now()}.txt`);
	writeFileSync(listPath, files.map(f => `file '${resolve(f).replace(/'/g, "'\\''")}'`).join("\n"));
	const r = ff(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", resolve(output)]);
	try { unlinkSync(listPath); } catch {}
	if (!r.ok) return { ok: false, text: r.stderr.slice(-400) };
	return { ok: true, text: `✅ ${basename(output)} (${files.length} files joined)` };
}

function opGif(input: string, output: string, fps = 10, width = 480, start?: string, duration?: string): { ok: boolean; text: string } {
	const a: string[] = [];
	if (start) a.push("-ss", start);
	if (duration) a.push("-t", duration);
	a.push("-i", resolve(input), "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, "-loop", "0", resolve(output));
	const r = ff(a);
	return r.ok ? { ok: true, text: `✅ ${basename(output)}` } : { ok: false, text: r.stderr.slice(-400) };
}

function opFrames(input: string, outDir: string, fps = 1, fmt = "png"): { ok: boolean; text: string } {
	mkdirSync(resolve(outDir), { recursive: true });
	const r = ff(["-i", resolve(input), "-vf", `fps=${fps}`, join(resolve(outDir), `frame_%04d.${fmt}`)]);
	if (!r.ok) return { ok: false, text: r.stderr.slice(-400) };
	return { ok: true, text: `✅ Frames → ${outDir}` };
}

function opThumbnail(input: string, output: string, time = "00:00:01"): { ok: boolean; text: string } {
	const r = ff(["-ss", time, "-i", resolve(input), "-frames:v", "1", "-q:v", "2", resolve(output)]);
	return r.ok ? { ok: true, text: `✅ ${basename(output)} @ ${time}` } : { ok: false, text: r.stderr.slice(-400) };
}

function opExtractAudio(input: string, output: string): { ok: boolean; text: string } {
	const r = ff(["-i", resolve(input), "-vn", "-c:a", "copy", resolve(output)]);
	return r.ok ? { ok: true, text: `✅ ${basename(output)}` } : { ok: false, text: r.stderr.slice(-400) };
}

function opAddAudio(video: string, audio: string, output: string, shortest = false): { ok: boolean; text: string } {
	const a = ["-i", resolve(video), "-i", resolve(audio), "-c:v", "copy", "-c:a", "aac"];
	if (shortest) a.push("-shortest");
	a.push(resolve(output));
	const r = ff(a);
	return r.ok ? { ok: true, text: `✅ ${basename(output)}` } : { ok: false, text: r.stderr.slice(-400) };
}

function opCompress(input: string, output: string, crf = 28): { ok: boolean; text: string } {
	const before = opProbe(input).info?.size ?? "?";
	const r = ff(["-i", resolve(input), "-c:v", "libx264", "-crf", String(crf), "-preset", "medium", "-c:a", "aac", "-b:a", "128k", resolve(output)]);
	if (!r.ok) return { ok: false, text: r.stderr.slice(-400) };
	const after = opProbe(output).info?.size ?? "?";
	return { ok: true, text: `✅ ${basename(output)} — ${before} → ${after}` };
}

function opSpeed(input: string, output: string, factor: number): { ok: boolean; text: string } {
	if (factor <= 0) return { ok: false, text: "Factor must be > 0" };
	const vf = `setpts=PTS/${factor}`;
	// atempo only handles 0.5–2.0, chain for extremes
	const at: string[] = [];
	let rem = factor;
	while (rem > 2) { at.push("atempo=2.0"); rem /= 2; }
	while (rem < 0.5) { at.push("atempo=0.5"); rem /= 0.5; }
	at.push(`atempo=${rem}`);
	const r = ff(["-i", resolve(input), "-vf", vf, "-af", at.join(","), resolve(output)]);
	if (!r.ok) return { ok: false, text: r.stderr.slice(-400) };
	const p = opProbe(output);
	return { ok: true, text: `✅ ${basename(output)}${p.info ? ` — ${fmtTime(p.info.duration)}` : ""}` };
}

// ═══════════════════════════════════════════════════════════════════════════
// Arg parsing (for commands only — tools get typed params from pi)
// ═══════════════════════════════════════════════════════════════════════════

function splitArgs(raw: string): string[] {
	const a: string[] = [];
	let cur = "", q = false, qc = "";
	for (const ch of raw) {
		if (!q && (ch === '"' || ch === "'")) { q = true; qc = ch; continue; }
		if (q && ch === qc) { q = false; continue; }
		if (!q && ch === " ") { if (cur) a.push(cur); cur = ""; continue; }
		cur += ch;
	}
	if (cur) a.push(cur);
	return a;
}

function popFlag(a: string[], flag: string): string | undefined {
	const i = a.indexOf(flag);
	if (i === -1) return undefined;
	const v = a[i + 1];
	a.splice(i, 2);
	return v;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension — thin wiring layer
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	let ready = false;

	pi.on("session_start", async () => {
		ready = !!which("ffmpeg");
		pi.setStatus({ icon: ready ? "🎬" : "⚠️", text: ready ? "ffmpeg ready" : "ffmpeg not found" });
	});

	const need = (ctx: any): boolean => {
		if (ready) return true;
		ctx.ui.notify(IS_WIN ? "ffmpeg not found. winget install ffmpeg" : "ffmpeg not found. brew/apt install ffmpeg", "error");
		return false;
	};

	// Tool result helpers
	const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
	const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("ffprobe", {
		description: "Inspect video/audio. /ffprobe <file>",
		handler: async (args, ctx) => {
			const file = args.trim();
			if (!file) { ctx.ui.notify("Usage: /ffprobe <file>", "warning"); return; }
			const r = opProbe(file);
			ctx.ui.notify(r.text, r.ok ? "info" : "error");
		},
	});

	pi.registerCommand("ffmpeg", {
		description: "Raw ffmpeg. /ffmpeg <args...>",
		handler: async (args, ctx) => {
			if (!need(ctx) || !args.trim()) { ctx.ui.notify("Usage: /ffmpeg -i in.mp4 out.mp4", "warning"); return; }
			ctx.ui.notify(`🎬 ffmpeg ${args}`, "info");
			const r = ff(splitArgs(args));
			ctx.ui.notify(r.ok ? "✅ Done" : `❌ ${r.stderr.slice(-400)}`, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("transcode", {
		description: "/transcode <in> <out> [--codec h264|h265|vp9|copy] [--crf N] [--scale W:H] [--fps N] [--no-audio]",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			const codec = popFlag(p, "--codec"); const crf = popFlag(p, "--crf");
			const preset = popFlag(p, "--preset"); const scale = popFlag(p, "--scale");
			const fps = popFlag(p, "--fps"); const noAudio = p.includes("--no-audio");
			if (noAudio) p.splice(p.indexOf("--no-audio"), 1);
			if (!p[0]) { ctx.ui.notify("Usage: /transcode <in> [out] [opts]", "warning"); return; }
			ctx.ui.notify(`🎬 Transcoding...`, "info");
			const r = opTranscode({ input: p[0], output: p[1] || autoOut(p[0], "_transcoded"), codec, crf: crf ? +crf : undefined, preset, scale, fps: fps ? +fps : undefined, noAudio });
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("trim", {
		description: "/trim <file> <start> [end] [output]",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			if (p.length < 2) { ctx.ui.notify("Usage: /trim <file> <start> [end] [output]", "warning"); return; }
			const [input, start] = p;
			let end: string | undefined, output: string;
			if (p.length >= 4) { end = p[2]; output = p[3]; }
			else if (p.length === 3 && p[2].match(/^\d/) && !p[2].includes(".mp")) { end = p[2]; output = autoOut(input, "_trimmed"); }
			else { output = p[2] || autoOut(input, "_trimmed"); }
			const r = opTrim(input, start, end, output);
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("concat", {
		description: "/concat <file1> <file2> [file3...] <output>",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			if (p.length < 3) { ctx.ui.notify("Usage: /concat <f1> <f2> ... <out>", "warning"); return; }
			const r = opConcat(p.slice(0, -1), p[p.length - 1]);
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("gif", {
		description: "/gif <file> [out.gif] [--fps 10] [--width 480] [--start T] [--duration T]",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			const fps = +(popFlag(p, "--fps") || 10), width = +(popFlag(p, "--width") || 480);
			const start = popFlag(p, "--start"), dur = popFlag(p, "--duration");
			if (!p[0]) { ctx.ui.notify("Usage: /gif <file> [out.gif]", "warning"); return; }
			ctx.ui.notify(`🎞️ Creating GIF...`, "info");
			const r = opGif(p[0], p[1] || autoOut(p[0], "", ".gif"), fps, width, start, dur);
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("frames", {
		description: "/frames <file> [outDir] [--fps 1]",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			const fps = +(popFlag(p, "--fps") || 1);
			if (!p[0]) { ctx.ui.notify("Usage: /frames <file> [outDir]", "warning"); return; }
			const r = opFrames(p[0], p[1] || autoOut(p[0], "_frames", ""), fps);
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("thumbnail", {
		description: "/thumbnail <file> [output.jpg] [time]",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			if (!p[0]) { ctx.ui.notify("Usage: /thumbnail <file> [out.jpg] [time]", "warning"); return; }
			const r = opThumbnail(p[0], p[1] || autoOut(p[0], "_thumb", ".jpg"), p[2] || "00:00:01");
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("extractaudio", {
		description: "/extractaudio <video> [output.mp3]",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			if (!p[0]) { ctx.ui.notify("Usage: /extractaudio <video> [out]", "warning"); return; }
			// Auto-detect codec for lossless extraction
			let ext = ".mp3";
			const info = opProbe(p[0]).info;
			if (info) { const c = info.audioCodec; ext = c === "aac" ? ".aac" : c === "opus" ? ".opus" : c === "flac" ? ".flac" : c === "vorbis" ? ".ogg" : ".mp3"; }
			const r = opExtractAudio(p[0], p[1] || autoOut(p[0], "_audio", ext));
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("addaudio", {
		description: "/addaudio <video> <audio> [output]",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			if (p.length < 2) { ctx.ui.notify("Usage: /addaudio <video> <audio> [out]", "warning"); return; }
			const r = opAddAudio(p[0], p[1], p[2] || autoOut(p[0], "_muxed"));
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("compress", {
		description: "/compress <file> [output] [crf=28]",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			if (!p[0]) { ctx.ui.notify("Usage: /compress <file> [out] [crf]", "warning"); return; }
			const crf = +(p.find(x => /^\d+$/.test(x) && x !== p[0]) || 28);
			const out = p.find(x => x !== p[0] && x !== String(crf) && x.includes(".")) || autoOut(p[0], "_compressed");
			ctx.ui.notify(`📦 Compressing (CRF ${crf})...`, "info");
			const r = opCompress(p[0], out, crf);
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("speed", {
		description: "/speed <file> <factor> [output] — 2 = 2× faster, 0.5 = half speed",
		handler: async (args, ctx) => {
			if (!need(ctx)) return;
			const p = splitArgs(args);
			if (p.length < 2) { ctx.ui.notify("Usage: /speed <file> <factor> [out]", "warning"); return; }
			const factor = parseFloat(p[1]);
			if (isNaN(factor) || factor <= 0) { ctx.ui.notify("Factor must be a positive number", "error"); return; }
			const r = opSpeed(p[0], p[2] || autoOut(p[0], `_${factor}x`), factor);
			ctx.ui.notify(r.text, r.ok ? "success" : "error");
		},
	});

	pi.registerCommand("ffmpeg-help", {
		description: "Show pi-ffmpeg commands",
		handler: async (_a, ctx) => {
			ctx.ui.notify(
				`🎬 pi-ffmpeg  ffmpeg: ${ready ? "✅" : "❌"}\n\n` +
				`/ffprobe <file>                    inspect metadata\n` +
				`/transcode <in> <out> [opts]       codec/res/fps\n` +
				`/compress <file> [out] [crf]       quick h264 compress\n` +
				`/speed <file> <factor> [out]       speed up/slow down\n` +
				`/trim <file> <start> [end] [out]   cut clip\n` +
				`/concat <f1> <f2> ... <out>        join files\n` +
				`/addaudio <video> <audio> [out]    mux audio\n` +
				`/extractaudio <video> [out]        rip audio\n` +
				`/gif <file> [out] [--fps] [--width] animated GIF\n` +
				`/frames <file> [dir] [--fps]       extract PNGs\n` +
				`/thumbnail <file> [out] [time]     single frame\n` +
				`/ffmpeg <args...>                  raw command`, "info");
		},
	});

	// ── LLM Tools — thin wrappers over the same op* functions ─────────────

	pi.registerTool({
		name: "ffmpeg_probe", label: "ffprobe",
		description: "Get video/audio metadata: duration, resolution, codec, bitrate, audio info",
		parameters: Type.Object({ file: Type.String({ description: "File path" }) }),
		async execute(_id, p) { const r = opProbe(p.file); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_transcode", label: "Transcode",
		description: "Convert video: codec (h264/h265/vp9), resolution, fps, trim, strip audio",
		parameters: Type.Object({
			input: Type.String(), output: Type.String(),
			codec: Type.Optional(Type.String({ description: "h264|h265|vp9|copy" })),
			crf: Type.Optional(Type.Number()), preset: Type.Optional(Type.String()),
			scale: Type.Optional(Type.String({ description: "e.g. 1280:720" })),
			fps: Type.Optional(Type.Number()), start: Type.Optional(Type.String()),
			duration: Type.Optional(Type.String()), noAudio: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, p) { const r = opTranscode(p); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_trim", label: "Trim",
		description: "Cut a segment (stream copy — fast)",
		parameters: Type.Object({
			input: Type.String(), output: Type.String(),
			start: Type.String({ description: "e.g. 00:01:30 or 90" }),
			end: Type.Optional(Type.String()),
		}),
		async execute(_id, p) { const r = opTrim(p.input, p.start, p.end, p.output); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_concat", label: "Concat",
		description: "Join multiple files (same codec)",
		parameters: Type.Object({
			files: Type.Array(Type.String(), { description: "Paths in order" }),
			output: Type.String(),
		}),
		async execute(_id, p) { const r = opConcat(p.files, p.output); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_gif", label: "GIF",
		description: "Video → optimized animated GIF",
		parameters: Type.Object({
			input: Type.String(), output: Type.String(),
			fps: Type.Optional(Type.Number({ description: "default 10" })),
			width: Type.Optional(Type.Number({ description: "default 480" })),
			start: Type.Optional(Type.String()), duration: Type.Optional(Type.String()),
		}),
		async execute(_id, p) { const r = opGif(p.input, p.output, p.fps, p.width, p.start, p.duration); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_frames", label: "Frames",
		description: "Extract frames as PNG/JPG images",
		parameters: Type.Object({
			input: Type.String(), outDir: Type.String(),
			fps: Type.Optional(Type.Number({ description: "default 1" })),
			format: Type.Optional(Type.String({ description: "png|jpg" })),
		}),
		async execute(_id, p) { const r = opFrames(p.input, p.outDir, p.fps, p.format); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_thumbnail", label: "Thumbnail",
		description: "Extract single frame as image",
		parameters: Type.Object({
			input: Type.String(), output: Type.String(),
			time: Type.Optional(Type.String({ description: "default 00:00:01" })),
		}),
		async execute(_id, p) { const r = opThumbnail(p.input, p.output, p.time); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_extract_audio", label: "Extract audio",
		description: "Rip audio track from video",
		parameters: Type.Object({ input: Type.String(), output: Type.String() }),
		async execute(_id, p) { const r = opExtractAudio(p.input, p.output); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_add_audio", label: "Add audio",
		description: "Mux audio onto video",
		parameters: Type.Object({
			video: Type.String(), audio: Type.String(), output: Type.String(),
			shortest: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, p) { const r = opAddAudio(p.video, p.audio, p.output, p.shortest); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_compress", label: "Compress",
		description: "Quick h264 compress with CRF quality control",
		parameters: Type.Object({
			input: Type.String(), output: Type.String(),
			crf: Type.Optional(Type.Number({ description: "0-51, default 28, lower=better" })),
		}),
		async execute(_id, p) { const r = opCompress(p.input, p.output, p.crf); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_speed", label: "Speed",
		description: "Speed up/slow down video+audio. 2 = 2× faster, 0.5 = half speed.",
		parameters: Type.Object({
			input: Type.String(), output: Type.String(),
			factor: Type.Number({ description: "e.g. 2 for 2× speed" }),
		}),
		async execute(_id, p) { const r = opSpeed(p.input, p.output, p.factor); return r.ok ? ok(r.text) : err(r.text); },
	});

	pi.registerTool({
		name: "ffmpeg_raw", label: "Raw ffmpeg",
		description: "Run any ffmpeg command (-y prepended)",
		parameters: Type.Object({ args: Type.Array(Type.String(), { description: "ffmpeg args" }) }),
		async execute(_id, p) { const r = ff(p.args); return r.ok ? ok("OK") : err(r.stderr.slice(-300)); },
	});
}
