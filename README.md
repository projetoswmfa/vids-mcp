# vids-mcp

Servidor MCP local que opera o **Google Vids** (vids.new) num Chrome dedicado, pela interface real, em português.
Não usa API nem extensão: abre o Chrome num perfil próprio, você entra na sua conta Google uma vez, e o Claude
(ou o painel Vids Studio) cria os vídeos clicando nos mesmos botões que você clicaria.

Cada **projeto** vira um vídeo do Google Vids, com uma cena por clipe, e uma pasta em `~/vids-mcp-out/<projeto>` com
os arquivos baixados.

## O que faz

| Ferramenta | No Vids |
|---|---|
| `vids_generate` | Clipes com o Omni (3-10 s, 720p/1080p, 16:9 ou 9:16): texto + até 3 imagens de referência (Ingredientes) e/ou um avatar pronto (**Criar**), a partir de uma imagem (**Animar**), ou continuando a cena anterior (**Estender**). Também imagens (**Gerar uma imagem**). |
| `vids_images` | Lote de até 50 imagens, uma após a outra, com nova tentativa só das que falharem |
| `vids_edit` | Muda um clipe que você já tem (**Editar** com o Omni): luz, clima, fundo, objetos |
| `vids_extend` | Continua um clipe de onde ele termina (**Estender**) |
| `vids_character` / `_edit` / `vids_characters` | Personagens guardados no seu computador (retrato + descrição), usados como referência em qualquer cena com `asset:<nome>` |
| `vids_videos` / `vids_download` | Lista os seus vídeos do Vids e exporta qualquer um como MP4 (Arquivo → Baixar) |
| `vids_narrate` / `vids_voices` | Narração grátis (Google AI Studio ou vozes do Windows/macOS) |
| `vids_assemble` | Junta os clipes num filme com ffmpeg, com música e narração |
| `vids_transcribe` / `vids_captions` | Transcrição e legendas queimadas no vídeo (whisper.cpp, local) |
| `vids_status`, `vids_wait`, `vids_retry`, `vids_cancel`, `vids_techniques` | Sessão, fila e biblioteca de movimentos de câmera |

Todo clipe de vídeo usa a cota de geração do Google Vids da conta. O Vids não mostra preço antes de gerar.

## Instalação (Windows)

O projeto precisa ficar **fora do Google Drive**: o npm não consegue gravar o `node_modules` no Drive (os arquivos
ficam vazios). Ele fica em `C:\Users\<você>\vids-mcp`.

```bash
git clone https://github.com/projetoswmfa/vids-mcp.git
cd vids-mcp
npm install
npm run build
npm run login
```

O `npm run login` abre o Chrome do vids-mcp: entre na conta Google que tem o Google Vids. A sessão fica salva em
`~/.vids-mcp/chrome-profile`. A conta precisa estar em **Português (Brasil)**, porque os botões são encontrados pelos
nomes em pt-BR.

### No Claude (Claude Desktop / Claude Code)

No Claude Code:

```bash
claude mcp add vids --scope user -- node "C:/Users/<você>/vids-mcp/dist/index.js"
```

Ou no arquivo de configuração do Claude Desktop:

```json
{
  "mcpServers": {
    "vids": { "command": "node", "args": ["C:/Users/<você>/vids-mcp/dist/index.js"] }
  }
}
```

Troque `<você>` pelo seu usuário do Windows e reinicie o Claude.

### Painel sem o Claude

Dois cliques em **Vids Studio.cmd** (Windows) ou **Vids Studio.command** (Mac), depois `http://127.0.0.1:8788`.

## Coexistência com o flow-mcp

Portas e pastas próprias: painel na 8788, Chrome na porta CDP 9334, dados em `~/.vids-mcp` e filmes em
`~/vids-mcp-out`. Dá para rodar junto com o flow-mcp (8787 / 9333).

## Variáveis

`VIDS_MCP_HOME`, `VIDS_MCP_OUTPUT`, `VIDS_MCP_PORT`, `VIDS_MCP_CDP_PORT`, `VIDS_MCP_CHROME`, `VIDS_MCP_CLIP_TIMEOUT_S`
(espera por tentativa de clipe, padrão 240 s), `VIDS_MCP_PAUSE_MIN_S` / `VIDS_MCP_PAUSE_MAX_S` (pausa entre gerações),
`VIDS_MCP_DEBUG=1` (passos no stderr).

O mapa completo da interface do Vids está em [VIDS-MAP.md](VIDS-MAP.md).

## Aviso

Este projeto não é do Google nem tem ligação com ele. Ele automatiza a interface do Google Vids **na sua própria conta**,
e esse tipo de automação pode contrariar os termos de serviço do Google. Use por sua conta e risco.

- Se o Google mostrar um aviso de atividade incomum ou pedir verificação, pare na hora e não tente contornar.
  Insistir pode bloquear a conta.
- O vids-mcp nunca digita sua senha: o login é sempre feito por você, no `npm run login`.
- Cada clipe de vídeo usa a cota de geração da sua conta.

## Créditos e licença

Baseado no [flow-mcp](https://github.com/GTAI-1/flow-mcp), de GTAI-1 (driver do Google Flow). A fila, o painel, as
legendas, a montagem e a narração vieram de lá, e os primeiros commits deste repositório são dele. O driver do Google
Vids é novo.

O flow-mcp não declara licença, então a licença deste repositório está **pendente da autorização do autor original**.
Até lá, nenhuma licença de uso é concedida além do que o próprio GitHub permite (ver e fazer fork).
