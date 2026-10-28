// Maps the Google Picker iframe ("Abrir um arquivo") open in the vids-mcp Chrome. Clicks only "Fazer upload".
import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9334");
const page = browser.contexts()[0].pages().find((p) => /docs\.google\.com\/videos\/d\//.test(p.url()));
const frame = page.frames().find((f) => /docs\.google\.com\/picker/.test(f.url()));
if (!frame) throw new Error("picker not open");
const dump = () => frame.evaluate(() => [...document.querySelectorAll("button,[role=button],[role=tab],[role=menuitem],[role=option],input[type=file]")]
  .filter((e) => e.getBoundingClientRect().width > 0 || e.type === "file")
  .map((e) => `${e.tagName}|${e.getAttribute("role") || e.type || ""}|${(e.getAttribute("aria-label") || e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60)}`));
console.log("BEFORE", JSON.stringify(await dump()));
await frame.getByText("Fazer upload", { exact: true }).first().click();
await page.waitForTimeout(1500);
console.log("AFTER", JSON.stringify(await dump()));
await page.screenshot({ path: process.argv[2] });
process.exit(0);
