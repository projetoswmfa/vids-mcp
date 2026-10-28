import { execFile } from "node:child_process";
import { FFMPEG_HINT } from "./platform.js";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.VIDS_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.VIDS_MCP_FFPROBE ?? "ffprobe";

const missing = (err: unknown) => ((err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err));

export async function duration(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return Number(stdout.trim());
}

// Vids' Estender hands back the source clip AND its continuation as one file (3 s + 3 s came back as 6.0 s, opening on
// the source's first frame; 2026-10-28). Cutting the source's length off the front leaves only the new part, so a film
// made of scene-01 + scene-02 does not play scene-01 twice. Re-encoded so the cut lands on the exact frame.
export async function dropHead(full: string, source: string, out: string): Promise<{ file: string; kept: number } | undefined> {
  try {
    const [whole, head] = [await duration(full), await duration(source)];
    if (!(whole > head + 0.5)) return undefined;
    await run(FFMPEG, ["-y", "-ss", head.toFixed(3), "-i", full, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", out]);
    return { file: out, kept: Number((whole - head).toFixed(2)) };
  } catch (err) {
    throw new Error(`Could not cut the extension apart from its source clip: ${missing(err)}`);
  }
}
