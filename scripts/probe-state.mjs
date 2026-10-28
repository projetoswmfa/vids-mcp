// Prints what covers the Vids tab: open dialogs, picker frames, side panels, the AI toolbar button.
import { chromium } from "playwright-core";
const b = await chromium.connectOverCDP("http://127.0.0.1:9334");
const p = b.contexts()[0].pages().find((x) => /videos\/d\//.test(x.url()));
console.log("picker frames", p.frames().filter((f) => /picker/.test(f.url())).length);
console.log(JSON.stringify(await p.evaluate(() => {
  const vis = (e) => e.getBoundingClientRect().width > 0;
  return {
    dialogs: [...document.querySelectorAll("[role=dialog]")].filter(vis).map((d) => (d.getAttribute("aria-label") || "") + ": " + d.innerText.slice(0, 200)),
    aiBtn: [...document.querySelectorAll('[aria-label="Gerar um vídeo com IA"]')].map((e) => e.getBoundingClientRect().width),
    asides: [...document.querySelectorAll("[role=complementary]")].map((a) => vis(a) + ":" + a.innerText.slice(0, 80).replace(/\s+/g, " ")),
  };
}), null, 1));
process.exit(0);
