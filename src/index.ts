#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalCore, shapes, type Core } from "./core.js";
import { PLAYBOOK } from "./playbook.js";
import { RemoteCore } from "./remote.js";
import { PORT, startServer } from "./server.js";

const local = new LocalCore();
const role = await startServer(local);
const core: Core = role === "client" ? new RemoteCore() : local;
const studio = role === "none" ? undefined : `http://127.0.0.1:${PORT}`;

const server = new McpServer({ name: "vids-mcp", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = async (work: Promise<unknown>, extra: object = {}): Promise<ToolResult> => {
  try {
    const data = await work;
    const body = Array.isArray(data) ? data : { ...(data as object), ...extra };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }], isError: true };
  }
};

// Most AI apps stop waiting on a tool after about a minute (the MCP default, and Codex's), but Vids is often slower:
// character edit takes one to two minutes. The work carried on while the app reported "Request timed out", so finished
// work looked failed - and a shot was once paid for twice. No call holds on longer than this now; anything slower hands
// back a task id and keeps going, and vids_wait collects the answer.
// VIDS_MCP_PATIENCE_MS lowers it for an app with a shorter limit (and lets a test reach the slow path quickly).
const PATIENCE_MS = Number(process.env.VIDS_MCP_PATIENCE_MS ?? 45_000);
const WAIT_MS = Math.max(5_000, PATIENCE_MS - 5_000);
type Task = { task_id: string; tool: string; started: string; status: "running" | "done" | "failed"; result?: unknown; error?: string };
const tasks = new Map<string, Task>();

const patient = async (tool: string, work: Promise<unknown>): Promise<unknown> => {
  const task: Task = { task_id: `task-${randomUUID().slice(0, 8)}`, tool, started: new Date().toISOString(), status: "running" };
  const settled = work.then(
    (result) => {
      task.status = "done";
      task.result = result;
    },
    (err) => {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), PATIENCE_MS)));
  const first = await Promise.race([settled.then(() => "settled" as const), late]);
  clearTimeout(timer);
  if (first === "settled") return work;
  tasks.set(task.task_id, task);
  return {
    still_working: true,
    task_id: task.task_id,
    note: `Vids is still on it - this is not a failure. Call vids_wait with job_ids ["${task.task_id}"] for the result, and do not call ${tool} again: the work has not stopped.`,
  };
};

// Task ids are answered from here, queued job ids by the queue; either way the call comes back inside the app's limit.
async function waitFor({ job_ids, timeout_seconds }: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeout_seconds * 1000, WAIT_MS);
  const isTask = (id: string) => tasks.has(id) || id.startsWith("task-");
  const mine = (job_ids ?? []).filter(isTask);
  const jobs = job_ids?.filter((id) => !isTask(id));
  while (Date.now() < deadline && mine.some((id) => tasks.get(id)?.status === "running")) await new Promise((r) => setTimeout(r, 1000));
  // A task id this process never issued belongs to a tool process that has since restarted: its answer is gone, but the
  // work may well have happened, so say that instead of reporting it finished.
  const done = mine.map(
    (id) =>
      tasks.get(id) ?? {
        task_id: id,
        status: "unknown",
        note: "This tool restarted since that call, so its answer is lost. Check Vids (vids_videos, vids_characters) for what it did before running it again.",
      },
  );
  const tasksFinished = done.every((t) => t.status !== "running");
  if (mine.length && !jobs?.length) return { finished: tasksFinished, tasks: done };
  const left = Math.max(5, Math.floor((deadline - Date.now()) / 1000));
  const queued = (await core.wait({ job_ids: jobs, timeout_seconds: left })) as { finished: boolean };
  return mine.length ? { ...queued, finished: queued.finished && tasksFinished, tasks: done } : queued;
}

server.registerTool(
  "vids_status",
  {
    title: "Vids status",
    description:
      "Check the Vids Chrome session (signed in, page language) and the generation queue, and list this tool's projects, Vids' stock avatars and image styles. Call this first; it says what the user must fix before generating, and returns the prompt playbook.",
    inputSchema: shapes.status,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () => reply(patient("vids_status", core.status({})), { studio, playbook: PLAYBOOK, ...(tasks.size ? { slow_calls: [...tasks.values()].map(({ result, ...t }) => t) } : {}) }),
);

server.registerTool(
  "vids_generate",
  {
    title: "Queue Vids generations",
    description:
      "Queue one clip or still per scene in a Google Vids video (one Vids video per project, one scene per clip). Video clips use Vids' Omni model (3-10 s, 720p or 1080p): text with up to 3 reference images and/or a stock avatar (Criar), from a first frame (Animar), or carrying on the previous scene (chain_previous → Estender). Stills use Gerar uma imagem. Runs one at a time with human-like pauses; every video clip uses the account's Vids generation quota and Vids shows no price, so tell the user how many clips will be made before calling. Returns job ids at once; use vids_wait for the files.",
    inputSchema: shapes.generate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.generate(args)),
);

server.registerTool(
  "vids_wait",
  {
    title: "Wait for Vids jobs",
    description:
      "Wait for queued jobs (default: all), or for the task_id of a call that answered still_working, then return their status, results and file paths. Comes back within about 40 s even when they are still running: call again until finished is true.",
    inputSchema: shapes.wait,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(waitFor(args)),
);

server.registerTool(
  "vids_cancel",
  {
    title: "Cancel a queued Vids job",
    description: "Cancel a job that has not started yet. A running generation cannot be cancelled.",
    inputSchema: shapes.cancel,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  (args) => reply(core.cancel(args)),
);

server.registerTool(
  "vids_retry",
  {
    title: "Retry failed Vids jobs",
    description:
      "Put failed jobs back in the queue with the same settings and file names (default: all failed jobs). An image batch that finished with some stills failed (its job lists failed_scenes) only makes those again, under their own scene numbers. A clip that failed after Gerar may already have used quota: check the project's Vids video first.",
    inputSchema: shapes.retry,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.retry(args)),
);

server.registerTool(
  "vids_videos",
  {
    title: "List Vids videos",
    description: "List this tool's projects (each one a Vids video with its address) and the titles in the account's recent Vids videos. Any title can be exported with vids_download.",
    inputSchema: shapes.assets,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () => reply(patient("vids_videos", core.assets({}))),
);

server.registerTool(
  "vids_download",
  {
    title: "Export a whole Vids video",
    description:
      "Render a whole Vids video as MP4 (Arquivo → Baixar → Vídeo MP4) and save it in a project folder: a project of this tool by name, or any video in the account by its exact title. No generation, no quota. Single clips are already downloaded by vids_generate.",
    inputSchema: shapes.download,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("vids_download", core.download(args))),
);

server.registerTool(
  "vids_images",
  {
    title: "Batch of stills",
    description:
      "Make up to 50 stills in one job with Vids' Gerar uma imagem, one after another in the project's video, saved as scene-NN. Vids takes no reference picture for stills, so repeat the full description of a recurring character in each scene. A still that fails does not stop the rest; vids_retry makes just the failed ones again. Returns a job id; use vids_wait.",
    inputSchema: shapes.agent,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.agent(args)),
);

server.registerTool(
  "vids_edit",
  {
    title: "Edit a clip with Omni",
    description:
      "Change a clip on this computer with Vids' Editar tab (Omni video-to-video): relight it, change the weather or background, remove or restyle objects. The clip is uploaded, edited and the result saved as edit-NN.mp4. Uses Vids generation quota, so ask the user first. Queued; use vids_wait.",
    inputSchema: shapes.edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.edit(args)),
);

server.registerTool(
  "vids_extend",
  {
    title: "Carry a clip on",
    description:
      "Make the next clip of a shot with Vids' Estender tab: a clip on this computer is uploaded and Omni continues it from where it ends, saved as shot-NN.mp4. Inside one vids_generate call, chain_previous does the same for the scene before. Uses Vids generation quota, so ask the user first. Queued; use vids_wait.",
    inputSchema: shapes.continue_shot,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.continue_shot(args)),
);

server.registerTool(
  "vids_character",
  {
    title: "Create a reusable character",
    description:
      "Create a character kept on this computer: a portrait plus its written look. Give `describe` and Vids draws the portrait (Gerar uma imagem), or `image` for a picture you have. Scenes then pass 'asset:<name>' in reference_images: the portrait goes in as an ingredient and the look is quoted in the prompt, so it stays the same in every scene. For Vids' own talking avatars use a scene's `avatar` instead.",
    inputSchema: shapes.character,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("vids_character", core.character(args))),
);

server.registerTool(
  "vids_character_edit",
  {
    title: "Change a character's look",
    description:
      "Give a character a new look: Vids draws the portrait again from the full new description (it cannot redraw from the old picture), and every later scene that names the character uses it.",
    inputSchema: shapes.character_edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("vids_character_edit", core.character_edit(args))),
);

server.registerTool(
  "vids_characters",
  {
    title: "List characters",
    description: "List the characters kept on this computer, each with its portrait and look. Use one in a scene as 'asset:<name>'.",
    inputSchema: shapes.characters,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  () => reply(core.characters()),
);

server.registerTool(
  "vids_techniques",
  {
    title: "Film technique presets",
    description:
      "List ready-made prompt phrases for camera moves, product shots, transitions and image commands. Pass an id as a scene's `technique` in vids_generate.",
    inputSchema: shapes.techniques,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(core.techniques(args)),
);

server.registerTool(
  "vids_narrate",
  {
    title: "Record narration",
    description:
      "Record narration as an .m4a, free and at any length. `engine: \"gemini\"` uses Google AI Studio's text-to-speech (needs a free key in ~/.vids-mcp/gemini-key, and takes a short `style` note like 'warmly'); `engine: \"mac\"` uses a voice installed on this computer (macOS, or Windows' built-in speech voices). vids_assemble can lay the result over a film.",
    inputSchema: shapes.narrate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("vids_narrate", core.narrate(args))),
);

server.registerTool(
  "vids_voices",
  {
    title: "List narration voices",
    description: "Narrator voices available for vids_narrate: Google AI Studio's (with whether a key is set up) and the voices installed on this computer.",
    inputSchema: shapes.voices,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  () => reply(core.voices()),
);

server.registerTool(
  "vids_assemble",
  {
    title: "Assemble clips into one video",
    description:
      "Join a project's downloaded clips in order into one MP4 (local ffmpeg, no quota). Keeps each clip's own sound and can lay a music track and a voiceover on top.",
    inputSchema: shapes.assemble,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(patient("vids_assemble", core.assemble(args))),
);

server.registerTool(
  "vids_transcribe",
  {
    title: "Hear the words in a video or audio file",
    description:
      "Transcribe a video or audio file on this computer with every word's start and end time (whisper.cpp, local and free, about 100 languages; pass `language` when you know it. The first call in English downloads a 148 MB speech model once, in any other language a 574 MB one). Use the times to check a take said the right words and to cut lines out of it for vids_assemble's voice_lines.",
    inputSchema: shapes.transcribe,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (args) => reply(patient("vids_transcribe", core.transcribe(args))),
);

server.registerTool(
  "vids_captions",
  {
    title: "Add captions to a video",
    description:
      "Burn spoken-word captions into a video, in the style short-form apps use, for landscape or vertical footage (local and free: whisper.cpp hears the words on this computer, nothing is uploaded). Styles: bold (big capitals, the spoken word lights up), highlight, reveal, clean, boxed. Works in about 100 languages; pass `language` (pt, en, es...) whenever you know it. The first call downloads a speech model once: 148 MB for English, 574 MB for other languages. Saves <name>-captions.mp4 plus an .srt. Before calling this, call vids_transcribe, show the user the words with any likely mishearings fixed, and get their OK: then pass the agreed words as `text` (matching words keep their timing), so the video is made once, right.",
    inputSchema: shapes.captions,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  (args) => reply(patient("vids_captions", core.captions(args))),
);

await server.connect(new StdioServerTransport());
