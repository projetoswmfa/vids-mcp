# Mapa do Google Vids (vids.new)

*Mapeado ao vivo em 28/10/2026, conta projetoswmfa (Assinatura do Google), interface em pt-BR.
Nenhuma geração foi disparada: nada gastou cota. O que depende de uma geração real está marcado como "a confirmar".*

## Como o Vids se organiza (diferença central para o Flow)

- **Cada vídeo é um documento do Drive** (`docs.google.com/videos/d/<id>/edit`), com cenas numa linha do tempo.
  `vids.new` cria um documento novo a cada visita (`Vídeo sem título`).
- **Lista de vídeos** (o equivalente da "biblioteca"): `docs.google.com/videos/u/0/` → "Vídeos recentes".
- **Clipes gerados precisam ser inseridos numa cena** (botão `Inserir`); os não inseridos são descartados.
- **Download por clipe é possível**: o `<video>` de cada clipe na cena aponta para
  `https://rr*.c.drive.google.com/videoplayback?...&itag=22` (MP4 1280x720). Um `fetch` com `credentials:'include'`
  de dentro da página devolve `206 video/mp4`. Não é preciso exportar o vídeo inteiro para pegar um clipe.
- **Exportação do vídeo inteiro**: Arquivo → Baixar → `Vídeo MP4 (.mp4)` ou `Animação GIF (.gif)`.
- **Idioma por documento**: Arquivo → Idioma (permite fixar pt-BR ou inglês sem mexer na conta).

## Tela inicial do documento ("Vamos começar a criar")

Proporção: `Paisagem` · `Retrato` · `Quadrado`. Cartões: Criar vídeos com IA · Editar vídeos · Avatar de IA ·
Slides para vídeo · Gravar · Fazer upload · Modelos · Vídeo em branco.

## Barra lateral de inserção (toolbar "Inserção")

| Botão (aria-label) | Painel |
|---|---|
| `Gerar um vídeo com IA` | Clipe de vídeo gerado com IA (abaixo) |
| `Gerar um avatar` | Avatar de IA |
| `Gerar uma narração` | Narração com IA |
| `Gerar música` | Gere uma música (Lyria 3.5) |
| `Gerar uma imagem` | Gerar uma imagem |
| `Gravar` · `Drive e Fotos` · `Banco de mídias e Web` | gravação / seletor do Google / banco de mídia |
| `Legendas` | estilos de legenda nativos |
| `Inserir texto` · `Inserir usando modelos` · `Inserir formas e linhas` | elementos gráficos |

## Painel "Clipe de vídeo gerado com IA"

Quatro abas (`role=tab`):

| Aba | Campo de texto (aria-label) | Entrada | Equivale no Flow |
|---|---|---|---|
| `Criar` (Criar do zero) | "Descreva o vídeo. Você pode adicionar elementos…" | botões `Avatar` e `Ingredientes` | texto→vídeo + referências |
| `Editar` (Editar com um comando) | "Adicione seu vídeo e descreva as mudanças…" | `Adicionar vídeo` (MP4, WebM, MOV) | `flow_edit` (restyle) |
| `Animar` (Animar uma imagem) | "Adicione sua imagem e descreva o que vai acontecer…" | `Adicionar imagem` | quadro inicial |
| `Estender` (Criar um clipe de extensão) | "Adicione o vídeo e descreva o que acontece em seguida." | `Adicionar vídeo` | `flow_continue` |

- **Configurações** (`Configurações de geração: Omni, 720p, Paisagem, 10 segundos`):
  modelo `Omni` (único), resolução `720p` | `1080p`, proporção `Paisagem` | `Retrato`
  (rádios customizados), `Duração do vídeo` = `<input type=range>` 3–10, passo 1. A aba Editar não tem duração.
- **Ingredientes** abre o seletor do Google ("Abrir um arquivo": Google Drive, Fotos, `Fazer upload`), em iframe.
- **Avatar** (dentro de Criar) abre "Avatares": filtros Todos / Seus avatares / Realista / Desenho animado 3D /
  Desenho animado 2D, ~60 avatares prontos (rádios "Nome: voz (preset)") e `Criar um avatar personalizado`.
- **Selecionar um clipe na linha do tempo** mostra a barra "Contextual": `Editar com o Omni` (abre a aba Editar já
  com o clipe), `Editar com transcrição`, `Animação`, `Som`, `Opções de reprodução`, `Opções de formatação`.
  Com o clipe selecionado, a aba `Estender` também já vem com ele anexado (botão `Remover`).
- `Abrir galeria` mostra só a galeria de inspiração do Google (não é histórico do usuário).
- Sem cotação de custo na interface.

## Avatar personalizado ("Criar avatar personalizado", assistente de 4 passos)

Começar de uma imagem (4 exemplos) **ou** do zero: Gênero (Masculino/Feminino/Qualquer), Idade
(Jovem/Adulto/Meia-idade/Idoso), Origem racial (combobox), Roupa (Casual/Esporte fino/Formal), "Mais detalhes"
(até 5.000 caracteres), `Estou com sorte`, `Criar opções`. É o equivalente aos personagens do Flow.

## Avatar de IA e Narração com IA

Mesma estrutura: abas `Cena atual` | `Todas as cenas`, roteiro por cena (`Editar script`, `Script anterior`,
`Próximo script`, mínimo 15 palavras, `[` mostra tags de áudio), `Mudar o avatar` / `Mudar a voz`, `Prévia`,
`Inserir narração`. Avatar fala o roteiro em vídeo; narração gera só a voz.

## Música (Lyria 3.5)

Campo "Descreva sua música… gênero, humor, instrumentos ou suas próprias letras", botão `Inteira • Configurações vocais`, `Gerar`.

## Imagem

Campo "Descreva sua ideia…", listbox `Proporção`, listbox `Adicionar um estilo` (7 estilos, incl. "Sem estilo"), `Criar`.

## Legendas

`Aplicar a`: Todas as cenas | Cena atual; ~40 estilos com ênfase na palavra falada.

## Menus

- **Arquivo**: Novo vídeo, Abrir, Slides para vídeo, Fazer uma cópia ▸ (Vídeo completo | Cena selecionada),
  Compartilhar, Baixar ▸ (MP4 | GIF), Exportar para o Drive, Exportar para o YouTube, Renomear, Mover,
  Mover para a lixeira, Histórico de versões, Idioma ▸, Tamanho do vídeo.
- **Cena**: Nova cena (Ctrl+M), Modelos, Estilos, Duplicar, Excluir, Dividir no marcador (Ctrl+Shift+S),
  Mover, Plano de fundo, Transição (Ctrl+Alt+R), Animação.
- **Clique direito num clipe**: Cortar vídeo, Substituir vídeo ▸, Redefinir vídeo, Ampliar para preencher a cena,
  Definir como plano de fundo, Transcrição, Legendas, Opções de reprodução, Som, Extrair áudio, Equalizar o som.

## A confirmar com uma geração real (gasta cota)

- Quantas variações cada `Gerar` devolve e o tempo de cada aba (Editar, Animar, Estender).
- Se `Estender` emenda no último quadro exato (como o "exact join" do Flow).
- Se o avatar personalizado mantém o rosto quando usado na aba Criar.
- Tempo e saída da Música e do Avatar de IA.
