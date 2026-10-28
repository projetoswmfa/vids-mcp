import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assemble, localVoices, speakLocally, voiceTrack } from "./assemble.js";
import { GEMINI_VOICES, geminiKey, saveGeminiKey, speakWithGemini } from "./gemini.js";
import { burnCaptions, captionedName, captionSetup, previewCaptions, transcribe } from "./captions.js";
import { AVATARS, IMAGE_STYLES, characterImage, characterLook, createCharacter, downloadVideo, editCharacter, getVidsState, listCharacters, listProjects, listVideos, rememberCharacter, runGeneration, runImageBatch } from "./vids.js";
import { JobQueue, type Job } from "./queue.js";
import { BIN, COMPUTER, IS_MAC, IS_WIN, moveToBin } from "./platform.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";

export const OUTPUT_ROOT = process.env.VIDS_MCP_OUTPUT ?? join(homedir(), "vids-mcp-out");

export const projectDir = (project: string) => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));

const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Prompt for one clip or still: action, shot and camera move, location, style, light, sound. Portuguese or English both work."),
  type: z.enum(["video", "image"]).default("video"),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional().describe("Video: 16:9 or 9:16. Images also 1:1. Default 16:9."),
  duration: z.number().int().min(3).max(10).optional().describe("Video length in seconds, 3-10. Default 10."),
  resolution: z.enum(["720p", "1080p"]).optional().describe("Video resolution. Default: what Vids is set to (720p)."),
  first_frame: z.string().optional().describe("Absolute image path: the clip animates from this picture (Vids' Animar tab). References and avatar are ignored then."),
  reference_images: z
    .array(z.string())
    .max(3)
    .optional()
    .describe("Up to 3 ingredients (Vids' Ingredientes): absolute image paths, or 'asset:<name>' for a character from vids_characters."),
  avatar: z.string().optional().describe("A Vids stock avatar to put in the clip, by name (e.g. 'Sofia', 'Levi'); see vids_status avatars."),
  image_style: z.enum(IMAGE_STYLES).optional().describe("Images only: Vids' image style. Default 'Sem estilo'."),
  technique: z.string().optional().describe("Id from vids_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  reference_previous: z
    .boolean()
    .optional()
    .describe("Use the previous scene's finished still as an extra reference image, so this scene keeps its look."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Carry on the previous scene's clip with Vids' Estender (extend) tab, for one continuous take across the cut. Not valid on the first scene."),
});

// Raw shapes double as MCP input schemas and, wrapped in z.object, as HTTP body validators.
const captionFields = {
  video: z.string().min(1).describe("Absolute path of the video to caption: any MP4 or MOV on this computer, such as a film made with vids_assemble."),
  style: z
    .enum(["bold", "highlight", "reveal", "clean", "boxed"])
    .default("bold")
    .describe(
      "bold: big capitals, 1-3 words at a time, the spoken word lights up (the short-form look). highlight: the spoken word sits on a coloured block. reveal: words appear as they are said. clean: classic subtitles. boxed: white words on a dark band.",
    ),
  position: z
    .union([z.enum(["bottom", "middle", "top"]), z.number().min(0).max(100)])
    .default("bottom")
    .describe("bottom, middle or top - or a number for an exact height: how far down the frame the middle of the caption sits, 0 = top edge, 100 = bottom edge."),
  size: z
    .union([z.enum(["small", "medium", "large"]), z.number().min(40).max(250)])
    .default("medium")
    .describe("small, medium, large, or a percentage of the style's normal size (100 = medium, 150 = half again as big)."),
  lead: z
    .number()
    .min(-0.5)
    .max(0.5)
    .optional()
    .describe("Seconds the highlight runs ahead of the voice. Default 0.12; raise it if words still light up late, lower it if early."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Highlight colour as #RRGGBB, for bold, highlight and reveal."),
  letters: z
    .enum(["as_said", "capitals", "lowercase"])
    .optional()
    .describe("as_said keeps normal capitals (sentence starts, names); capitals is the high-energy short-form look; lowercase is the calm, casual look, and names still keep their capital in it. Default: capitals for bold, as_said for the rest."),
  names: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Lowercase only: names to keep capitalised even where they start a sentence (e.g. [\"Juno\"]). Names in the middle of a sentence are found by themselves."),
  text: z.string().max(50_000).optional().describe("Corrected words, to fix anything misheard. Timings are kept for every word that still matches; a line break starts a new caption."),
  language: z
    .string()
    .default("auto")
    .describe(
      "Spoken language as a code: en, es, fr, de, pt, tr, ja, zh, ar... Pass it whenever you know it. auto detects it (a 60 MB detector downloads once). English uses a 148 MB model; every other language a 574 MB one, each downloaded the first time.",
    ),
};

export const shapes = {
  status: {},
  generate: {
    project: z.string().min(1).describe("Project name, e.g. 'HotelPromo': one Vids video holds its clips (one scene each) and a folder of the same name holds the downloads."),
    scenes: z.array(sceneSchema).min(1).max(100),
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job ids from a queued call, or the task_id of a call that answered still_working. Default: every queued job."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("An MCP call returns after at most 40 s whatever this says, so call again until finished is true."),
  },
  cancel: { job_id: z.string() },
  retry: { job_ids: z.array(z.string()).optional().describe("Jobs to re-queue. Default: every failed job.") },
  assets: {},
  download: {
    project: z.string().min(1).describe("Local folder to save into."),
    video: z.string().min(1).describe("A project name from vids_status, or the exact title of any video in the account (vids_videos). The whole video is rendered by Vids and saved as MP4."),
  },
  assemble: {
    project: z.string().min(1).describe("Same project name used in vids_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    clip_volume: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    voice_lines: z
      .array(
        z.object({
          file: z.string().min(1).describe("Take to cut the line from: audio or video (its sound is used)."),
          from: z.number().min(0).optional().describe("Start of the line within the take, seconds (from vids_transcribe word times)."),
          to: z.number().min(0).optional().describe("End of the line within the take, seconds."),
          at: z.number().min(0).describe("Where the line starts in the film, seconds."),
          max_seconds: z.number().min(0.2).optional().describe("Longest it may last; a longer line is sped up slightly (at most 1.25x)."),
        }),
      )
      .max(60)
      .optional()
      .describe(
        "A timed voiceover built from separate lines, each placed at its own moment in the film - for example lines cut from several takes, each landing on the title it describes. Replaces `voiceover`.",
      ),
    output_name: z.string().default("final"),
    hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
  },
  transcribe: {
    video: z.string().min(1).describe("Absolute path of a video or audio file on this computer."),
    language: z.string().default("auto").describe("Spoken language code (en, es, tr, ja...) or auto. Pass it whenever you know it."),
    words: z.boolean().default(true).describe("Include every word with its start and end time in seconds."),
  },
  caption_preview: captionFields,
  captions: {
    ...captionFields,
    project: z.string().optional().describe("Films folder to save into. Default: the video's own folder when it is already in the films folder, otherwise 'Captions'."),
  },
  caption_setup: {},
  agent: {
    project: z.string().min(1).describe("Project name: the Vids video the stills are drawn in, and the folder they are saved to."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
    image_style: z.enum(IMAGE_STYLES).optional(),
  },
  voices: {},
  narrate: {
    project: z.string().min(1).describe("Folder for the narration audio."),
    engine: z
      .enum(["gemini", "mac"])
      .default("gemini")
      .describe(
        "'gemini' uses Google AI Studio's text-to-speech - free on the AI Studio tier, no length limit, needs a key in ~/.vids-mcp/gemini-key. 'mac' uses a voice installed on this computer (macOS voices on a Mac, the built-in speech voices on Windows): free, instant, no key.",
      ),
    text: z.string().min(1).max(400).describe("The line to speak. About 20 words fits 8 s, 30 words fits 12 s; anything longer needs a longer take."),
    voice: z.string().min(1).default("Charon").describe("Voice name from vids_voices, e.g. Charon (informative), Aoede (breezy), Gacrux (mature) for Google; Zoe or Samantha for macOS."),
    style: z.string().max(200).optional().describe("Delivery note for the 'gemini' engine, e.g. 'slowly and warmly, like a documentary narrator'."),
  },
  edit: {
    project: z.string().min(1).describe("Project the edited clip belongs to (its Vids video and folder)."),
    video: z.string().min(1).describe("Absolute path of the clip to change (MP4, WebM or MOV), e.g. a scene-NN.mp4 made earlier."),
    prompt: z.string().min(1).describe("What to change, e.g. 'change the time of day to golden hour', 'remove the cup', 'make it snow'."),
    resolution: z.enum(["720p", "1080p"]).optional(),
  },
  continue_shot: {
    project: z.string().min(1).describe("Project the new clip belongs to."),
    video: z.string().min(1).describe("Absolute path of the clip to carry on (MP4, WebM or MOV)."),
    prompt: z.string().min(1).describe("What happens next, as one continuous shot with one camera move."),
    aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
    duration: z.number().int().min(3).max(10).optional(),
    resolution: z.enum(["720p", "1080p"]).optional(),
  },
  set_key: { key: z.string().min(1).max(200) },
  discard: { path: z.string().min(1).describe("A saved film, still, narration or whole project folder inside the films folder, to move to this computer's bin (Mac Trash, Windows Recycle Bin).") },
  outputs: {},
  characters: {},
  character_edit: {
    name: z.string().min(1).describe("Character to change, as listed by vids_characters."),
    look: z.string().min(1).max(1500).describe("The character's whole description after the change. Vids draws the portrait again from it (it cannot redraw from a picture)."),
  },
  character: {
    name: z.string().min(1).max(60).describe("Character name; scenes then use it as 'asset:<name>' in reference_images."),
    describe: z.string().max(1200).optional().describe("What the character looks like. Vids draws the portrait (Gerar uma imagem). Use this or `image`."),
    image: z.string().min(1).optional().describe("A picture you already have instead of `describe`: absolute path."),
    aspect_ratio: z.enum(["9:16", "1:1", "16:9"]).optional().describe("Frame for a drawn portrait. Default 9:16."),
    style: z.enum(IMAGE_STYLES).optional().describe("Image style for a drawn portrait. Default 'Sem estilo'."),
  },
  techniques: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
};

type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;

export const jobView = ({ id, status, params, files, attempts, progress, note, error, failed_scenes }: Job) => ({
  id,
  status,
  project: params.output_dir,
  scene: params.file_stem,
  prompt: params.prompt,
  attempts,
  progress,
  files,
  note,
  error,
  failed_scenes,
});

// One implementation runs in whichever process owns the Vids tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  voices(): Promise<unknown>;
  narrate(a: Args<"narrate">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  characters(): Promise<unknown>;
  character_edit(a: Args<"character_edit">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  discard(a: Args<"discard">): Promise<unknown>;
  set_key(a: Args<"set_key">): Promise<unknown>;
  continue_shot(a: Args<"continue_shot">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
  transcribe(a: Args<"transcribe">): Promise<unknown>;
  caption_preview(a: Args<"caption_preview">): Promise<unknown>;
  captions(a: Args<"captions">): Promise<unknown>;
  caption_setup(): Promise<unknown>;
}

// Google AI Studio's voices (the Gemini TTS family), kept for reference.
export const VOICES = [
  { name: "Achernar", description: "female, soft, high pitch" },
  { name: "Achird", description: "male, friendly, mid pitch" },
  { name: "Algenib", description: "male, gravelly, low pitch" },
  { name: "Algieba", description: "male, easy-going, mid-low pitch" },
  { name: "Alnilam", description: "male, firm, mid-low pitch" },
  { name: "Aoede", description: "female, breezy, mid pitch" },
  { name: "Autonoe", description: "female, bright, mid pitch" },
  { name: "Callirrhoe", description: "female, easy-going, mid pitch" },
  { name: "Charon", description: "male, informative, lower pitch" },
  { name: "Despina", description: "female, smooth, mid pitch" },
  { name: "Enceladus", description: "male, breathy, lower pitch" },
  { name: "Erinome", description: "female, clear, mid pitch" },
  { name: "Fenrir", description: "male, excitable, younger pitch" },
  { name: "Gacrux", description: "female, mature, mid pitch" },
  { name: "Iapetus", description: "male, clear, mid-low pitch" },
];

const BUSY = "A generation is running in the Vids tab. Wait for it to finish (vids_wait), then retry.";

export class LocalCore implements Core {
  private queue: JobQueue = new JobQueue(async (job) => {
    const { chain_from, reference_from } = job.params;
    if (reference_from) {
      const still = this.queue.get(reference_from)?.files.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
      if (!still) throw new Error(`reference_previous: the previous scene (${reference_from}) produced no image.`);
      job.params.reference_images = [still, ...(job.params.reference_images ?? [])].slice(0, 3);
    }
    if (chain_from) {
      const clip = this.queue.get(chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
      if (!clip) throw new Error(`chain_previous: the previous scene (${chain_from}) produced no video, so this scene was skipped.`);
      job.params.extend_video = clip;
    }
    if (job.params.image_scenes) return runImageBatch(job);
    return runGeneration(job);
  });

  async status() {
    const vids = this.queue.busy ? { busy: true, projects: listProjects() } : await getVidsState();
    return { vids, avatars: AVATARS, image_styles: IMAGE_STYLES, pacing: this.queue.pausedReason, output_root: OUTPUT_ROOT, jobs: this.queue.list().map(jobView) };
  }

  async generate({ project, scenes }: Args<"generate">) {
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image" || scenes[i - 1].type === "image"));
    if (invalid >= 0) {
      throw new Error(`Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
    }
    const badRef = scenes.flatMap((s) => s.reference_images ?? []).find((r) => (r.startsWith("asset:") ? !characterImage(r.slice(6).trim()) : !existsSync(r)));
    if (badRef) throw new Error(`Reference not found: ${badRef}. Use an absolute image path, or 'asset:<name>' for a character from vids_characters.`);
    const noPrev = scenes.findIndex((s, i) => s.reference_previous && i === 0);
    if (noPrev >= 0) throw new Error("Scene 1 has no previous scene to reference.");
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) throw new Error(`Unknown technique "${unknown.technique}". Call vids_techniques for valid ids.`);

    const output_dir = projectDir(project);
    // Continue numbering after whatever is already on disk or queued, so reruns never overwrite earlier scenes.
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^scene-(\d+)/)?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    const offset = Math.max(0, ...onDisk, ...queued);
    const jobs: Job[] = [];
    for (const [i, { chain_previous, reference_previous, technique, ...scene }] of scenes.entries()) {
      const phrase = technique ? techniqueById(technique)!.phrase : "";
      // A referenced character must come out identical, not merely similar, so the scene says so explicitly. The
      // wording stays medium-neutral: the same lock has to serve a flat cartoon character and a photoreal avatar.
      const cast = (scene.reference_images ?? [])
        .filter((r) => r.startsWith("asset:"))
        .map((r) => r.slice(6).trim())
        .filter((n) => characterImage(n) !== undefined);
      const lock = cast.length
        ? ` CHARACTER LOCK — ${cast.join(" and ")} must match the reference image exactly, as if copying it: same head shape and size, same face, same eyes, same hair, same skin, same build and proportions, same clothing items in the same colours, same hands, and the same rendering style and level of realism as the reference. Never redesign, restyle, re-proportion, re-age or re-colour them, and never swap an item for a similar one.${cast
            .map((n) => (characterLook(n) ? ` ${n} is exactly: ${characterLook(n)}.` : ""))
            .join("")}`
        : "";
      const inherit = reference_previous
        ? " Match the previous image exactly for the subject's appearance, colour palette, lighting and rendering style; this is the same scene a moment later."
        : "";
      jobs.push(
        this.queue.add({
          ...scene,
          project,
          reference_images: scene.reference_images?.map((r) => (r.startsWith("asset:") ? characterImage(r.slice(6).trim())! : r)),
          prompt: `${scene.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}${lock}${inherit}`,
          chain_from: chain_previous ? jobs[i - 1].id : undefined,
          reference_from: reference_previous ? jobs[i - 1].id : undefined,
          output_dir,
          file_stem: `scene-${String(offset + i + 1).padStart(2, "0")}`,
        }),
      );
    }
    return { output_dir, jobs: jobs.map(jobView) };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => (job_ids ? job_ids.map((id) => this.queue.get(id)).filter((j): j is Job => Boolean(j)) : this.queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const jobs = pick();
    return {
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running"),
      pacing: this.queue.pausedReason,
      jobs: jobs.map(jobView),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`No job with id ${job_id}. Use vids_status to list jobs.`);
    return jobView(job);
  }

  async retry({ job_ids }: Args<"retry">) {
    const ids = job_ids ?? this.queue.list().filter((j) => j.status === "failed" || j.failed_scenes?.length).map((j) => j.id);
    const jobs: Job[] = [];
    for (const id of ids) {
      const job = this.queue.get(id);
      const p = job?.params;
      if (job?.failed_scenes?.length && p?.image_scenes && job.status === "done") {
        // A batch that finished with some images still failed: make just those again, under their own scene numbers,
        // instead of re-running the whole batch. The list moves to the new job, so it is never retried twice.
        const base = Number(p.file_stem.match(/\d+/)?.[0] ?? 1);
        const numbers = p.image_numbers ?? p.image_scenes.map((_, i) => base + i);
        const pick = job.failed_scenes.map((n) => numbers.indexOf(n)).filter((i) => i >= 0);
        job.failed_scenes = undefined;
        jobs.push(
          this.queue.add({
            ...p,
            prompt: `Image batch: ${pick.length} failed image(s) again`,
            image_scenes: pick.map((i) => p.image_scenes![i]),
            image_numbers: pick.map((i) => numbers[i]),
            file_stem: `scene-${String(numbers[pick[0]]).padStart(2, "0")}`,
          }),
        );
        continue;
      }
      const again = this.queue.retry(id);
      if (again) jobs.push(again);
    }
    if (!jobs.length) throw new Error("Nothing to retry: no failed jobs, and no batch with failed images.");
    return { jobs: jobs.map(jobView) };
  }

  async assets() {
    if (this.queue.busy) throw new Error(BUSY);
    const ours = new Set(listProjects().map((p) => p.name));
    return { projects: listProjects(), videos: (await listVideos()).map((title) => ({ title, project: ours.has(title) })) };
  }

  async download({ project, video }: Args<"download">) {
    if (this.queue.busy) throw new Error(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${this.nextStem(dir, "video")}.mp4`);
    return { dir, files: [await downloadVideo(video, file)] };
  }

  async assemble({ project, voice_lines, ...rest }: Args<"assemble">) {
    const dir = projectDir(project);
    if (!voice_lines?.length) return assemble({ dir, ...rest });
    mkdirSync(dir, { recursive: true });
    const track = await voiceTrack(voice_lines, join(dir, `${rest.output_name.replace(/[^\w.-]+/g, "_")}-voice.wav`));
    const film = await assemble({ dir, ...rest, voiceover: track.file });
    return { ...film, voice: track };
  }

  // Captions never touch Vids or its queue: whisper.cpp hears the words, a headless Chrome of its own draws them.
  async transcribe({ video, language, words }: Args<"transcribe">) {
    const t = await transcribe(video, language);
    return {
      text: t.text,
      word_count: t.words.length,
      language: t.language,
      model: t.model,
      ...(words ? { words: t.words.map((w) => ({ text: w.text, start: Number(w.start.toFixed(2)), end: Number(w.end.toFixed(2)) })) } : {}),
    };
  }

  async caption_preview(a: Args<"caption_preview">) {
    return previewCaptions(a.video, a);
  }

  async captions({ project, ...a }: Args<"captions">) {
    // Save next to the video when it is already one of the user's films, otherwise in a Captions folder.
    const rel = relative(OUTPUT_ROOT, dirname(a.video));
    const inFilms = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    const dir = project ? projectDir(project) : inFilms ? dirname(a.video) : projectDir("Captions");
    mkdirSync(dir, { recursive: true });
    return burnCaptions(a.video, a, captionedName(dir, a.video));
  }

  async caption_setup() {
    return captionSetup();
  }

  // Everything already downloaded, newest project first, so the panel can show past work after a restart.
  async outputs() {
    if (!existsSync(OUTPUT_ROOT)) return { root: OUTPUT_ROOT, projects: [] };
    const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp|m4a|mp3|wav|aiff?)$/i;
    const projects = readdirSync(OUTPUT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(OUTPUT_ROOT, d.name);
        const files = readdirSync(dir)
          .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
          .map((f) => ({ name: f, path: join(dir, f), kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : /\.(m4a|mp3|wav|aiff?)$/i.test(f) ? "audio" : "image", mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
      })
      .filter((p) => p.files.length)
      .sort((a, b) => b.mtime - a.mtime);
    return { root: OUTPUT_ROOT, projects };
  }

  private nextStem(output_dir: string, prefix: string): string {
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith(prefix)).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    return `${prefix}-${String(Math.max(0, ...onDisk, ...queued) + 1).padStart(2, "0")}`;
  }

  async agent({ project, scenes, aspect_ratio, image_style }: Args<"agent">) {
    const output_dir = projectDir(project);
    const job = this.queue.add({
      prompt: `Image batch: ${scenes.length} images`,
      type: "image",
      project,
      aspect_ratio,
      image_style,
      image_scenes: scenes,
      output_dir,
      file_stem: this.nextStem(output_dir, "scene"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  async edit({ project, video, prompt, resolution }: Args<"edit">) {
    if (!existsSync(video)) throw new Error(`Clip not found: ${video}`);
    const output_dir = projectDir(project);
    const job = this.queue.add({ prompt, type: "video", project, edit_video: video, resolution, output_dir, file_stem: this.nextStem(output_dir, "edit") });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Vids' Estender tab carries a clip on from where it ends.
  async continue_shot({ project, video, prompt, aspect_ratio, duration, resolution }: Args<"continue_shot">) {
    if (!existsSync(video)) throw new Error(`Clip not found: ${video}`);
    const output_dir = projectDir(project);
    const job = this.queue.add({ prompt, type: "video", project, extend_video: video, aspect_ratio, duration, resolution, output_dir, file_stem: this.nextStem(output_dir, "shot") });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Moves a file or a project folder from the films folder to the system's bin - recoverable from there, never
  // erased. Anything outside the films folder is refused, so a bad path can never reach the rest of the Mac.
  async discard({ path }: Args<"discard">) {
    const target = resolve(path);
    // relative() works with either separator; a path that climbs out ("..") or lands on another drive is refused.
    const rel = relative(OUTPUT_ROOT, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only things inside your films folder can be moved to the bin from here.");
    if (!existsSync(target)) throw new Error("That file is already gone.");
    return { trashed: target, to: moveToBin(target), bin: BIN };
  }

  async character(a: Args<"character">) {
    if (this.queue.busy) throw new Error(BUSY);
    if (!a.image && !a.describe) throw new Error("Pass either `describe` (Vids draws the portrait) or `image`.");
    return { ...(await createCharacter(a, OUTPUT_ROOT)), use_as: `asset:${a.name}` };
  }

  async character_edit({ name, look }: Args<"character_edit">) {
    if (this.queue.busy) throw new Error(BUSY);
    const out = await editCharacter(name, look, OUTPUT_ROOT);
    rememberCharacter(name, look);
    return { ...out, use_as: `asset:${name}` };
  }

  async characters() {
    return listCharacters().map((c) => ({ ...c, use_as: `asset:${c.name}` }));
  }

  // Panel only: deliberately NOT registered as an MCP tool, so a key typed into Vids Studio never reaches Claude.
  async set_key({ key }: Args<"set_key">) {
    return saveGeminiKey(key);
  }

  async voices() {
    // The panel words itself from these, so a PC never reads "this Mac".
    const place = { computer: COMPUTER, bin: BIN, local_engine: IS_MAC ? "macOS voice" : IS_WIN ? "Windows voice" : "System voice", platform: process.platform };
    return { gemini: GEMINI_VOICES, gemini_ready: Boolean(geminiKey()), mac: await localVoices(), place };
  }

  async narrate({ project, text, voice, engine, style }: Args<"narrate">) {
    const output_dir = projectDir(project);
    mkdirSync(output_dir, { recursive: true });
    const target = join(output_dir, `${this.nextStem(output_dir, "narration")}.m4a`);
    const spoken = engine === "mac" ? await speakLocally(text.trim(), voice, target) : await speakWithGemini(text.trim(), voice, target, style);
    return { output_dir, engine, voice, ...spoken };
  }

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }
}
