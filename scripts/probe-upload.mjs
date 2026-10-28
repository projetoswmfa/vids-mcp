// Uploads one file through the open Google Picker (Fazer upload → Procurar) and reports what follows. No generation.
import { chromium } from "playwright-core";
const [file, shot] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9334");
const page = browser.contexts()[0].pages().find((p) => /docs\.google\.com\/videos\/d\//.test(p.url()));
const frame = page.frames().find((f) => /docs\.google\.com\/picker/.test(f.url()));
const chooser = page.waitForEvent("filechooser", { timeout: 10000 });
await frame.getByRole("button", { name: "Procurar" }).click();
await (await chooser).setFiles(file);
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(3000);
  const pickerOpen = page.frames().some((f) => /docs\.google\.com\/picker/.test(f.url()));
  const panel = await page.getByRole("complementary", { name: "Clipe de vídeo gerado com IA" }).getByRole("tabpanel", { name: "Animar" })
    .evaluate((el) => [...el.querySelectorAll("button,img,[role=img]")].filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => `${e.tagName}|${(e.getAttribute("aria-label") || e.getAttribute("alt") || e.innerText || "").trim().slice(0, 50)}`)).catch((e) => String(e));
  console.log(`${(i + 1) * 3}s picker=${pickerOpen}`, JSON.stringify(panel));
}
await page.screenshot({ path: shot });
process.exit(0);
