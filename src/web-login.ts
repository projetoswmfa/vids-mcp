import type { IncomingMessage, ServerResponse } from "node:http";
import { getVidsPage, signedOut } from "./chrome.js";

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, limit = 65536): Promise<string> {
  return new Promise((ok, fail) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > limit) {
        fail(new Error("Body too large."));
        req.destroy();
      }
    });
    req.on("end", () => ok(body));
    req.on("error", fail);
  });
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Google Vids - Login Central</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 12px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding: 4px; }
    .title { font-size: 17px; font-weight: 700; }
    .status-badge { font-size: 13px; font-weight: 600; padding: 5px 12px; border-radius: 9999px; }
    .status-yellow { background: #854d0e; color: #fef08a; }
    .status-green { background: #166534; color: #bbf7d0; font-size: 14px; }
    .screen-container { position: relative; width: 100%; max-width: 820px; margin: 0 auto; background: #000; border-radius: 10px; overflow: hidden; border: 1px solid #334155; }
    #screen { width: 100%; height: auto; display: block; cursor: pointer; user-select: none; }
    .click-marker { position: absolute; width: 22px; height: 22px; border-radius: 50%; background: rgba(59, 130, 246, 0.7); border: 2px solid #93c5fd; transform: translate(-50%, -50%); pointer-events: none; animation: pulse 0.5s ease-out; }
    @keyframes pulse { from { transform: translate(-50%, -50%) scale(0.4); opacity: 1; } to { transform: translate(-50%, -50%) scale(1.6); opacity: 0; } }
    .controls { max-width: 820px; margin: 12px auto 0; display: flex; flex-direction: column; gap: 10px; }
    .input-card { background: #1e293b; padding: 12px; border-radius: 10px; border: 1px solid #334155; display: flex; flex-direction: column; gap: 8px; }
    .input-row { display: flex; gap: 8px; }
    input[type="text"], input[type="password"] { flex: 1; padding: 12px 14px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 16px; outline: none; }
    input[type="text"]:focus, input[type="password"]:focus { border-color: #3b82f6; }
    button { padding: 12px 16px; border-radius: 8px; border: none; font-weight: 600; font-size: 15px; cursor: pointer; background: #3b82f6; color: white; transition: background 0.15s; }
    button:active { filter: brightness(0.9); }
    .btn-next { background: #2563eb; font-size: 16px; padding: 14px; display: flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-secondary { background: #334155; color: #cbd5e1; padding: 10px; font-size: 14px; }
    .button-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .instructions { max-width: 820px; margin: 10px auto 0; font-size: 13px; color: #94a3b8; line-height: 1.4; background: #1e293b; padding: 10px 14px; border-radius: 8px; }
    .feedback { font-size: 13px; color: #38bdf8; text-align: center; min-height: 18px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">Google Vids - Login</div>
    <div id="statusPill" class="status-badge status-yellow">Aguardando login...</div>
  </div>

  <div class="screen-container" id="screenBox">
    <img id="screen" src="/login/screenshot" alt="Tela do Google" />
  </div>

  <div class="controls">
    <div class="input-card">
      <div class="input-row">
        <input type="text" id="textInput" placeholder="Digite seu e-mail ou senha aqui..." autocomplete="off" autocapitalize="none" />
        <button id="btnSend">Enviar Texto</button>
      </div>
      <div id="feedback" class="feedback"></div>
      <button class="btn-next" id="btnNext">Avançar (Seguinte) ➔</button>
    </div>
    <div class="button-grid">
      <button class="btn-secondary" id="btnRefresh">🔄 Atualizar Tela</button>
      <button class="btn-secondary" id="btnBack">⌫ Apagar</button>
      <button class="btn-secondary" id="btnRestart">🔁 Recarregar</button>
    </div>
  </div>

  <div class="instructions">
    💡 <b>Como usar no celular:</b><br/>
    1. Digite seu e-mail no campo acima e clique em <b>Enviar Texto</b>.<br/>
    2. Clique no botão azul grande <b>Avançar (Seguinte) ➔</b>.<br/>
    3. Digite sua senha, clique em <b>Enviar Texto</b> e depois em <b>Avançar (Seguinte) ➔</b>.<br/>
    4. Se precisar clicar em algo na tela (ex: escolher conta ou 2FA), toque direto na imagem!
  </div>

  <script>
    const screen = document.getElementById('screen');
    const screenBox = document.getElementById('screenBox');
    const textInput = document.getElementById('textInput');
    const statusPill = document.getElementById('statusPill');
    const feedback = document.getElementById('feedback');

    function refreshScreen() {
      screen.src = '/login/screenshot?t=' + Date.now();
    }

    screen.addEventListener('click', async (e) => {
      const rect = screen.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const marker = document.createElement('div');
      marker.className = 'click-marker';
      marker.style.left = (x / rect.width * 100) + '%';
      marker.style.top = (y / rect.height * 100) + '%';
      screenBox.appendChild(marker);
      setTimeout(() => marker.remove(), 600);

      feedback.textContent = 'Clicando na tela...';
      await fetch('/login/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, width: rect.width, height: rect.height })
      });
      setTimeout(() => { feedback.textContent = ''; refreshScreen(); }, 400);
    });

    async function sendText() {
      const text = textInput.value;
      if (!text) return;
      feedback.textContent = 'Enviando texto para a página...';
      const res = await fetch('/login/type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      if (data.ok) {
        feedback.textContent = 'Texto preenchido com sucesso!';
      } else {
        feedback.textContent = 'Erro ao preencher texto.';
      }
      textInput.value = '';
      setTimeout(() => { feedback.textContent = ''; refreshScreen(); }, 600);
    }

    async function sendNext() {
      feedback.textContent = 'Clicando em Avançar...';
      await fetch('/login/next', { method: 'POST' });
      setTimeout(() => { feedback.textContent = ''; refreshScreen(); }, 1200);
    }

    document.getElementById('btnSend').onclick = sendText;
    document.getElementById('btnNext').onclick = sendNext;
    document.getElementById('btnRefresh').onclick = refreshScreen;
    document.getElementById('btnBack').onclick = async () => {
      feedback.textContent = 'Apagando...';
      await fetch('/login/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'Backspace' })
      });
      setTimeout(() => { feedback.textContent = ''; refreshScreen(); }, 300);
    };
    document.getElementById('btnRestart').onclick = async () => {
      feedback.textContent = 'Recarregando página...';
      await fetch('/login/reload', { method: 'POST' });
      setTimeout(() => { feedback.textContent = ''; refreshScreen(); }, 1800);
    };

    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendText();
      }
    });

    async function checkStatus() {
      try {
        const res = await fetch('/login/status');
        const data = await res.json();
        if (data.signedIn) {
          statusPill.className = 'status-badge status-green';
          statusPill.textContent = '✅ Conectado ao Google Vids!';
        } else {
          statusPill.className = 'status-badge status-yellow';
          statusPill.textContent = 'Aguardando login...';
        }
      } catch {}
    }

    setInterval(refreshScreen, 2000);
    setInterval(checkStatus, 3000);
    checkStatus();
  </script>
</body>
</html>
`;

export async function handleWebLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/login")) return false;

  const page = await getVidsPage();

  if (url.pathname === "/login" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(LOGIN_HTML);
    return true;
  }

  if (url.pathname === "/login/screenshot" && req.method === "GET") {
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 65 });
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store, no-cache, must-revalidate",
        "content-length": buf.length,
      });
      res.end(buf);
    } catch {
      res.writeHead(500).end();
    }
    return true;
  }

  if (url.pathname === "/login/click" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const { x, y, width, height } = JSON.parse(raw);
      const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const realX = Math.round((x / width) * win.w);
      const realY = Math.round((y / height) * win.h);
      await page.mouse.click(realX, realY);
      json(res, 200, { ok: true, realX, realY });
    } catch (e: any) {
      json(res, 400, { error: e?.message ?? "Failed to click" });
    }
    return true;
  }

  if (url.pathname === "/login/type" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const { text } = JSON.parse(raw);
      if (typeof text === "string" && text.length > 0) {
        let filled = false;

        // 1. Tenta campo de e-mail / identificador
        const emailLoc = page.locator('#identifierId, input[name="identifier"]');
        if ((await emailLoc.count()) > 0) {
          try {
            await emailLoc.first().fill(text);
            filled = true;
          } catch {}
        }

        // 2. Tenta campo de senha
        if (!filled) {
          const passLoc = page.locator('input[type="password"]:visible, input[name="Passwd"]');
          if ((await passLoc.count()) > 0) {
            try {
              await passLoc.first().fill(text);
              filled = true;
            } catch {}
          }
        }

        // 3. Tenta campo de código 2FA / PIN
        if (!filled) {
          const pinLoc = page.locator('input#idvPinId, input[type="tel"], input[name="Pin"]');
          if ((await pinLoc.count()) > 0) {
            try {
              await pinLoc.first().fill(text);
              filled = true;
            } catch {}
          }
        }

        // 4. Fallback genérico para qualquer input visível
        if (!filled) {
          const anyLoc = page.locator('input:not([type="hidden"]):visible');
          if ((await anyLoc.count()) > 0) {
            try {
              await anyLoc.first().fill(text);
              filled = true;
            } catch {}
          }
        }

        // 5. Último recurso: inserção de texto no elemento focado
        if (!filled) {
          await page.keyboard.insertText(text);
        }
      }
      json(res, 200, { ok: true });
    } catch (e: any) {
      json(res, 400, { error: e?.message ?? "Failed to type" });
    }
    return true;
  }

  if (url.pathname === "/login/next" && req.method === "POST") {
    try {
      let clicked = false;
      const nextLoc = page.locator(
        '#identifierNext, #passwordNext, button:has-text("Seguinte"), button:has-text("Avançar"), button:has-text("Next")'
      );
      if ((await nextLoc.count()) > 0) {
        try {
          await nextLoc.first().click();
          clicked = true;
        } catch {}
      }

      if (!clicked) {
        await page.keyboard.press("Enter");
      }
      json(res, 200, { ok: true });
    } catch (e: any) {
      json(res, 400, { error: e?.message ?? "Failed to proceed" });
    }
    return true;
  }

  if (url.pathname === "/login/key" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const { key } = JSON.parse(raw);
      if (typeof key === "string") {
        await page.keyboard.press(key);
      }
      json(res, 200, { ok: true });
    } catch (e: any) {
      json(res, 400, { error: e?.message ?? "Failed to press key" });
    }
    return true;
  }

  if (url.pathname === "/login/reload" && req.method === "POST") {
    try {
      await page.reload();
      json(res, 200, { ok: true });
    } catch (e: any) {
      json(res, 400, { error: e?.message ?? "Failed to reload" });
    }
    return true;
  }

  if (url.pathname === "/login/status" && req.method === "GET") {
    json(res, 200, {
      signedIn: !signedOut(page),
      url: page.url(),
    });
    return true;
  }

  return false;
}
