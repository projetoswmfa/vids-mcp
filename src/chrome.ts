import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

// The list of the account's videos. vids.new itself creates a new, empty document on every visit, so it is only
// opened when a new video is really wanted.
export const VIDS_HOME = "https://docs.google.com/videos/u/0/";
export const VIDS_NEW = "https://vids.new";
const VIDS_HOSTS = /^https:\/\/docs\.google\.com\/videos\//;
export const HOME_DIR = process.env.VIDS_MCP_HOME ?? join(homedir(), ".vids-mcp");
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
// Not 9333/8787: those belong to flow-mcp, which may be running on the same computer.
export const CDP_PORT = Number(process.env.VIDS_MCP_CDP_PORT ?? 9334);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const CHROME_PATHS = [
  process.env.VIDS_MCP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;

async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Real Chrome with a dedicated profile: Google sign-in works normally and the
// session persists, while the user's everyday profile is never touched.
export function chromeExecutable(): string {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) throw new Error("Google Chrome not found. Set VIDS_MCP_CHROME to the Chrome executable path.");
  return chromePath;
}

async function launchChrome(): Promise<void> {
  const chromePath = chromeExecutable();
  mkdirSync(PROFILE_DIR, { recursive: true });

  if (existsSync(join(PROFILE_DIR, "SingletonLock")) && !(await cdpUp())) {
    try {
      rmSync(join(PROFILE_DIR, "SingletonLock"), { force: true });
      rmSync(join(PROFILE_DIR, "SingletonCookie"), { force: true });
      rmSync(join(PROFILE_DIR, "SingletonSocket"), { force: true });
    } catch {}
  }

  const isLinuxHeadless = process.platform === "linux" && !process.env.DISPLAY;
  const isHeadless = isLinuxHeadless || process.env.VIDS_MCP_HEADLESS === "1";
  const headlessArgs = isHeadless
    ? ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    : [];

  const child = spawn(
    chromePath,
    [`--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${CDP_PORT}`, "--no-first-run", "--no-default-browser-check", ...headlessArgs, VIDS_HOME],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome started but CDP port ${CDP_PORT} never came up.`);
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!(await cdpUp())) await launchChrome();
  browser = await chromium.connectOverCDP(CDP_URL);
  return browser;
}

export async function getContext(): Promise<BrowserContext> {
  const context = (await getBrowser()).contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; close the Vids Chrome window and try again.");
  return context;
}

// The tab the driver works in. One is kept and reused, so the user sees a single Vids tab doing the work.
export async function getVidsPage(): Promise<Page> {
  const context = await getContext();
  const existing = context.pages().find((p) => VIDS_HOSTS.test(p.url()) || /^https:\/\/vids\.new/.test(p.url()));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(VIDS_HOME, { waitUntil: "domcontentloaded" });
  return page;
}

export const signedOut = (page: Page) => /accounts\.google\.com/.test(page.url());

// Every step finds Vids' buttons by their Portuguese (Brazil) names, mapped live on 2026-10-28. Unlike Flow, Vids
// ignores ?hl= (an hl=en address still showed pt-BR), so the account's own language decides, and a page in any other
// language is stopped with a clear message instead of failing on the first missing button.
export async function ensurePortuguese(page: Page): Promise<void> {
  if (!VIDS_HOSTS.test(page.url())) return;
  const lang = await page.evaluate(() => document.documentElement.lang).catch(() => "");
  if (lang && !/^pt\b/i.test(lang)) {
    throw new Error(
      `Google Vids is showing in "${lang}". vids-mcp finds Vids' buttons by their Portuguese (Brazil) names. ` +
        `Set the Google account's language to Português (Brasil) at myaccount.google.com/language, then try again.`,
    );
  }
}
