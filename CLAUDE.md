# vids-mcp

Local MCP server (stdio, TypeScript) that drives Google Vids (docs.google.com/videos, vids.new) in a dedicated Chrome
profile over CDP (`playwright-core`, `connectOverCDP` on port 9334). No extension, no API. Built from flow-mcp: the
queue, Studio panel, captions, assemble and narration came from there; the driver is new.

- `src/chrome.ts` launch/attach Chrome, pt-BR check · `src/vids.ts` UI driver (selectors in `UI`) · `src/queue.ts` paced job queue
- `src/core.ts` tool logic + zod shapes (LocalCore) · `src/server.ts` localhost HTTP API + Studio page (port 8788) ·
  `src/remote.ts` RemoteCore · `src/index.ts` MCP tools (`vids_*`) · `src/studio.ts` standalone panel
- `studio/index.html` Studio UI · `src/assemble.ts`, `src/captions.ts`, `src/gemini.ts` local media · `src/playbook.ts` guidance returned by `vids_status`
- `VIDS-MAP.md` the live map of the Vids UI. Test: `node scripts/e2e.mjs <project> '<scenes json>'`.

## Rules

- Never guess selectors. Map them from the live page (accessible names, DOM dump) before writing driver code, and add
  what you learn to VIDS-MAP.md.
- Every video clip uses the account's Vids generation quota and Vids shows no price: get the user's OK first.
- Never enter Google credentials; the user signs in by hand via `npm run login`.
- No bot-detection evasion; drive the real UI at human pace.
- Never push to the original flow-mcp repository (GTAI-1/flow-mcp). This is the user's own project; it has no remote
  until the user picks one.
- Keep the project OFF Google Drive: npm's tar writes fail there (`TAR_ENTRY_ERROR`, 0-byte package.json files) and
  Drive refuses junctions, so `node_modules` cannot live in or be linked from `G:\Meu Drive`. It lives in
  `C:\Users\User\vids-mcp`.

## How Vids works (differences from Flow that shape the driver)

- One project = one Vids document, remembered in `~/.vids-mcp/projects.json` (name → edit URL). `vids.new` creates a
  new document on EVERY visit, so it is opened only for a project with no document yet.
- Vids ignores `?hl=` (an hl=en address still showed pt-BR on 2026-10-28), so the account's language decides and
  `ensurePortuguese` stops with a clear message on any other language.
- A generated clip must be INSERTED (`Inserir`) or Vids discards it when the panel closes. After inserting, the clip's
  `<video>` plays from `rr*.c.drive.google.com/videoplayback` (MP4 720p); fetching that with the page's cookies gave
  206 video/mp4, so each clip is saved on its own. If no new source shows up, the whole document is exported instead
  (Arquivo → Baixar → Vídeo MP4) and the job says so.
- Editar and Estender take an uploaded MP4/WebM/MOV, so `vids_edit` / `vids_extend` / `chain_previous` work from local
  clip files, not from a library title.
- No last frame, no model choice (Omni only), no price, no parallel agent: image batches run one by one.
- Characters are local (portrait + look in `~/.vids-mcp/characters.json`) and go in as ingredients; Vids' own stock
  avatars are picked by name with a scene's `avatar`.

## Status (2026-10-28)

Verified live through this code (e2e.mjs, project TesteVids):
- Still: new Vids document from vids.new (aspect + "Criar vídeos com IA"), Gerar uma imagem 16:9 → scene-01.jpg in ~25 s.
- Clip (one paid 3 s take, the user's OK): Animar from that still → upload → settings (3 s) → Gerar (~60 s) → Inserir →
  per-clip download from the `<video>` source → scene-02.mp4, 3.008 s, 1280x720 + audio, opening on the still. Vids
  stamps a small Gemini sparkle in the bottom-right corner of AI clips.
- UPLOADS GO THROUGH GOOGLE'S PICKER now: "Adicionar imagem" (and Ingredientes) opens "Abrir um arquivo" in an
  iframe (docs.google.com/picker): option `Fazer upload` → button `Procurar` → file chooser; the picker closes itself
  and the panel shows img "Visualização da imagem enviada" + button "Remover imagem". uploadThrough() handles it and
  still accepts a direct file chooser. The first run failed here BEFORE Gerar (no quota used).
Ported from API - Vids-new (verified there 2026-10-22) and not yet re-run here: Criar with ingredients, cancel-and-retry on a stuck
generation, Arquivo → Baixar MP4. New and unverified: the Editar / Estender uploads ("Adicionar vídeo", attached state
assumed "Remover vídeo"), the Avatar picker (dialog "Avatares" → radio "<Nome>: …" → `Selecione`), the 1080p menu,
and the home-screen video list. `scripts/probe*.mjs` attach to the vids-mcp Chrome for live mapping without generating.
