#!/usr/bin/env node
// Instala as skills deste repositório no Claude Code (~/.claude/skills).
// npx -y -p github:projetoswmfa/vids-mcp vids-mcp-skill
// Opções: --dest <pasta> instala em outra pasta de skills; --list só lista o que seria instalado.
import { cpSync, existsSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const DEST = resolve(opt("--dest") ?? join(homedir(), ".claude", "skills"));

const skills = readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SRC, d.name, "SKILL.md")))
  .map((d) => d.name);

if (args.includes("--list")) {
  for (const s of skills) console.log(s);
  process.exit(0);
}

for (const name of skills) {
  const to = join(DEST, name);
  if (existsSync(to)) {
    const backup = `${to}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(to, backup);
    console.log(`Versão anterior guardada em ${backup}`);
  }
  cpSync(join(SRC, name), to, { recursive: true, filter: (p) => !p.includes("__pycache__") });
  console.log(`Skill instalada: ${to}`);
}

console.log(`
Pronto. Próximos passos:
  1. Reinicie o Claude Code para ele carregar a skill.
  2. Peça um short (ex.: "quero um short sobre psicologia do preço") ou digite /diretor-de-shorts-editorial.
  3. Na primeira vez, a skill confere o MCP vids e pede o seu login no Google Vids antes de começar.
     Se o vids-mcp ainda não estiver instalado, ela oferece instalar (git clone + npm install + npm run build).
`);
