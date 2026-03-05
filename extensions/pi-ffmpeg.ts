/**
 * pi-ffmpeg — ffmpeg Swiss Army knife for pi
 *
 * Commands:
 *   /ffprobe <file>                    — inspect video/audio metadata
 *   /ffmpeg <args...>                  — run raw ffmpeg command
 *   /transcode <in> <out> [opts]       — convert format/codec/resolution
 *   /trim <file> <start> [end] [out]   — cut a clip
 *   /concat <file1> <file2> ... <out>  — join files
 *   /gif <file> [out] [--fps N] [--width N] [--start T] [--duration T]
 *   /frames <file> [outDir] [--fps N]  — extract frames as images
 *   /thumbnail <file> [out] [time]     — grab a single frame
 *   /extractaudio <file> [out]         — rip audio track
 *   /addaudio <video> <audio> [out]    — mux audio onto video
 *   /compress <file> [out] [crf]       — quick compress (h264, crf 28)
 *   /speed <file> <factor> [out]       — speed up / slow down
 *   /ffmpeg-help                       — show all commands
 *
 * LLM tools:
 *   ffmpeg_probe, ffmpeg_transcode, ffmpeg_trim, ffmpeg_concat,
 *   ffmpeg_gif, ffmpeg_frames, ffmpeg_thumbnail, ffmpeg_extract_audio,
 *   ffmpeg_add_audio, ffmpeg_compress, ffmpeg_speed, ffmpeg_raw
 *
 * Requires: ffmpeg + ffprobe in PATH
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, basename, extname, dirname, join } from "node:path";
import { platform, homedir, tmpdir } from "node:os";

const IS_WIN = platform() === "win32";

// ── Helpers ────────────────────────────────────────────────────────────────

function which(cmd: string): string | null {
	try {
		return execSync(
			IS_WIN ? `where "${cmd}" 2>nul` : `command -v "${cmd}" 2>/dev/null`,
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
		).trim().split(/\r?\n/)[0].trim() || null;
	} catch { return null; }
}

function run(cmd: string, args: string[]): { stdout: string; stderr: string; ok: boolean } {
	try {
		const stdout = execFileSync(cmd, args, {
			encoding: "utf-8",
			timeout: 600_000, // 10 min max
			maxBuffer: 50 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "", ok: true };
	} catch (e: any) {
		return {
			stdout: e.stdout?.toString() ?? "",
			stderr: e.stderr?.toString() ?? e.message,
			ok: false,
		};
	}
}

function fmtBytes(b: number): string {
	if (b < 1024) return `${b}B`;
	if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
	if (b < 1073741824) return `${(b / 1048576).toFixed(1)}MB`;
	return `${(b / 1073741824).toFixed(2)}GB`;
}

function fmtDuration(s: number): string {
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
	return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

// ── Probe ──────────────────────────────────────────────────────────────────

interface ProbeInfo {
	duration: number;
	width: number;
	height: number;
	fps: number;
	codec: string;
	audioCodec: string;
	bitrate: number;
	size: string;
	channels: number;
	sampleRate: number;
}

function probeFile(file: string): ProbeInfo {
	const r = run("ffprobe", [
		"-v", "quiet", "-print_format", "json",
		"-show_format", "-show_streams", resolve(file),
	]);
	if (!r.ok) throw new Error(`ffprobe failed: ${r.stderr.slice(-300)}`);
	const data = JSON.parse(r.stdout);
	const vs = data.streams?.find((s: any) => s.codec_type === "video");
	const as2 = data.streams?.find((s: any) => s.codec_type === "audio");
	const fmt = data.format || {};
	const fpsStr = vs?.r_frame_rate || "0/1";
	const [num, den] = fpsStr.split("/").map(Number);
	return {
		duration: parseFloat(fmt.duration || "0"),
		width: vs?.width || 0,
		height: vs?.height || 0,
		fps: den ? num / den : num || 0,
		codec: vs?.codec_name || (as2 ? "audio-only" : "unknown"),
		audioCodec: as2?.codec_name || "none",
		bitrate: Math.round(parseInt(fmt.bit_rate || "0") / 1000),
		size: fmt.size ? fmtBytes(parseInt(fmt.size)) : "?",
		channels: as2?.channels || 0,
		sampleRate: parseInt(as2?.sample_rate || "0"),
	};
}

function probeText(file: string, info: ProbeInfo): string {
	const lines: string[] = [`📹 ${basename(file)}`];
	lines.push(`   Duration:    ${fmtDuration(info.duration)}`);
	lines.push(`   Size:        ${info.size} (${info.bitrate} kbps)`);
	if (info.width > 0) {
		lines.push(`   Video:       ${info.width}×${info.height} @ ${info.fps.toFixed(1)} fps (${info.codec})`);
	}
	if (info.audioCodec !== "none") {
		lines.push(`   Audio:       ${info.audioCodec}${info.channels ? ` ${info.channels}ch` : ""}${info.sampleRate ? ` ${info.sampleRate}Hz` : ""}`);
	}
	return lines.join("\n");
}

// ── Auto output name ───────────────────────────────────────────────────────

function autoOut(input: string, suffix: string, ext?: string): string {
	const dir = dirname(resolve(input));
	const name = basename(input, extname(input));
	return join(dir, `${name}${suffix}${ext || extname(input)}`);
}

// ── Parse timestamp args ───────────────────────────────────────────────────

function parseArgs(raw: string): string[] {
	// Respect quoted strings
	const args: string[] = [];
	let current = "";
	let inQuote = false;
	let quoteChar = "";
	for (const ch of raw) {
		if (!inQuote && (ch === '"' || ch === "'")) { inQuote = true; quoteChar = ch; continue; }
		if (inQuote && ch === quoteChar) { inQuote = false; continue; }
		if (!inQuote && ch === " ") { if (current) args.push(current); current = ""; continue; }
		current += ch;
	}
	if (current) args.push(current);
	return args;
}

function extractFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1) return undefined;
	const val = args[idx + 1];
	args.splice(idx, 2);
	return val;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	let ffmpegPath: string | null = null;
	let ffprobePath: string | null = null;

	pi.on("session_start", async () => {
		ffmpegPath = which("ffmpeg");
		ffprobePath = which("ffprobe");
		if (ffmpegPath) {
			pi.setStatus({ icon: "🎬", text: "ffmpeg ready" });
		} else {
			pi.setStatus({ icon: "⚠️", text: "ffmpeg not found" });
		}
	});

	function requireFF(ctx: any): boolean {
		if (!ffmpegPath) {
			ctx.ui.notify(
				IS_WIN ? "ffmpeg not found. Install: winget install ffmpeg" :
				"ffmpeg not found. Install: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)",
				"error",
			);
			return false;
		}
		return true;
	}

	// ── /ffprobe ───────────────────────────────────────────────────────────
	pi.registerCommand("ffprobe", {
		description: "Inspect a video/audio file. Usage: /ffprobe <file>",
		handler: async (args, ctx) => {
			const file = args.trim();
			if (!file) { ctx.ui.notify("Usage: /ffprobe <file>", "warning"); return; }
			if (!existsSync(resolve(file))) { ctx.ui.notify(`File not found: ${file}`, "error"); return; }
			try {
				const info = probeFile(file);
				ctx.ui.notify(probeText(file, info), "info");
			} catch (e: any) {
				ctx.ui.notify(`❌ ${e.message}`, "error");
			}
		},
	});

	// ── /ffmpeg (raw) ──────────────────────────────────────────────────────
	pi.registerCommand("ffmpeg", {
		description: "Run raw ffmpeg command. Usage: /ffmpeg <args...>",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			if (!args.trim()) { ctx.ui.notify("Usage: /ffmpeg -i input.mp4 -c:v libx264 output.mp4", "warning"); return; }
			ctx.ui.notify(`🎬 Running: ffmpeg ${args}`, "info");
			const r = run("ffmpeg", ["-y", ...parseArgs(args)]);
			if (r.ok) ctx.ui.notify("✅ Done", "success");
			else ctx.ui.notify(`❌ ffmpeg error:\n${r.stderr.slice(-500)}`, "error");
		},
	});

	// ── /transcode ─────────────────────────────────────────────────────────
	pi.registerCommand("transcode", {
		description: [
			"Transcode video. Usage: /transcode <in> <out> [options]",
			"  --codec h264|h265|vp9|copy   --crf 0-51   --preset ultrafast..veryslow",
			"  --scale 1280:720   --fps 30   --no-audio",
		].join("\n"),
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			const codec = extractFlag(parts, "--codec");
			const crf = extractFlag(parts, "--crf");
			const preset = extractFlag(parts, "--preset");
			const scale = extractFlag(parts, "--scale");
			const fps = extractFlag(parts, "--fps");
			const noAudio = parts.includes("--no-audio");
			if (noAudio) parts.splice(parts.indexOf("--no-audio"), 1);

			const input = parts[0];
			const output = parts[1] || autoOut(input, "_transcoded");
			if (!input) { ctx.ui.notify("Usage: /transcode <input> [output] [--codec h264] [--crf 23]", "warning"); return; }

			const ffArgs: string[] = ["-y", "-i", resolve(input)];
			if (codec && codec !== "copy") {
				const vCodec = codec === "h265" ? "libx265" : codec === "vp9" ? "libvpx-vp9" : "libx264";
				ffArgs.push("-c:v", vCodec);
			} else if (codec === "copy") {
				ffArgs.push("-c", "copy");
			}
			if (crf) ffArgs.push("-crf", crf);
			if (preset) ffArgs.push("-preset", preset);
			if (scale) ffArgs.push("-vf", `scale=${scale}`);
			if (fps) ffArgs.push("-r", fps);
			if (noAudio) ffArgs.push("-an");
			ffArgs.push(resolve(output));

			ctx.ui.notify(`🎬 Transcoding → ${basename(output)}...`, "info");
			const r = run("ffmpeg", ffArgs);
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			try {
				const info = probeFile(output);
				ctx.ui.notify(`✅ ${basename(output)} — ${info.width}×${info.height} ${info.codec} ${fmtDuration(info.duration)} ${info.size}`, "success");
			} catch {
				ctx.ui.notify(`✅ ${output}`, "success");
			}
		},
	});

	// ── /trim ──────────────────────────────────────────────────────────────
	pi.registerCommand("trim", {
		description: "Trim a clip. Usage: /trim <file> <start> [end] [output]\n  Times: 00:01:30 or 90 (seconds)",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			if (parts.length < 2) { ctx.ui.notify("Usage: /trim <file> <start> [end] [output]", "warning"); return; }
			const input = parts[0];
			const start = parts[1];
			const end = parts.length >= 3 && !parts[2].includes(".") ? undefined : parts[2]; // heuristic: if no dot, likely a time
			let output: string;
			let duration: string | undefined;

			// Figure out which args are time vs filename
			if (parts.length === 4) {
				duration = parts[2]; // actually end time → compute duration
				output = parts[3];
			} else if (parts.length === 3) {
				// Could be end-time or output filename
				if (parts[2].match(/^\d/) && !parts[2].includes(".mp")) {
					duration = parts[2];
					output = autoOut(input, "_trimmed");
				} else {
					output = parts[2];
				}
			} else {
				output = autoOut(input, "_trimmed");
			}

			const ffArgs: string[] = ["-y", "-ss", start];
			if (duration) ffArgs.push("-to", duration);
			ffArgs.push("-i", resolve(input), "-c", "copy", resolve(output));

			ctx.ui.notify(`✂️ Trimming ${basename(input)} from ${start}${duration ? ` to ${duration}` : ""}...`, "info");
			const r = run("ffmpeg", ffArgs);
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			try {
				const info = probeFile(output);
				ctx.ui.notify(`✅ ${basename(output)} — ${fmtDuration(info.duration)} ${info.size}`, "success");
			} catch {
				ctx.ui.notify(`✅ ${output}`, "success");
			}
		},
	});

	// ── /concat ────────────────────────────────────────────────────────────
	pi.registerCommand("concat", {
		description: "Join files. Usage: /concat <file1> <file2> [file3...] <output>",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			if (parts.length < 3) { ctx.ui.notify("Usage: /concat <file1> <file2> [file3...] <output>", "warning"); return; }
			const output = parts.pop()!;
			const files = parts;

			const listPath = join(tmpdir(), `.pi-ffmpeg-concat-${Date.now()}.txt`);
			writeFileSync(listPath, files.map(f => `file '${resolve(f).replace(/'/g, "'\\''")}'`).join("\n"));
			ctx.ui.notify(`🔗 Joining ${files.length} files → ${basename(output)}...`, "info");
			const r = run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", resolve(output)]);
			try { unlinkSync(listPath); } catch {}
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			ctx.ui.notify(`✅ ${basename(output)} (${files.length} files joined)`, "success");
		},
	});

	// ── /gif ───────────────────────────────────────────────────────────────
	pi.registerCommand("gif", {
		description: "Video → GIF. Usage: /gif <file> [output.gif] [--fps 10] [--width 480] [--start T] [--duration T]",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			const fps = extractFlag(parts, "--fps") || "10";
			const width = extractFlag(parts, "--width") || "480";
			const start = extractFlag(parts, "--start");
			const duration = extractFlag(parts, "--duration");
			const input = parts[0];
			const output = parts[1] || autoOut(input, "", ".gif");
			if (!input) { ctx.ui.notify("Usage: /gif <file> [output.gif]", "warning"); return; }

			const ffArgs: string[] = ["-y"];
			if (start) ffArgs.push("-ss", start);
			if (duration) ffArgs.push("-t", duration);
			ffArgs.push("-i", resolve(input));
			ffArgs.push("-vf", `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`);
			ffArgs.push("-loop", "0", resolve(output));

			ctx.ui.notify(`🎞️ Creating GIF (${width}px, ${fps}fps)...`, "info");
			const r = run("ffmpeg", ffArgs);
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			ctx.ui.notify(`✅ ${basename(output)}`, "success");
		},
	});

	// ── /frames ────────────────────────────────────────────────────────────
	pi.registerCommand("frames", {
		description: "Extract frames. Usage: /frames <file> [outDir] [--fps 1]",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			const fps = extractFlag(parts, "--fps") || "1";
			const input = parts[0];
			const outDir = parts[1] || join(dirname(resolve(input)), basename(input, extname(input)) + "_frames");
			if (!input) { ctx.ui.notify("Usage: /frames <file> [outDir] [--fps 1]", "warning"); return; }

			mkdirSync(resolve(outDir), { recursive: true });
			ctx.ui.notify(`📸 Extracting frames @ ${fps} fps...`, "info");
			const r = run("ffmpeg", ["-y", "-i", resolve(input), "-vf", `fps=${fps}`, join(resolve(outDir), "frame_%04d.png")]);
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			// Count output
			try {
				const count = execSync(IS_WIN ? `dir /b "${resolve(outDir)}\\frame_*.png" | find /c /v ""` : `ls -1 "${resolve(outDir)}"/frame_*.png | wc -l`,
					{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
				ctx.ui.notify(`✅ ${count} frames → ${outDir}`, "success");
			} catch {
				ctx.ui.notify(`✅ Frames → ${outDir}`, "success");
			}
		},
	});

	// ── /thumbnail ─────────────────────────────────────────────────────────
	pi.registerCommand("thumbnail", {
		description: "Grab a frame. Usage: /thumbnail <file> [output.jpg] [time]",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			const input = parts[0];
			const output = parts[1] || autoOut(input, "_thumb", ".jpg");
			const time = parts[2] || "00:00:01";
			if (!input) { ctx.ui.notify("Usage: /thumbnail <file> [output.jpg] [time]", "warning"); return; }

			const r = run("ffmpeg", ["-y", "-ss", time, "-i", resolve(input), "-frames:v", "1", "-q:v", "2", resolve(output)]);
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			ctx.ui.notify(`✅ ${basename(output)} @ ${time}`, "success");
		},
	});

	// ── /extractaudio ──────────────────────────────────────────────────────
	pi.registerCommand("extractaudio", {
		description: "Rip audio from video. Usage: /extractaudio <video> [output.mp3]",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			const input = parts[0];
			if (!input) { ctx.ui.notify("Usage: /extractaudio <video> [output]", "warning"); return; }

			// Detect audio codec to choose best output format
			let outExt = ".mp3";
			try {
				const info = probeFile(input);
				if (info.audioCodec === "aac") outExt = ".aac";
				else if (info.audioCodec === "opus") outExt = ".opus";
				else if (info.audioCodec === "flac") outExt = ".flac";
				else if (info.audioCodec === "vorbis") outExt = ".ogg";
			} catch {}

			const output = parts[1] || autoOut(input, "_audio", outExt);
			const useCopy = output.endsWith(outExt); // can copy if matching
			const ffArgs = ["-y", "-i", resolve(input), "-vn"];
			if (useCopy) ffArgs.push("-c:a", "copy");
			ffArgs.push(resolve(output));

			ctx.ui.notify(`🎵 Extracting audio → ${basename(output)}...`, "info");
			const r = run("ffmpeg", ffArgs);
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			ctx.ui.notify(`✅ ${basename(output)}`, "success");
		},
	});

	// ── /addaudio ──────────────────────────────────────────────────────────
	pi.registerCommand("addaudio", {
		description: "Mux audio onto video. Usage: /addaudio <video> <audio> [output]",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			if (parts.length < 2) { ctx.ui.notify("Usage: /addaudio <video> <audio> [output]", "warning"); return; }
			const video = parts[0];
			const audio = parts[1];
			const output = parts[2] || autoOut(video, "_muxed");

			ctx.ui.notify(`🔊 Muxing audio → ${basename(output)}...`, "info");
			const r = run("ffmpeg", ["-y", "-i", resolve(video), "-i", resolve(audio), "-c:v", "copy", "-c:a", "aac", "-shortest", resolve(output)]);
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			ctx.ui.notify(`✅ ${basename(output)}`, "success");
		},
	});

	// ── /compress ──────────────────────────────────────────────────────────
	pi.registerCommand("compress", {
		description: "Quick compress (h264). Usage: /compress <file> [output] [crf=28]",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			const input = parts[0];
			const crf = parts.find(p => /^\d+$/.test(p) && p !== input) || "28";
			const output = parts.find(p => p !== input && p !== crf && p.includes(".")) || autoOut(input, "_compressed");
			if (!input) { ctx.ui.notify("Usage: /compress <file> [output] [crf=28]", "warning"); return; }

			const sizeBefore = probeFile(input).size;
			ctx.ui.notify(`📦 Compressing (CRF ${crf})...`, "info");
			const r = run("ffmpeg", ["-y", "-i", resolve(input), "-c:v", "libx264", "-crf", crf, "-preset", "medium", "-c:a", "aac", "-b:a", "128k", resolve(output)]);
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			try {
				const info = probeFile(output);
				ctx.ui.notify(`✅ ${basename(output)} — ${sizeBefore} → ${info.size}`, "success");
			} catch {
				ctx.ui.notify(`✅ ${output}`, "success");
			}
		},
	});

	// ── /speed ─────────────────────────────────────────────────────────────
	pi.registerCommand("speed", {
		description: "Speed up / slow down. Usage: /speed <file> <factor> [output]\n  /speed clip.mp4 2     (2× speed)\n  /speed clip.mp4 0.5   (half speed)",
		handler: async (args, ctx) => {
			if (!requireFF(ctx)) return;
			const parts = parseArgs(args);
			if (parts.length < 2) { ctx.ui.notify("Usage: /speed <file> <factor> [output]", "warning"); return; }
			const input = parts[0];
			const factor = parseFloat(parts[1]);
			if (isNaN(factor) || factor <= 0) { ctx.ui.notify("Factor must be a positive number (e.g. 2 for 2× speed, 0.5 for half)", "error"); return; }
			const output = parts[2] || autoOut(input, `_${factor}x`);

			// Video: setpts=PTS/factor, Audio: atempo (must be between 0.5-2, chain for extremes)
			const videoFilter = `setpts=PTS/${factor}`;
			const atempoFilters: string[] = [];
			let remaining = factor;
			while (remaining > 2) { atempoFilters.push("atempo=2.0"); remaining /= 2; }
			while (remaining < 0.5) { atempoFilters.push("atempo=0.5"); remaining /= 0.5; }
			atempoFilters.push(`atempo=${remaining}`);

			ctx.ui.notify(`⏩ ${factor}× speed → ${basename(output)}...`, "info");
			const r = run("ffmpeg", ["-y", "-i", resolve(input), "-vf", videoFilter, "-af", atempoFilters.join(","), resolve(output)]);
			if (!r.ok) { ctx.ui.notify(`❌ ${r.stderr.slice(-400)}`, "error"); return; }
			try {
				const info = probeFile(output);
				ctx.ui.notify(`✅ ${basename(output)} — ${fmtDuration(info.duration)}`, "success");
			} catch {
				ctx.ui.notify(`✅ ${output}`, "success");
			}
		},
	});

	// ── /ffmpeg-help ───────────────────────────────────────────────────────
	pi.registerCommand("ffmpeg-help", {
		description: "Show pi-ffmpeg commands",
		handler: async (_a, ctx) => {
			const ok = ffmpegPath ? "✅" : "❌";
			const pk = ffprobePath ? "✅" : "❌";
			ctx.ui.notify(
				`🎬 pi-ffmpeg\n` +
				`  ffmpeg ${ok}  ffprobe ${pk}\n\n` +
				`INSPECT\n` +
				`  /ffprobe <file>                    metadata\n\n` +
				`CONVERT\n` +
				`  /transcode <in> <out> [opts]       codec/res/fps\n` +
				`  /compress <file> [out] [crf]       quick h264 compress\n` +
				`  /speed <file> <factor> [out]       speed up/slow down\n\n` +
				`EDIT\n` +
				`  /trim <file> <start> [end] [out]   cut a clip\n` +
				`  /concat <f1> <f2> ... <out>        join files\n` +
				`  /addaudio <video> <audio> [out]    mux audio\n` +
				`  /extractaudio <video> [out]        rip audio\n\n` +
				`EXPORT\n` +
				`  /gif <file> [out] [--fps] [--width]  animated GIF\n` +
				`  /frames <file> [dir] [--fps]         extract PNGs\n` +
				`  /thumbnail <file> [out] [time]       single frame\n\n` +
				`RAW\n` +
				`  /ffmpeg <args...>                  any ffmpeg command\n`,
				"info",
			);
		},
	});

	// ═══════════════════════════════════════════════════════════════════════
	// LLM Tools — let the model call ffmpeg directly
	// ═══════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "ffmpeg_probe",
		label: "ffprobe",
		description: "Get video/audio file metadata: duration, resolution, codec, bitrate, size, audio info",
		parameters: Type.Object({
			file: Type.String({ description: "Path to video or audio file" }),
		}),
		async execute(_id, params) {
			try {
				const info = probeFile(params.file);
				return { content: [{ type: "text", text: probeText(params.file, info) }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: e.message }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ffmpeg_transcode",
		label: "Transcode video",
		description: "Convert video: change codec (h264/h265/vp9), resolution, framerate, trim, strip audio",
		parameters: Type.Object({
			input: Type.String({ description: "Input file path" }),
			output: Type.String({ description: "Output file path" }),
			codec: Type.Optional(Type.String({ description: "h264 | h265 | vp9 | copy" })),
			crf: Type.Optional(Type.Number({ description: "Quality 0-51, lower=better (default 23)" })),
			preset: Type.Optional(Type.String({ description: "ultrafast → veryslow" })),
			scale: Type.Optional(Type.String({ description: "Resolution e.g. 1280:720 or 1920:-1" })),
			fps: Type.Optional(Type.Number({ description: "Target framerate" })),
			start: Type.Optional(Type.String({ description: "Start time e.g. 00:01:30" })),
			duration: Type.Optional(Type.String({ description: "Duration e.g. 00:00:10" })),
			noAudio: Type.Optional(Type.Boolean({ description: "Strip audio track" })),
		}),
		async execute(_id, p) {
			const ffArgs: string[] = ["-y"];
			if (p.start) ffArgs.push("-ss", p.start);
			if (p.duration) ffArgs.push("-t", p.duration);
			ffArgs.push("-i", resolve(p.input));
			if (p.codec && p.codec !== "copy") {
				ffArgs.push("-c:v", p.codec === "h265" ? "libx265" : p.codec === "vp9" ? "libvpx-vp9" : "libx264");
			} else if (p.codec === "copy") ffArgs.push("-c", "copy");
			if (p.crf !== undefined) ffArgs.push("-crf", String(p.crf));
			if (p.preset) ffArgs.push("-preset", p.preset);
			if (p.scale) ffArgs.push("-vf", `scale=${p.scale}`);
			if (p.fps) ffArgs.push("-r", String(p.fps));
			if (p.noAudio) ffArgs.push("-an");
			ffArgs.push(resolve(p.output));
			const r = run("ffmpeg", ffArgs);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: ${p.output}` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_trim",
		label: "Trim clip",
		description: "Cut a segment from a video/audio file (fast, stream copy)",
		parameters: Type.Object({
			input: Type.String({ description: "Input file" }),
			output: Type.String({ description: "Output file" }),
			start: Type.String({ description: "Start time e.g. 00:01:30 or 90" }),
			end: Type.Optional(Type.String({ description: "End time (if omitted, goes to end of file)" })),
		}),
		async execute(_id, p) {
			const ffArgs = ["-y", "-ss", p.start];
			if (p.end) ffArgs.push("-to", p.end);
			ffArgs.push("-i", resolve(p.input), "-c", "copy", resolve(p.output));
			const r = run("ffmpeg", ffArgs);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: ${p.output}` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_concat",
		label: "Concat files",
		description: "Join multiple video/audio files into one (same codec required for stream copy)",
		parameters: Type.Object({
			files: Type.Array(Type.String(), { description: "File paths in playback order" }),
			output: Type.String({ description: "Output file path" }),
		}),
		async execute(_id, p) {
			const listPath = join(tmpdir(), `.pi-ffmpeg-concat-${Date.now()}.txt`);
			writeFileSync(listPath, p.files.map(f => `file '${resolve(f).replace(/'/g, "'\\''")}'`).join("\n"));
			const r = run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", resolve(p.output)]);
			try { unlinkSync(listPath); } catch {}
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: ${p.output} (${p.files.length} files)` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_gif",
		label: "Video → GIF",
		description: "Convert a video clip to an optimized animated GIF with palette generation",
		parameters: Type.Object({
			input: Type.String({ description: "Input video" }),
			output: Type.String({ description: "Output GIF" }),
			fps: Type.Optional(Type.Number({ description: "GIF framerate (default 10)" })),
			width: Type.Optional(Type.Number({ description: "Width in pixels (default 480)" })),
			start: Type.Optional(Type.String({ description: "Start time" })),
			duration: Type.Optional(Type.String({ description: "Duration" })),
		}),
		async execute(_id, p) {
			const ffArgs: string[] = ["-y"];
			if (p.start) ffArgs.push("-ss", p.start);
			if (p.duration) ffArgs.push("-t", p.duration);
			ffArgs.push("-i", resolve(p.input));
			ffArgs.push("-vf", `fps=${p.fps || 10},scale=${p.width || 480}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[pg];[s1][pg]paletteuse`);
			ffArgs.push("-loop", "0", resolve(p.output));
			const r = run("ffmpeg", ffArgs);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: ${p.output}` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_frames",
		label: "Extract frames",
		description: "Extract frames from video as PNG/JPG images",
		parameters: Type.Object({
			input: Type.String({ description: "Input video" }),
			outDir: Type.String({ description: "Output directory" }),
			fps: Type.Optional(Type.Number({ description: "Frames per second (default 1)" })),
			format: Type.Optional(Type.String({ description: "png | jpg (default png)" })),
		}),
		async execute(_id, p) {
			mkdirSync(resolve(p.outDir), { recursive: true });
			const ext = p.format || "png";
			const r = run("ffmpeg", ["-y", "-i", resolve(p.input), "-vf", `fps=${p.fps || 1}`, join(resolve(p.outDir), `frame_%04d.${ext}`)]);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: frames → ${p.outDir}` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_thumbnail",
		label: "Grab thumbnail",
		description: "Extract a single video frame as an image file",
		parameters: Type.Object({
			input: Type.String({ description: "Input video" }),
			output: Type.String({ description: "Output image (e.g. thumb.jpg)" }),
			time: Type.Optional(Type.String({ description: "Timestamp (default 00:00:01)" })),
		}),
		async execute(_id, p) {
			const r = run("ffmpeg", ["-y", "-ss", p.time || "00:00:01", "-i", resolve(p.input), "-frames:v", "1", "-q:v", "2", resolve(p.output)]);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: ${p.output}` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_extract_audio",
		label: "Extract audio",
		description: "Rip the audio track from a video file",
		parameters: Type.Object({
			input: Type.String({ description: "Input video" }),
			output: Type.String({ description: "Output audio (e.g. track.mp3, track.aac)" }),
		}),
		async execute(_id, p) {
			const r = run("ffmpeg", ["-y", "-i", resolve(p.input), "-vn", "-c:a", "copy", resolve(p.output)]);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: ${p.output}` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_add_audio",
		label: "Add audio to video",
		description: "Mux an audio track onto a video file",
		parameters: Type.Object({
			video: Type.String({ description: "Input video" }),
			audio: Type.String({ description: "Audio file" }),
			output: Type.String({ description: "Output video" }),
			shortest: Type.Optional(Type.Boolean({ description: "Trim to shorter stream" })),
		}),
		async execute(_id, p) {
			const args = ["-y", "-i", resolve(p.video), "-i", resolve(p.audio), "-c:v", "copy", "-c:a", "aac"];
			if (p.shortest) args.push("-shortest");
			args.push(resolve(p.output));
			const r = run("ffmpeg", args);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: ${p.output}` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_compress",
		label: "Compress video",
		description: "Quick compress with h264 + adjustable CRF quality (higher CRF = smaller file, lower quality)",
		parameters: Type.Object({
			input: Type.String({ description: "Input video" }),
			output: Type.String({ description: "Output video" }),
			crf: Type.Optional(Type.Number({ description: "Quality 0-51 (default 28, lower=better)" })),
		}),
		async execute(_id, p) {
			const r = run("ffmpeg", ["-y", "-i", resolve(p.input), "-c:v", "libx264", "-crf", String(p.crf ?? 28), "-preset", "medium", "-c:a", "aac", "-b:a", "128k", resolve(p.output)]);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: ${p.output}` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_speed",
		label: "Change speed",
		description: "Speed up or slow down video+audio. Factor 2 = 2× faster, 0.5 = half speed.",
		parameters: Type.Object({
			input: Type.String({ description: "Input file" }),
			output: Type.String({ description: "Output file" }),
			factor: Type.Number({ description: "Speed factor (e.g. 2 for 2× speed, 0.5 for half)" }),
		}),
		async execute(_id, p) {
			if (p.factor <= 0) return { content: [{ type: "text", text: "Factor must be > 0" }], isError: true };
			const videoFilter = `setpts=PTS/${p.factor}`;
			const atempoFilters: string[] = [];
			let rem = p.factor;
			while (rem > 2) { atempoFilters.push("atempo=2.0"); rem /= 2; }
			while (rem < 0.5) { atempoFilters.push("atempo=0.5"); rem /= 0.5; }
			atempoFilters.push(`atempo=${rem}`);
			const r = run("ffmpeg", ["-y", "-i", resolve(p.input), "-vf", videoFilter, "-af", atempoFilters.join(","), resolve(p.output)]);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: `OK: ${p.output}` }] };
		},
	});

	pi.registerTool({
		name: "ffmpeg_raw",
		label: "Raw ffmpeg",
		description: "Run any ffmpeg command with custom arguments. -y is prepended automatically.",
		parameters: Type.Object({
			args: Type.Array(Type.String(), { description: "ffmpeg arguments as array (e.g. [\"-i\", \"in.mp4\", \"-c:v\", \"libx264\", \"out.mp4\"])" }),
		}),
		async execute(_id, p) {
			const r = run("ffmpeg", ["-y", ...p.args]);
			if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.stderr.slice(-300)}` }], isError: true };
			return { content: [{ type: "text", text: "OK" }] };
		},
	});
}
