// Drives Google Vids (docs.google.com/videos) through its real UI, in pt-BR. Every name below was read off the live
// page (2026-10-22 in the earlier API - Vids-new project, re-checked 2026-10-28); see VIDS-MAP.md.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { FileChooser, Locator, Page } from "playwright-core";
import { ensurePortuguese, getContext, getVidsPage, HOME_DIR, signedOut, VIDS_HOME, VIDS_NEW } from "./chrome.js";
import type { Job } from "./queue.js";

export const UI = {
  editorUrl: /docs\.google\.com\/videos\/d\/([^/?#]+)/,
  startDialog: "Como começar",
  startAspect: { "16:9": "Criar um vídeo horizontal", "9:16": "Criar um vídeo no modo retrato", "1:1": "Criar um vídeo quadrado" },
  startAiVideo: /^Criar vídeos com IA/,
  rename: "Renomear",
  newScene: "Nova cena (Ctrl+M)",
  emptyScene: "Este cenário não tem objetos.",
  aiVideoButton: "Gerar um vídeo com IA",
  aiPanel: "Clipe de vídeo gerado com IA",
  tabs: { create: "Criar", edit: "Editar", animate: "Animar", extend: "Estender" },
  ingredients: "Ingredientes",
  addElements: "Adicionar avatar ou elementos",
  upload: "Fazer upload",
  browse: "Procurar",
  attached: /^Remover (imagem|vídeo)/,
  addImage: "Adicionar imagem",
  addVideo: "Adicionar vídeo",
  avatarButton: "Avatar",
  avatarConfirm: "Selecione",
  imageTerms: "Criar conteúdo com imagens no Workspace",
  imageTermsAccept: "Concordo",
  settings: /^Configurações de geração/,
  duration: "Duração do vídeo",
  aspectGroup: "Proporção",
  aspectRadio: { "16:9": "Paisagem", "9:16": "Retrato" },
  clear: "Limpar",
  expand: "Abrir",
  generate: "Gerar",
  insert: "Inserir",
  cancel: "Cancelar",
  closePanel: "Fechar página lateral",
  imageButton: "Gerar uma imagem",
  imagePanel: "Gerar uma imagem",
  imageAspectList: "Proporção",
  imageAspect: { "1:1": /Quadrado 1:1/, "16:9": /Paisagem 16:9/, "9:16": /Retrato 9:16/ },
  imageStyleList: "Adicionar um estilo",
  imageCreate: "Criar",
  imageItem: /^Criar imagem:/,
  fileMenu: "Arquivo",
  downloadMenu: /^Baixar/,
  downloadMp4: /^Vídeo MP4/,
  refusal: /não foi possível|tente novamente|cota|não consigo/i,
} as const;

export const IMAGE_STYLES = ["Fotografia", "Fundo", "Arte vetorial", "Sketch", "Aquarela", "Cyberpunk", "Sem estilo"] as const;
export type ImageStyle = (typeof IMAGE_STYLES)[number];

// The stock avatars in the Avatar dialog (Criar → Avatar), as listed there on 2026-10-28.
export const AVATARS = [
  "Finley", "Sebastian", "Mia", "Levi", "Eleanor", "William", "Sofia", "Jamal", "Charlie", "Oliver", "Justice", "Jack", "Morgan",
  "Olívia", "Tiago", "Adriano", "Caleb", "Emília", "Samir", "Leonardo", "Eric", "Jade", "Karen", "Amal", "Farah",
  "Theodore", "Scarlett", "Winoa", "Reynold", "Avery", "Henry", "Harper", "Benjamin", "Evelyn", "Aden", "Alexis", "Kai", "Kevin", "Paul",
  "Amélia", "Elijah", "Liam", "Lux", "River", "Martin", "Smith", "Joseph", "Aaron", "Alan", "Diego", "Lennon", "Rio", "Sue",
];

const MAX_CLIP_SECONDS = 10;
const MIN_CLIP_SECONDS = 3;
const CLIP_ATTEMPTS = 3;
const CLIP_TIMEOUT_MS = Number(process.env.VIDS_MCP_CLIP_TIMEOUT_S ?? 240) * 1000;
const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
const EXPORT_TIMEOUT_MS = 30 * 60 * 1000;
const UI_TIMEOUT_MS = 30_000;
const DEBUG = process.env.VIDS_MCP_DEBUG === "1";
const log = (...a: unknown[]) => DEBUG && console.error(new Date().toISOString().slice(11, 19), ...a);

// ---------- projects: one Vids document per project ----------

const PROJECTS_FILE = join(HOME_DIR, "projects.json");
const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};
const projects = () => readJson<Record<string, string>>(PROJECTS_FILE, {});
function saveProject(name: string, url: string) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(PROJECTS_FILE, JSON.stringify({ ...projects(), [name]: url }, null, 2));
}
export const projectUrl = (name: string): string | undefined => projects()[name];
export const listProjects = () => Object.entries(projects()).map(([name, url]) => ({ name, url }));

// Opens the project's own Vids document, creating it (through vids.new) the first time. vids.new makes a new
// document on EVERY visit, so it is only ever opened when the project has no document yet.
async function openProject(page: Page, project: string, aspect: "16:9" | "9:16" | "1:1" = "16:9"): Promise<void> {
  const known = projectUrl(project);
  if (known) {
    if (!page.url().startsWith(known.replace(/\/edit.*$/, ""))) await page.goto(known, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await checkPage(page);
    await page.waitForURL(UI.editorUrl, { timeout: 60_000 });
    // An empty document shows "Como começar" again on every visit; it is only a welcome screen here.
    await dismissStartDialog(page);
    return;
  }
  await page.goto(VIDS_NEW, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await checkPage(page);
  await page.waitForURL(UI.editorUrl, { timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: UI.startDialog });
  await dialog.waitFor({ state: "visible", timeout: 60_000 });
  await dialog.getByRole("button", { name: UI.startAspect[aspect] }).click();
  await dialog.getByRole("button", { name: UI.startAiVideo }).click();
  const id = page.url().match(UI.editorUrl)?.[1];
  if (!id) throw new Error("Vids opened a new video but its address could not be read.");
  saveProject(project, `https://docs.google.com/videos/d/${id}/edit`);
  const box = page.getByRole("textbox", { name: UI.rename });
  if (await box.isVisible().catch(() => false)) {
    await box.click();
    await box.fill(project);
    await box.press("Enter");
  }
}

async function dismissStartDialog(page: Page) {
  const dialog = page.getByRole("dialog", { name: UI.startDialog });
  if (await dialog.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) {
    await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
  }
}

async function checkPage(page: Page) {
  if (signedOut(page)) throw new Error("The Vids Chrome window is signed out. Run `npm run login` and sign in to Google there by hand.");
  await ensurePortuguese(page);
}

// ---------- status ----------

export interface VidsState {
  signed_in: boolean;
  page?: string;
  projects: { name: string; url: string }[];
  hint?: string;
}

export async function getVidsState(): Promise<VidsState> {
  const page = await getVidsPage();
  if (!/docs\.google\.com\/videos|accounts\.google\.com/.test(page.url())) await page.goto(VIDS_HOME, { waitUntil: "domcontentloaded" });
  if (signedOut(page)) {
    return { signed_in: false, page: page.url(), projects: listProjects(), hint: "Sign in to Google in the Vids Chrome window (npm run login), then call vids_status again." };
  }
  try {
    await ensurePortuguese(page);
  } catch (err) {
    return { signed_in: true, page: page.url(), projects: listProjects(), hint: (err as Error).message };
  }
  return { signed_in: true, page: page.url(), projects: listProjects() };
}

// Titles in the account's "Vídeos recentes" list (docs-homescreen grid). Items carry no address, so they are opened
// by clicking the title.
export async function listVideos(): Promise<string[]> {
  const page = await getVidsPage();
  await page.goto(VIDS_HOME, { waitUntil: "domcontentloaded" });
  await checkPage(page);
  await page.locator(".docs-homescreen-grid-item").first().waitFor({ timeout: 20_000 }).catch(() => {});
  const titles = await page.locator(".docs-homescreen-grid-item-title").allInnerTexts();
  return titles.map((t) => t.trim()).filter(Boolean);
}

// ---------- the AI video panel ----------

type Tab = keyof typeof UI.tabs;
const aiPanel = (page: Page) => page.getByRole("complementary", { name: UI.aiPanel });
const tabPanel = (page: Page, tab: Tab) => aiPanel(page).getByRole("tabpanel", { name: UI.tabs[tab] });

async function startOwnScene(page: Page) {
  // A fresh document opens on an empty scene; anything else gets a new scene so each clip has its own.
  if (await page.getByText(UI.emptyScene).first().isVisible().catch(() => false)) return;
  await page.getByRole("toolbar", { name: "Principal" }).getByRole("button", { name: UI.newScene }).click();
  await page.waitForTimeout(3000);
}

async function openAiPanel(page: Page, tab: Tab) {
  if (!(await aiPanel(page).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: UI.aiVideoButton }).click();
    await aiPanel(page).waitFor({ state: "visible" });
  }
  await aiPanel(page).getByRole("tab", { name: UI.tabs[tab], exact: true }).click();
  const panel = tabPanel(page, tab);
  await panel.waitFor({ state: "visible" });
  // After a generation the form folds away under the result; "Abrir" unfolds it, and must come before "Limpar".
  const expand = aiPanel(page).getByRole("button", { name: UI.expand, exact: true });
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
    await page.waitForTimeout(1000);
  }
  // The panel keeps the previous request (prompt, images, videos): every clip starts from nothing.
  const clear = panel.getByRole("button", { name: UI.clear, exact: true });
  if (await clear.isVisible().catch(() => false)) {
    await clear.click();
    await page.waitForTimeout(1500);
  }
  const box = panel.getByRole("textbox");
  if ((await box.innerText().catch(() => "")).trim()) {
    await box.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
  }
}

async function chooseFile(page: Page, click: () => Promise<void>, timeout = UI_TIMEOUT_MS): Promise<FileChooser> {
  const chooser = page.waitForEvent("filechooser", { timeout });
  chooser.catch(() => {});
  await click();
  return chooser;
}

type Upload = string | { name: string; mimeType: string; buffer: Buffer };
const pickerFrame = (page: Page) => page.frames().find((f) => /docs\.google\.com\/picker/.test(f.url()));

// Vids' upload buttons (Adicionar imagem, Adicionar vídeo, Ingredientes) open Google's file picker "Abrir um arquivo"
// in an iframe (2026-10-28): option "Fazer upload" -> button "Procurar" -> the file chooser. The picker then closes
// by itself. An older build opened the file chooser straight away, so that is still accepted.
async function uploadThrough(page: Page, open: () => Promise<void>, file: Upload) {
  const direct = page.waitForEvent("filechooser", { timeout: 6000 });
  direct.catch(() => {});
  await open();
  let chooser = await direct.catch(() => null);
  if (!chooser) {
    let frame = pickerFrame(page);
    for (let i = 0; i < 20 && !frame; i++) {
      await page.waitForTimeout(500);
      frame = pickerFrame(page);
    }
    if (!frame) throw new Error("Neither a file chooser nor Google's file picker opened.");
    await frame.getByRole("option", { name: UI.upload, exact: true }).click();
    chooser = await chooseFile(page, () => frame!.getByRole("button", { name: UI.browse, exact: true }).click());
  }
  await chooser.setFiles(file);
  for (let i = 0; i < 60 && pickerFrame(page); i++) await page.waitForTimeout(500);
}

// The Workspace image-terms dialog shows once per account; the user accepted it on 2026-10-22. After it the opener
// has to be pressed again.
async function acceptTermsIfAsked(page: Page, reopen: () => Promise<void>) {
  const terms = page.getByRole("dialog", { name: UI.imageTerms });
  if (await terms.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false)) {
    await terms.getByRole("button", { name: UI.imageTermsAccept }).click();
    await reopen();
  }
}

// Vids takes PNG/JPG ingredients only (WebP is refused as an invalid format), so anything else is converted in Chrome.
async function asPngOrJpg(page: Page, file: string): Promise<string | { name: string; mimeType: string; buffer: Buffer }> {
  const ext = extname(file).toLowerCase();
  if ([".png", ".jpg", ".jpeg"].includes(ext)) return file;
  const src = `data:image/${ext.slice(1)};base64,${readFileSync(file).toString("base64")}`;
  const b64 = (await page.evaluate(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(src)}; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png').split(',')[1];
  })()`)) as string;
  return { name: file.replace(/^.*[\\/]/, "").replace(/\.\w+$/, ".png"), mimeType: "image/png", buffer: Buffer.from(b64, "base64") };
}

async function attachReferences(page: Page, files: string[]) {
  const panel = tabPanel(page, "create");
  const remove = panel.getByRole("button", { name: /^Remover imagem/ });
  for (let i = 0; i < 5 && (await remove.count()) > 0; i++) {
    await remove.first().click();
    await page.waitForTimeout(800);
  }
  for (const [index, file] of files.entries()) {
    const ingredients = panel.getByRole("button", { name: UI.ingredients, exact: true });
    const first = index === 0 && (await ingredients.isVisible().catch(() => false));
    const open = async () => {
      if (first) await ingredients.click();
      else {
        await panel.getByRole("button", { name: UI.addElements }).click();
        await panel.getByRole("group", { name: UI.addElements }).getByRole("button", { name: UI.upload, exact: true }).click();
      }
    };
    const before = await panel.getByRole("button", { name: /^Remover imagem/ }).count();
    await uploadThrough(page, async () => {
      await open();
      if (first) await acceptTermsIfAsked(page, open);
    }, await asPngOrJpg(page, file));
    // Each attached ingredient shows as "@ImagemN" in the prompt (2026-10-22) and gets its own "Remover imagem".
    await panel
      .getByText(`@Imagem${index + 1}`)
      .or(panel.getByRole("button", { name: /^Remover imagem/ }).nth(before))
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
  }
}

// Animar ("Adicionar imagem"), Editar and Estender ("Adicionar vídeo"). Once attached the panel shows the upload's
// preview and "Remover imagem" (checked on Animar 2026-10-28); a video takes longer to process.
async function attachMedia(page: Page, tab: Tab, button: string, file: Upload) {
  const panel = tabPanel(page, tab);
  const add = panel.getByRole("button", { name: button });
  await uploadThrough(page, async () => {
    await add.click();
    await acceptTermsIfAsked(page, () => add.click());
  }, file);
  await panel.getByRole("button", { name: UI.attached }).first().waitFor({ state: "visible", timeout: 180_000 });
  await page.waitForTimeout(2000);
}

async function pickAvatar(page: Page, name: string) {
  await tabPanel(page, "create").getByRole("button", { name: UI.avatarButton, exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Avatares" });
  await dialog.waitFor({ state: "visible" });
  const radio = dialog.getByRole("radio", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "i") }).first();
  if (!(await radio.count())) throw new Error(`No Vids avatar called "${name}". Stock avatars: ${AVATARS.join(", ")}.`);
  await radio.click();
  await dialog.getByRole("button", { name: UI.avatarConfirm, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function configureClip(page: Page, tab: Tab, opts: { aspect?: "16:9" | "9:16"; seconds?: number; resolution?: "720p" | "1080p" }) {
  const settings = tabPanel(page, tab).getByRole("button", { name: UI.settings });
  const summary = (await settings.getAttribute("aria-label")) ?? "";
  const seconds = opts.seconds === undefined ? undefined : Math.min(Math.max(Math.round(opts.seconds), MIN_CLIP_SECONDS), MAX_CLIP_SECONDS);
  const wantAspect = opts.aspect ? UI.aspectRadio[opts.aspect] : undefined;
  const ok =
    (!wantAspect || summary.includes(wantAspect)) && (seconds === undefined || summary.includes(`${seconds} segundos`)) && (!opts.resolution || summary.includes(opts.resolution));
  if (ok) return;
  await settings.click();
  // The settings popover is drawn outside the panel in the DOM, so its controls are looked up page-wide.
  if (opts.resolution && !summary.includes(opts.resolution)) {
    await page.getByRole("button", { name: /^(720p|1080p)$/ }).first().click();
    await page.getByRole("menuitemradio", { name: opts.resolution, exact: true }).click();
  }
  if (wantAspect) {
    // Google's custom radio: Playwright's check() hangs on it, so click only when it is not already on.
    const radio = page.getByRole("radiogroup", { name: UI.aspectGroup }).getByRole("radio", { name: wantAspect });
    if ((await radio.getAttribute("aria-checked")) !== "true") await radio.click();
  }
  if (seconds !== undefined) {
    // A plain <input type=range>, 3-10 in steps of 1: the value lives in value, not aria-valuenow.
    const slider = page.getByRole("slider", { name: UI.duration });
    if (Number(await slider.inputValue()) !== seconds) await slider.fill(String(seconds));
    const got = Number(await slider.inputValue());
    if (got !== seconds) throw new Error(`Could not set the clip length to ${seconds}s (Vids kept ${got}s).`);
  }
  await settings.click();
}

async function typePrompt(page: Page, tab: Tab, prompt: string) {
  const box = tabPanel(page, tab).getByRole("textbox");
  await box.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(prompt);
}

const OLD = "data-vids-mcp-old";
const inserts = (page: Page) => aiPanel(page).getByRole("button", { name: UI.insert, exact: true });
const newInsert = (page: Page) => inserts(page).and(page.locator(`:not([${OLD}])`));

class ClipTimeout extends Error {}

// A clip is ready once the progress bar has come and gone and an "Inserir" appeared that was not there before.
async function waitForClip(page: Page, job: Job, before: number) {
  const panel = aiPanel(page);
  const bar = panel.getByRole("progressbar");
  const start = Date.now();
  let started = false;
  while (Date.now() - start < CLIP_TIMEOUT_MS) {
    const busy = await bar.isVisible().catch(() => false);
    if (busy) started = true;
    if (!started && Date.now() - start > 60_000) throw new Error("Vids never started the generation (no progress bar appeared).");
    if (started && !busy && (await inserts(page).count()) > before && (await newInsert(page).isVisible().catch(() => false))) return;
    const refused = panel.getByText(UI.refusal).first();
    if (await refused.isVisible().catch(() => false)) throw new Error(`Vids refused the generation: "${(await refused.innerText()).trim()}"`);
    job.progress = `generating (${Math.round((Date.now() - start) / 1000)} s)`;
    await page.waitForTimeout(3000);
  }
  throw new ClipTimeout(`the clip was not ready after ${Math.round(CLIP_TIMEOUT_MS / 60_000)} min`);
}

const videoSources = (page: Page) =>
  page.locator("video").evaluateAll((els) => els.map((v) => (v as HTMLVideoElement).currentSrc || (v as HTMLVideoElement).src).filter((s) => /^https?:/.test(s)));

// An inserted clip plays from Drive (rr*.c.drive.google.com/videoplayback, MP4 720p). Fetched with the page's own
// cookies it comes back 206 video/mp4 (checked 2026-10-28), so a single clip is saved without exporting the video.
async function saveUrl(page: Page, url: string, target: string): Promise<void> {
  try {
    const res = await (await getContext()).request.get(url, { timeout: 120_000 });
    if (res.ok()) return writeFileSync(target, await res.body());
  } catch {
    // fall through to the page's own fetch
  }
  const b64 = (await page.evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const bytes = new Uint8Array(await r.arrayBuffer()); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  })()`)) as string;
  writeFileSync(target, Buffer.from(b64, "base64"));
}

// Arquivo → Baixar → Vídeo MP4: the whole document, rendered by Vids.
export async function exportMp4(page: Page, target: string): Promise<string> {
  const download = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS });
  download.catch(() => {});
  await page.getByRole("menuitem", { name: UI.fileMenu, exact: true }).click();
  await page.getByRole("menuitem", { name: UI.downloadMenu }).click();
  await page.getByRole("menuitem", { name: UI.downloadMp4 }).click();
  const d = await download;
  // A second CDP client can sweep Playwright's artifact folder mid-save (seen with flow-mcp): copy from path() then.
  await d.saveAs(target).catch(async () => copyFileSync((await d.path())!, target));
  return target;
}

// ---------- jobs ----------

function sceneTab(job: Job): Tab {
  const p = job.params;
  if (p.edit_video) return "edit";
  if (p.extend_video) return "extend";
  if (p.first_frame) return "animate";
  return "create";
}

export async function runGeneration(job: Job): Promise<string[]> {
  if (job.params.type === "image") return [await makeImage(job, job.params.prompt, join(job.params.output_dir, job.params.file_stem))];
  return [await makeClip(job)];
}

async function makeClip(job: Job): Promise<string> {
  const p = job.params;
  const tab = sceneTab(job);
  const page = await getVidsPage();
  page.setDefaultTimeout(UI_TIMEOUT_MS);
  mkdirSync(p.output_dir, { recursive: true });
  const target = join(p.output_dir, `${p.file_stem}.mp4`);
  const step = (s: string) => {
    job.progress = s;
    log(job.id, s);
  };

  step("opening the project video");
  await openProject(page, p.project, p.aspect_ratio === "9:16" ? "9:16" : "16:9");
  await startOwnScene(page);
  step(`opening Vídeo com IA → ${UI.tabs[tab]}`);
  await openAiPanel(page, tab);

  if (tab === "edit") {
    step("uploading the clip to edit");
    await attachMedia(page, tab, UI.addVideo, p.edit_video!);
  } else if (tab === "extend") {
    step("uploading the clip to extend");
    await attachMedia(page, tab, UI.addVideo, p.extend_video!);
  } else if (tab === "animate") {
    step("uploading the first frame");
    await attachMedia(page, tab, UI.addImage, await asPngOrJpg(page, p.first_frame!));
  } else {
    if (p.avatar) {
      step(`attaching the avatar ${p.avatar}`);
      await pickAvatar(page, p.avatar);
    }
    if (p.reference_images?.length) {
      step(`uploading ${p.reference_images.length} reference image(s)`);
      await attachReferences(page, p.reference_images);
    }
  }

  await configureClip(page, tab, {
    aspect: tab === "edit" ? undefined : p.aspect_ratio === "9:16" ? "9:16" : "16:9",
    seconds: tab === "edit" ? undefined : p.duration ?? MAX_CLIP_SECONDS,
    resolution: p.resolution,
  });
  await typePrompt(page, tab, p.prompt);

  const before = new Set(await videoSources(page));
  // Some Vids generations never finish: past the per-attempt limit the generation is cancelled and asked again.
  for (let attempt = 1; ; attempt++) {
    await inserts(page).evaluateAll((els, attr) => els.forEach((el) => el.setAttribute(attr, "1")), OLD);
    const count = await inserts(page).count();
    step(attempt > 1 ? `generating, attempt ${attempt} of ${CLIP_ATTEMPTS}` : "generating");
    await tabPanel(page, tab).getByRole("button", { name: UI.generate, exact: true }).click();
    try {
      await waitForClip(page, job, count);
      break;
    } catch (err) {
      if (!(err instanceof ClipTimeout) || attempt >= CLIP_ATTEMPTS) throw err;
      await aiPanel(page).getByRole("button", { name: UI.cancel, exact: true }).click().catch(() => {});
      await page.waitForTimeout(3000);
    }
  }

  // A clip that is not inserted is thrown away by Vids when the panel closes.
  step("inserting the clip into its scene");
  await newInsert(page).click();
  await page.waitForTimeout(4000);
  let url: string | undefined;
  for (let i = 0; i < 10 && !url; i++) {
    url = (await videoSources(page)).find((s) => !before.has(s));
    if (!url) await page.waitForTimeout(1500);
  }
  await aiPanel(page).getByRole("button", { name: UI.closePanel }).click().catch(() => {});

  if (url) {
    step("downloading the clip");
    await saveUrl(page, url, target);
    return target;
  }
  // The clip is in the document either way; without a direct address, the whole video is exported instead.
  step("exporting the whole video (the clip's own address was not found)");
  const whole = join(p.output_dir, `${p.file_stem}-whole-video.mp4`);
  await exportMp4(page, whole);
  job.note = `The clip is in the Vids video "${p.project}"; its own file could not be fetched, so the whole video was exported instead.`;
  return whole;
}

// ---------- images ----------

const imagePanel = (page: Page) => page.getByRole("complementary", { name: UI.imagePanel });

async function openImagePanel(page: Page) {
  if (await imagePanel(page).isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: UI.imageButton }).click();
  await imagePanel(page).waitFor({ state: "visible" });
}

async function imageSources(page: Page): Promise<string[]> {
  const srcs = await imagePanel(page).getByRole("menuitem", { name: UI.imageItem }).locator("img").evaluateAll((els) => els.map((el) => el.getAttribute("src") ?? ""));
  return srcs.filter((s) => s.startsWith("http"));
}

// "Gerar uma imagem" takes text, a shape and a style only: Vids accepts no reference picture for stills.
async function makeImage(job: Job, prompt: string, stem: string): Promise<string> {
  const p = job.params;
  const page = await getVidsPage();
  page.setDefaultTimeout(UI_TIMEOUT_MS);
  job.progress = "opening the project video";
  await openProject(page, p.project, p.aspect_ratio === "9:16" ? "9:16" : p.aspect_ratio === "1:1" ? "1:1" : "16:9");
  await openImagePanel(page);
  const panel = imagePanel(page);
  const before = new Set(await imageSources(page));

  await panel.getByRole("listbox", { name: UI.imageAspectList }).click();
  await page.getByRole("menuitemradio", { name: UI.imageAspect[(p.aspect_ratio as "1:1" | "16:9" | "9:16") ?? "16:9"] ?? UI.imageAspect["16:9"] }).click();
  const style = p.image_style ?? "Sem estilo";
  const styleList = panel.getByRole("listbox", { name: UI.imageStyleList });
  if (!(await styleList.getByRole("option", { name: new RegExp(`: ${style}$`) }).count())) {
    await styleList.click();
    // The thumbnail laid over the item takes the click: force it onto the item itself.
    await page.getByRole("menuitemradio", { name: new RegExp(`: ${style}$`) }).click({ force: true });
    await page.waitForTimeout(500);
  }
  if (await page.getByRole("menuitemradio").first().isVisible().catch(() => false)) await page.keyboard.press("Escape");

  await panel.getByRole("textbox").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(prompt.trim());
  // "Criar" only enables after a real keystroke.
  await page.keyboard.type(" ");
  job.progress = "drawing the image";
  await panel.getByRole("button", { name: UI.imageCreate, exact: true }).click();

  const deadline = Date.now() + IMAGE_TIMEOUT_MS;
  let src: string | undefined;
  while (!(src = (await imageSources(page)).find((s) => !before.has(s)))) {
    const refused = panel.getByText(UI.refusal).first();
    if (await refused.isVisible().catch(() => false)) throw new Error(`Vids refused the image: "${(await refused.innerText()).trim()}"`);
    if (Date.now() > deadline) throw new Error(`the image was not ready after ${IMAGE_TIMEOUT_MS / 60_000} min`);
    await page.waitForTimeout(2000);
  }
  // googleusercontent blocks the page's own fetch (CORS), so it comes through the browser context.
  const res = await (await getContext()).request.get(src);
  if (!res.ok()) throw new Error(`downloading the image failed: HTTP ${res.status()}`);
  const ext = (res.headers()["content-type"] ?? "").includes("png") ? "png" : "jpg";
  mkdirSync(p.output_dir, { recursive: true });
  const file = `${stem}.${ext}`;
  writeFileSync(file, await res.body());
  return file;
}

// A batch of stills, one after another in the project's image panel. Vids has nothing like Flow's parallel agent, so
// this is a loop; a still that fails is recorded and the rest carry on.
export async function runImageBatch(job: Job): Promise<string[]> {
  const p = job.params;
  const scenes = p.image_scenes ?? [];
  const base = Number(p.file_stem.match(/\d+/)?.[0] ?? 1);
  const numbers = p.image_numbers ?? scenes.map((_, i) => base + i);
  const files: string[] = [];
  const failed: number[] = [];
  for (const [i, prompt] of scenes.entries()) {
    job.progress = `image ${i + 1} of ${scenes.length}`;
    try {
      files.push(await makeImage(job, prompt, join(p.output_dir, `scene-${String(numbers[i]).padStart(2, "0")}`)));
    } catch (err) {
      log(job.id, "image failed", numbers[i], err);
      failed.push(numbers[i]);
    }
  }
  if (!files.length) throw new Error(`No image was made (${failed.length} failed).`);
  if (failed.length) {
    job.failed_scenes = failed;
    job.note = `still failed: scene ${failed.join(", ")}. vids_retry on this job makes just those again.`;
  }
  return files;
}

// ---------- whole videos ----------

// Exports a whole Vids video as MP4: a project of ours by name, or any video in the account by its exact title.
export async function downloadVideo(name: string, target: string): Promise<string> {
  const page = await getVidsPage();
  page.setDefaultTimeout(UI_TIMEOUT_MS);
  const url = projectUrl(name);
  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else {
    await page.goto(VIDS_HOME, { waitUntil: "domcontentloaded" });
    await checkPage(page);
    const items = page.locator(".docs-homescreen-grid-item-title").filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
    const n = await items.count();
    if (!n) throw new Error(`No Vids video called "${name}". vids_videos lists them.`);
    if (n > 1) throw new Error(`${n} Vids videos are called "${name}"; rename one in Vids first.`);
    await items.first().click();
  }
  await page.waitForURL(UI.editorUrl, { timeout: 60_000 });
  await checkPage(page);
  await dismissStartDialog(page);
  return exportMp4(page, target);
}

// ---------- characters: kept on this computer ----------

// Vids has no per-project character like Flow's; a character here is a portrait on disk plus its written look, attached
// as an ingredient (reference image) in every scene that names it. Stock and custom avatars are a separate thing
// (scene.avatar).
const CAST_FILE = join(HOME_DIR, "characters.json");
type CastEntry = { image: string; look?: string };
const cast = () => readJson<Record<string, CastEntry>>(CAST_FILE, {});
function saveCast(c: Record<string, CastEntry>) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(CAST_FILE, JSON.stringify(c, null, 2));
}
export const characterLook = (name: string): string | undefined => cast()[name]?.look;
export const characterImage = (name: string): string | undefined => cast()[name]?.image;
export const listCharacters = () => Object.entries(cast()).map(([name, c]) => ({ name, image: c.image, look: c.look }));
export function rememberCharacter(name: string, look: string) {
  const c = cast();
  if (c[name]) saveCast({ ...c, [name]: { ...c[name], look } });
}

const CAST_PROJECT = "_cast";

// `describe`: Vids draws the portrait (Gerar uma imagem, in a video kept for the cast). `image`: a picture you have.
export async function createCharacter(
  a: { name: string; describe?: string; image?: string; aspect_ratio?: "16:9" | "9:16" | "1:1"; style?: ImageStyle },
  outputRoot: string,
): Promise<{ name: string; image: string }> {
  const dir = join(outputRoot, "_cast");
  mkdirSync(dir, { recursive: true });
  let image: string;
  if (a.image) {
    if (!existsSync(a.image)) throw new Error(`Image not found: ${a.image}`);
    image = join(dir, `${a.name.replace(/[^\w.-]+/g, "_")}${extname(a.image).toLowerCase() || ".png"}`);
    copyFileSync(a.image, image);
  } else {
    const job = fakeJob({ project: CAST_PROJECT, output_dir: dir, aspect_ratio: a.aspect_ratio ?? "9:16", image_style: a.style });
    const prompt = `${a.describe}. One single person, full figure, plain neutral background, even soft light, facing the camera.`;
    image = await makeImage(job, prompt, join(dir, a.name.replace(/[^\w.-]+/g, "_")));
  }
  saveCast({ ...cast(), [a.name]: { image, look: a.describe ?? cast()[a.name]?.look } });
  return { name: a.name, image };
}

// Vids cannot redraw a picture from a reference, so a changed look is drawn again from the full description.
export async function editCharacter(name: string, look: string, outputRoot: string): Promise<{ name: string; image: string }> {
  if (!cast()[name]) throw new Error(`No character called "${name}". vids_characters lists them.`);
  return createCharacter({ name, describe: look }, outputRoot);
}

function fakeJob(params: Partial<Job["params"]>): Job {
  return { id: "cast", status: "running", params: { prompt: "", type: "image", project: CAST_PROJECT, output_dir: "", file_stem: "", ...params }, files: [], attempts: 1, createdAt: new Date().toISOString() };
}
