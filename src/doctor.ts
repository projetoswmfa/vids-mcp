// Read-only health check of the machine vids-mcp runs on: which external programs it can find, where it looks for
// them, free disk and the optional features that are set up. Lets a remote Claude session see what is missing on a
// server it cannot log into. Never returns secrets.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statfsSync } from "node:fs";
import { homedir, platform, release, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { HOME_DIR, PROFILE_DIR } from "./chrome.js";
import { OUTPUT_ROOT } from "./core.js";
import { mediaConfigured } from "./media.js";

const run = promisify(execFile);
const IS_WIN = platform() === "win32";

// Service managers often start processes with a short PATH (no /usr/local/bin, no /snap/bin), which hides programs
// that a login shell finds. Add the usual folders at the end so they are found without changing anything else.
const USUAL = IS_WIN ? [] : ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", "/snap/bin", join(homedir(), ".local", "bin")];
export function widenPath(): void {
  const parts = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of USUAL) if (!parts.includes(dir)) parts.push(dir);
  process.env.PATH = parts.join(delimiter);
}

function which(cmd: string): string | undefined {
  if (cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd) ? cmd : undefined;
  const exts = IS_WIN ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = join(dir, cmd + ext);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {}
    }
  }
  return undefined;
}

async function tool(name: string, cmd: string, args: string[], fix: string) {
  const path = which(cmd);
  if (!path) return { name, found: false, looked_for: cmd, fix };
  try {
    const { stdout, stderr } = await run(path, args, { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const first = `${stdout}\n${stderr}`.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    return { name, found: true, path, version: first.slice(0, 160) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    const first = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.split("\n").map((l) => l.trim()).find(Boolean) ?? String(e.code ?? "");
    // whisper-cli and some others exit non-zero on --help; finding and starting it is what matters.
    return { name, found: true, path, version: first.slice(0, 160) };
  }
}

function disk(dir: string) {
  try {
    let d = dir;
    while (!existsSync(d)) d = join(d, "..");
    const s = statfsSync(d);
    return { path: dir, free_gb: +((s.bavail * s.bsize) / 1e9).toFixed(1), total_gb: +((s.blocks * s.bsize) / 1e9).toFixed(1) };
  } catch {
    return { path: dir, free_gb: null };
  }
}

function models(): string[] {
  const dirs = [join(HOME_DIR, "models"), join(homedir(), ".cache", "whisper-models"), join(homedir(), ".cache", "whisper.cpp")];
  return dirs.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".bin")).map((f) => join(d, f)) : []));
}

export async function doctor() {
  const apt = "sudo apt update && sudo apt install -y ffmpeg";
  const whisperFix =
    "sudo apt install -y git cmake build-essential && git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git ~/whisper.cpp && cmake -S ~/whisper.cpp -B ~/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release && cmake --build ~/whisper.cpp/build -j --config Release && sudo cp ~/whisper.cpp/build/bin/whisper-cli /usr/local/bin/ && rm -rf ~/whisper.cpp";
  const tools = await Promise.all([
    tool("ffmpeg", process.env.VIDS_MCP_FFMPEG ?? "ffmpeg", ["-version"], apt),
    tool("ffprobe", process.env.VIDS_MCP_FFPROBE ?? "ffprobe", ["-version"], apt),
    tool("whisper-cli (transcription, captions)", process.env.VIDS_MCP_WHISPER ?? "whisper-cli", ["--help"], whisperFix),
    tool("git (media mailbox)", "git", ["--version"], "sudo apt install -y git"),
  ]);
  const inContainer = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
  const missing = tools.filter((t) => !t.found).map((t) => t.name);
  return {
    ok: missing.length === 0,
    missing,
    tools,
    machine: {
      platform: `${platform()} ${release()}`,
      node: process.version,
      user: (() => {
        try {
          return userInfo().username;
        } catch {
          return undefined;
        }
      })(),
      in_container: inContainer,
      path_searched: (process.env.PATH ?? "").split(delimiter).filter(Boolean),
    },
    disk: [disk(OUTPUT_ROOT), disk(HOME_DIR)],
    features: {
      chrome_profile: existsSync(PROFILE_DIR),
      media_mailbox: mediaConfigured(),
      retention_hours: Number(process.env.VIDS_MCP_RETENTION_HOURS ?? (mediaConfigured() ? 24 : 0)),
      whisper_models: models(),
      remote_mcp: Boolean(process.env.VIDS_MCP_PATH_SECRET) || existsSync(join(HOME_DIR, "path-secret")),
    },
    note: inContainer
      ? "vids-mcp runs inside a container: install missing programs in the container image, not on the host."
      : missing.length
        ? "Install what is missing with the `fix` command on the server (as the user that runs vids-mcp), then call vids_doctor again. No restart needed."
        : "Everything vids-mcp uses is installed.",
  };
}
