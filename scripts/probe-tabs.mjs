// Opens each tab of the AI video panel and prints the accessible name of the visible tabpanel. No generation.
import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9334");
const page = browser.contexts()[0].pages().find((p) => /docs\.google\.com\/videos\/d\//.test(p.url()));
const panel = page.getByRole("complementary", { name: "Clipe de vídeo gerado com IA" });
if (!(await panel.isVisible().catch(() => false))) await page.getByRole("button", { name: "Gerar um vídeo com IA" }).click();
for (const tab of ["Criar", "Editar", "Animar", "Estender"]) {
  await panel.getByRole("tab", { name: tab, exact: true }).click();
  await page.waitForTimeout(1200);
  const info = await panel.evaluate((root) => {
    const vis = (e) => e.getBoundingClientRect().width > 0;
    return [...root.querySelectorAll("[role=tabpanel]")].filter(vis).map((p) => ({
      label: p.getAttribute("aria-label"),
      by: p.getAttribute("aria-labelledby") && document.getElementById(p.getAttribute("aria-labelledby"))?.innerText.trim(),
      buttons: [...p.querySelectorAll("button")].filter(vis).map((b) => (b.getAttribute("aria-label") || b.innerText).trim().replace(/\s+/g, " ").slice(0, 50)),
    }));
  });
  const named = await panel.getByRole("tabpanel", { name: tab }).isVisible().catch(() => false);
  console.log(tab, "getByRole name match:", named, JSON.stringify(info));
}
process.exit(0);
