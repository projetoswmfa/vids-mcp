// Live mapping helper: attaches to the vids-mcp Chrome (CDP 9334) and runs one step on the open Vids tab.
// node scripts/probe.mjs <step>   (steps below; none of them presses Gerar)
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VIDS_MCP_CDP_PORT ?? 9334}`);
const page = browser.contexts()[0].pages().find((p) => /docs\.google\.com\/videos\/d\//.test(p.url()));
if (!page) throw new Error("No Vids document open in the vids-mcp Chrome.");
page.setDefaultTimeout(15_000);

const dump = () =>
  page.evaluate(() => {
    const vis = (e) => e.getBoundingClientRect().width > 0;
    const name = (e) => (e.getAttribute("aria-label") || e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
    return {
      overlays: [...document.querySelectorAll('[role=menu],[role=dialog],[role=listbox]')].filter(vis).map((m) => ({
        role: m.getAttribute("role"),
        label: m.getAttribute("aria-label"),
        items: [...m.querySelectorAll("[role^=menuitem],button,[role=option],[role=radio]")].filter(vis).map(name),
      })),
      iframes: [...document.querySelectorAll("iframe")].filter(vis).map((f) => f.src.slice(0, 90)),
    };
  });

const panel = page.getByRole("complementary", { name: "Clipe de vídeo gerado com IA" });
const step = process.argv[2];
if (step === "animate-add") {
  if (!(await panel.isVisible().catch(() => false))) await page.getByRole("button", { name: "Gerar um vídeo com IA" }).click();
  await panel.getByRole("tab", { name: "Animar", exact: true }).click();
  const chooser = page.waitForEvent("filechooser", { timeout: 6000 }).then(() => "FILECHOOSER", () => "no filechooser");
  await panel.getByRole("tabpanel", { name: "Animar" }).getByRole("button", { name: "Adicionar imagem" }).click();
  console.log(await chooser);
  await page.waitForTimeout(1500);
}
console.log(JSON.stringify(await dump(), null, 1));
await page.screenshot({ path: process.env.SHOT ?? "probe.png" });
process.exit(0);
