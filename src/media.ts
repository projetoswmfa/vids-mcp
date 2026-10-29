// Media mailbox: moves files between this server and a remote Claude session through a private GitHub repository.
// Neither side can reach the other directly, but both can push and pull git.
//
// One branch per project, `media/<project>`:
//   in/<file>   sent to this server; vids_media_pull saves it in the project folder and removes it from the branch
//   out/<file>  sent from this server by vids_media_push; the other side downloads it and removes it
// vids_media_clean deletes the branch when the project is done, so the repository does not keep growing.
//
// The server never keeps a checkout: every call makes a shallow, blob-filtered, sparse clone of just the folder it
// needs in a temporary directory and deletes it afterwards. Pushed files are deleted locally by default, and with a
// retention set, files older than VIDS_MCP_RETENTION_HOURS in the output and upload folders are removed every hour.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { HOME_DIR } from "./chrome.js";
import { OUTPUT_ROOT, projectDir } from "./core.js";

const run = promisify(execFile);

const TOKEN = (process.env.VIDS_MCP_GITHUB_TOKEN ?? "").trim();
const REPO = (process.env.VIDS_MCP_MEDIA_REPO ?? "").trim();
const REMOTE_OVERRIDE = (process.env.VIDS_MCP_MEDIA_REMOTE ?? "").trim();
const PREFIX = (process.env.VIDS_MCP_MEDIA_BRANCH_PREFIX ?? "media/").trim();
const WORK_DIR = join(HOME_DIR, "mailbox-work");
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const MAX_FILE = 95 * 1024 * 1024; // GitHub rejects files over 100 MB in a push
const MEDIA_EXT = new Set([".mp4", ".webm", ".mov", ".gif", ".jpg", ".jpeg", ".png", ".webp", ".mp3", ".wav", ".m4a", ".srt", ".ass", ".json", ".txt"]);

const remoteUrl = () => REMOTE_OVERRIDE || (TOKEN && REPO ? `https://x-access-token:${TOKEN}@github.com/${REPO}.git` : "");
export const mediaConfigured = () => Boolean(remoteUrl());
const RETENTION_HOURS = Number(process.env.VIDS_MCP_RETENTION_HOURS ?? (mediaConfigured() ? 24 : 0));

const slug = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^[.-]+/, "") || "file";
export const branchFor = (project: string) => `${PREFIX}${slug(project)}`;

function requireConfig() {
  if (!mediaConfigured()) {
    throw new Error(
      "The media mailbox is not set up on this server. Set VIDS_MCP_MEDIA_REPO=<owner>/<private-repo> and VIDS_MCP_GITHUB_TOKEN=<token with Contents read/write on that repo> (or VIDS_MCP_MEDIA_REMOTE=<git URL, e.g. an SSH deploy key remote>), then restart vids-mcp.",
    );
  }
}

// Never let the token reach an error message or a log.
const scrub = (s: string) => (TOKEN ? s.split(TOKEN).join("***") : s).replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "vids-mcp", GIT_AUTHOR_EMAIL: "vids-mcp@localhost", GIT_COMMITTER_NAME: "vids-mcp", GIT_COMMITTER_EMAIL: "vids-mcp@localhost" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(scrub(`git ${args[0]} failed: ${(e.stderr || e.message || "").trim().slice(0, 500)}`));
  }
}

async function branchExists(branch: string): Promise<boolean> {
  return (await git(["ls-remote", "--heads", remoteUrl(), branch])).trim().length > 0;
}

// A throwaway sparse checkout of `folder` on the project's branch (created as an orphan branch if missing).
async function checkout(branch: string, folder: string): Promise<{ dir: string; exists: boolean }> {
  mkdirSync(WORK_DIR, { recursive: true });
  const dir = mkdtempSync(join(WORK_DIR, "co-"));
  const exists = await branchExists(branch);
  if (exists) {
    await git(["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--no-checkout", "--single-branch", "--branch", branch, remoteUrl(), dir]);
    await git(["sparse-checkout", "set", "--no-cone", `/${folder}/`], dir);
    await git(["checkout", "--quiet", branch], dir);
  } else {
    await git(["init", "--quiet", "-b", branch, dir]);
    await git(["remote", "add", "origin", remoteUrl()], dir);
  }
  return { dir, exists };
}

// Commit what is staged and push; on a race with the other side, rebase once on the new tip and push again.
async function commitAndPush(dir: string, branch: string, message: string): Promise<boolean> {
  if (!(await git(["status", "--porcelain"], dir)).trim()) return false;
  await git(["commit", "--quiet", "-m", message], dir);
  try {
    await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], dir);
  } catch {
    await git(["fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", branch], dir);
    await git(["rebase", "--quiet", "FETCH_HEAD"], dir);
    await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], dir);
  }
  return true;
}

const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);
const mb = (bytes: number) => +(bytes / 1048576).toFixed(2);

function pruneDir(dir: string, cutoff: number): { files: number; bytes: number } {
  const freed = { files: 0, bytes: 0 };
  if (!existsSync(dir)) return freed;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = pruneDir(path, cutoff);
      freed.files += sub.files;
      freed.bytes += sub.bytes;
      try {
        if (readdirSync(path).length === 0) rmdirSync(path);
      } catch {}
    } else if (entry.isFile()) {
      const st = statSync(path);
      if (st.mtimeMs < cutoff) {
        try {
          unlinkSync(path);
          freed.files++;
          freed.bytes += st.size;
        } catch {}
      }
    }
  }
  return freed;
}

export function prune(): { retention_hours: number; files_deleted: number; mb_freed: number } {
  // Leftover checkouts from an interrupted call go regardless of the retention.
  if (existsSync(WORK_DIR)) {
    for (const d of readdirSync(WORK_DIR)) {
      const p = join(WORK_DIR, d);
      try {
        if (Date.now() - statSync(p).mtimeMs > 3_600_000) rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }
  if (!(RETENTION_HOURS > 0)) return { retention_hours: 0, files_deleted: 0, mb_freed: 0 };
  const cutoff = Date.now() - RETENTION_HOURS * 3_600_000;
  const a = pruneDir(OUTPUT_ROOT, cutoff);
  const b = pruneDir(UPLOAD_DIR, cutoff);
  return { retention_hours: RETENTION_HOURS, files_deleted: a.files + b.files, mb_freed: mb(a.bytes + b.bytes) };
}

export function startRetention(): void {
  const tick = () => {
    try {
      prune();
    } catch {}
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 3_600_000).unref();
}

export async function mediaPull({ project }: { project: string }) {
  requireConfig();
  const cleanup = prune();
  const branch = branchFor(project);
  if (!(await branchExists(branch))) return { files: [], note: `Nothing waiting: branch ${branch} does not exist yet.`, cleanup };
  const { dir } = await checkout(branch, "in");
  try {
    const inbox = join(dir, "in");
    const names = existsSync(inbox) ? readdirSync(inbox).filter((f) => statSync(join(inbox, f)).isFile()) : [];
    const dest = projectDir(project);
    mkdirSync(dest, { recursive: true });
    const files = names.map((name) => {
      const target = join(dest, name);
      copyFileSync(join(inbox, name), target);
      return { path: target, mb: mb(statSync(target).size) };
    });
    if (names.length) {
      await git(["rm", "--quiet", "--sparse", ...names.map((n) => `in/${n}`)], dir);
      await commitAndPush(dir, branch, `picked up ${names.length} file(s)`);
    }
    return {
      files,
      note: files.length
        ? "Saved on this server. Use these absolute paths in vids_generate (first_frame, reference_images), vids_edit or vids_extend."
        : `Nothing waiting in ${branch}/in.`,
      cleanup,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function mediaPush({ project, files, delete_local = true }: { project: string; files?: string[]; delete_local?: boolean }) {
  requireConfig();
  const folder = projectDir(project);
  const chosen = (files?.length ? files : existsSync(folder) ? readdirSync(folder).filter((f) => MEDIA_EXT.has(extname(f).toLowerCase())) : []).map((f) =>
    resolve(folder, f),
  );
  if (!chosen.length) throw new Error(`No files to send in ${folder}.`);
  for (const f of chosen) {
    if (!(inside(f, OUTPUT_ROOT) || inside(f, UPLOAD_DIR))) throw new Error(`${f} is outside the output folder; only files under ${OUTPUT_ROOT} can be sent.`);
    if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`${f} does not exist.`);
    if (statSync(f).size > MAX_FILE) throw new Error(`${basename(f)} is over ${MAX_FILE / 1048576} MB, GitHub's limit for one file.`);
  }
  const branch = branchFor(project);
  const { dir } = await checkout(branch, "out");
  try {
    mkdirSync(join(dir, "out"), { recursive: true });
    const sent = chosen.map((f) => {
      const name = slug(basename(f));
      copyFileSync(f, join(dir, "out", name));
      return { file: `out/${name}`, mb: mb(statSync(f).size) };
    });
    await git(["add", "--sparse", "out"], dir);
    await commitAndPush(dir, branch, `${sent.length} file(s) from vids-mcp`);
    const deleted: string[] = [];
    if (delete_local) {
      for (const f of chosen) {
        try {
          unlinkSync(f);
          deleted.push(basename(f));
        } catch {}
      }
    }
    return { branch, sent, deleted_here: deleted, cleanup: prune() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function mediaClean({ project, branch: alsoBranch = false }: { project?: string; branch?: boolean }) {
  let freed = 0;
  if (project) {
    const folder = projectDir(project);
    if (!inside(folder, OUTPUT_ROOT)) throw new Error("Refusing to delete outside the output folder.");
    if (existsSync(folder)) {
      const size = (d: string): number =>
        readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
      freed = size(folder);
      rmSync(folder, { recursive: true, force: true });
    }
  }
  let branchDeleted = false;
  if (project && alsoBranch && mediaConfigured() && (await branchExists(branchFor(project)))) {
    // git push needs a repository to run in, even to delete a remote branch.
    mkdirSync(WORK_DIR, { recursive: true });
    const tmp = mkdtempSync(join(WORK_DIR, "rm-"));
    try {
      await git(["init", "--quiet", tmp]);
      await git(["push", "--quiet", remoteUrl(), "--delete", branchFor(project)], tmp);
      branchDeleted = true;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { project_folder_mb_freed: mb(freed), branch_deleted: branchDeleted, cleanup: prune() };
}
