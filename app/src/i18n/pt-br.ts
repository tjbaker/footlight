// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Brazilian Portuguese (pt-BR) message catalog. First-pass translation of en.ts. */

import type { Messages } from "./types.js";

export const ptBR: Messages = {
  help: {
    menuLabel: "Guia do usuário",
    menuTrigger: "Ajuda",
    about: "Sobre o Footlight",
    reportBug: "Relatar um bug",
    viewOnGithub: "Ver no GitHub",
    title: "Footlight — Guia do usuário",
    subtitle: "Corte vídeo 16:9 em clipes verticais 9:16, com controle total sobre o enquadramento.",
    tocLabel: "Conteúdo",
    close: "Fechar",
    sections: [
      {
        id: "overview",
        title: "O que é o Footlight",
        blocks: [
          {
            kind: "p",
            text: "O Footlight transforma vídeo de origem 16:9 em clipes H.264 1080×1920 (9:16) limpos para Reels, TikTok e YouTube Shorts. Ele é orientado ao controle: você escolhe o momento e o enquadramento, e o Footlight faz o trabalho mecânico de cortar → recortar → escalar → codificar.",
          },
          {
            kind: "p",
            text: "Ele foi feito para footage de música e performances ao vivo — conteúdo sem transcrição para se basear, em que o sujeito se move pelo quadro, então cada clipe precisa de seu próprio enquadramento horizontal. O Footlight não escolhe os momentos por você.",
          },
          {
            kind: "list",
            items: [
              "Extrair um destaque vertical de um vídeo de show ou sessão ao vivo.",
              "Reenquadrar um plano aberto de palco para que o solista permaneça no quadro.",
              "Aproximar em um performer para um recorte mais fechado e intimista.",
              "Acompanhar um sujeito em movimento ao longo de um único plano contínuo (rastreamento automático por IA).",
            ],
          },
        ],
      },
      {
        id: "workflow",
        title: "O fluxo de trabalho em resumo",
        blocks: [
          {
            kind: "steps",
            items: [
              "Carregue uma origem (Procurar…, arraste um vídeo para a janela, ou cole um caminho absoluto e pressione Enter).",
              "Na linha do tempo de volume, arraste sobre a parte que você quer — isso define a Entrada e a Saída.",
              "Enquadre o plano com a caixa laranja 9:16 (arraste para mover, arraste um canto para aproximar / dar zoom).",
              "Clique em Adicionar clipe → fila. Repita para cada clipe que você quiser.",
              "Escolha uma pasta de Destino e clique em Renderizar.",
            ],
          },
          {
            kind: "tip",
            text: "Cada clipe carrega seu próprio enquadramento, então você pode renderizar de uma só vez vários clipes com enquadramentos diferentes a partir de uma mesma origem.",
          },
        ],
      },
      {
        id: "source",
        title: "Origem e destino",
        blocks: [
          {
            kind: "p",
            text: "Carregue uma origem com Procurar… (app nativo), arrastando um arquivo de vídeo para a janela (app nativo), ou digitando/colando um caminho absoluto e pressionando Enter. O palco mostra o quadro exato na posição do cabeçote; origens usadas recentemente são autocompletadas no campo de caminho.",
          },
          {
            kind: "p",
            text: "Destino é a pasta para onde os clipes renderizados são gravados. Use Procurar para escolhê-la; sua escolha é lembrada entre sessões.",
          },
        ],
      },
      {
        id: "inout",
        title: "Definindo a Entrada e a Saída",
        blocks: [
          {
            kind: "p",
            text: "A Entrada e a Saída marcam o início e o fim do clipe. Defina-as de três maneiras: arrastando sobre a linha do tempo de volume (a mais rápida), clicando em Definir entrada / Definir saída no quadro atual, ou pressionando I / O. O painel mostra entrada / saída / duração; os tempos de keyframe e de rastreamento automático são medidos a partir da Entrada.",
          },
          {
            kind: "tip",
            text: "Clique em um marcador de Entrada ou Saída na linha do tempo para selecioná-lo, depois ajuste-o um quadro por vez com ← / → (segure Shift para ±0,1s).",
          },
        ],
      },
      {
        id: "timeline",
        title: "A linha do tempo de volume",
        blocks: [
          {
            kind: "p",
            text: "A linha do tempo sob o visualizador é o controle de busca e corte do app. Ela desenha o volume da origem ao longo do tempo — as barras esquentam de cinza para laranja conforme ficam mais altas — para que seu olhar seja atraído pelos momentos dinâmicos.",
          },
          {
            kind: "list",
            items: [
              "Clique para buscar; arraste sobre a faixa para definir Entrada→Saída; arraste as bordas da região para ajustar.",
              "Passe o mouse sobre a faixa para pré-visualizar o quadro naquele momento.",
              "Os marcadores de “crescendo” sugeridos indicam transições de baixo→alto volume — clique em um para pular para logo antes da elevação.",
              "Os cortes de cena aparecem como traços; os botões ⏮ / ⏭ saltam entre eles. A detecção roda automaticamente ao carregar; Detectar cenas a executa novamente.",
            ],
          },
          {
            kind: "tip",
            text: "As sugestões de crescendo apenas movem o cabeçote — elas nunca definem a Entrada por você. Você sempre faz o corte.",
          },
        ],
      },
      {
        id: "framing",
        title: "Enquadramento: a caixa 9:16",
        blocks: [
          {
            kind: "p",
            text: "A caixa laranja é a região 9:16 que se torna seu clipe vertical. Tudo fora dela fica escurecido; a linha vertical sutil marca o centro dela.",
          },
          {
            kind: "list",
            items: [
              "Arraste a caixa para reenquadrar horizontalmente (e verticalmente, quando ela é uma aproximação).",
              "Arraste um canto para redimensioná-la — uma caixa menor aproxima (veja Aproximação / zoom).",
              "Dê um duplo-clique para redefini-la para a altura total, centralizada.",
            ],
          },
          {
            kind: "tip",
            text: "O cropdetect do ffmpeg só vê barras pretas. Pillarbox colorido ou desfocado é invisível para ele — avalie o enquadramento pelos pixels reais, não pelos metadados.",
          },
        ],
      },
      {
        id: "punchin",
        title: "Aproximação / zoom",
        blocks: [
          {
            kind: "p",
            text: "Uma aproximação (zoom) é uma caixa 9:16 menor que o quadro inteiro. Como a saída é sempre escalada para 1080×1920, uma caixa menor amplia o sujeito — um recorte mais fechado e próximo.",
          },
          {
            kind: "steps",
            items: [
              "Segure um canto da caixa laranja e arraste para dentro; ela permanece travada em 9:16.",
              "Arraste o corpo da caixa para posicionar a janela sobre o sujeito.",
              "O painel mostra o tamanho da janela e o fator de zoom (ex.: zoom 1,30×).",
            ],
          },
          {
            kind: "tip",
            text: "O zoom amplia a origem, então aproximações muito grandes amaciam a imagem. Mantenha-se moderado, a menos que a origem seja de alta resolução.",
          },
        ],
      },
      {
        id: "preview",
        title: "Pré-visualização ao vivo da saída 9:16",
        blocks: [
          {
            kind: "p",
            text: "O pequeno painel em formato de celular sobre o palco é uma pré-visualização ao vivo do resultado vertical real — recortado e escalado, atualizando conforme você enquadra (e acompanhando o sujeito quando o rastreamento automático está ligado). Sua etiqueta mostra o fator de zoom ao vivo.",
          },
          {
            kind: "list",
            items: [
              "Arraste-o pelo cabeçalho para qualquer canto para que ele não cubra o que você está enquadrando; o botão de pré-visualização na barra superior o oculta/mostra.",
              "“guias” sombreia a faixa de legenda inferior e a coluna de botões à direita que Reels / TikTok / Shorts sobrepõem ao seu vídeo — para que você não enquadre o sujeito onde a interface do app vai cobrir.",
            ],
          },
          {
            kind: "tip",
            text: "As guias são apenas uma referência — o arquivo renderizado é sempre o quadro 9:16 completo e limpo.",
          },
        ],
      },
      {
        id: "keyframes",
        title: "Recorte em movimento (keyframes e cronograma)",
        blocks: [
          {
            kind: "p",
            text: "Para origens editadas, com múltiplos planos, em que o sujeito muda de posição após cada corte, monte um cronograma de recorte em movimento: um conjunto de pontos de troca (tempo → enquadramento).",
          },
          {
            kind: "steps",
            items: [
              "Defina a Entrada primeiro — os tempos de keyframe são relativos ao clipe.",
              "Avance até um momento, enquadre-o com a caixa e clique em Adicionar keyframe em t.",
              "Repita em cada ponto em que o enquadramento deve mudar. Limpar keyframes esvazia a lista.",
            ],
          },
          {
            kind: "p",
            text: "Na renderização, o cronograma troca o recorte de forma abrupta em cada tempo (um corte instantâneo, não uma transição suave). Um único keyframe em t=0 é apenas um enquadramento estático.",
          },
          {
            kind: "tip",
            text: "Clique em Detectar cenas e alinhe seus tempos de troca aos próprios cortes da origem — a mudança de enquadramento então cai sobre um corte e fica invisível.",
          },
        ],
      },
      {
        id: "autotrack",
        title: "Rastrear sujeito automaticamente (IA)",
        blocks: [
          {
            kind: "p",
            text: "O rastreamento automático acompanha um sujeito em movimento ao longo de um único plano contínuo e monta um caminho de recorte suave e amortecido que faz panorâmicas para mantê-lo no quadro. É opcional e nunca obrigatório.",
          },
          {
            kind: "list",
            items: [
              "Defina Entrada/Saída em torno de um único plano (sem cortes secos no meio).",
              'Insira uma dica de sujeito, ex.: "a pessoa tocando violão".',
              "Defina sua chave de API do Gemini em Configurações (use sua própria chave).",
              "Clique em Rastrear automaticamente, revise o caminho amortecido e depois Adicionar clipe. Limpar rastreamento reverte para o enquadramento manual.",
            ],
          },
          {
            kind: "tip",
            text: "O rastreamento automático é uma sugestão para revisar, não uma garantia. Ele faz transições suaves (ao contrário dos keyframes, que trocam de forma abrupta) e serve para movimento dentro de um plano, não para cortes.",
          },
        ],
      },
      {
        id: "audio",
        title: "Áudio",
        blocks: [
          {
            kind: "p",
            text: "O áudio é copiado sem perdas por padrão — a faixa de origem passa intacta, então a codificação nunca adiciona uma geração de compressão nem reamostra. A origem é o teto de qualidade; recodifique apenas quando precisar de um corte de áudio exato no quadro.",
          },
        ],
      },
      {
        id: "queue",
        title: "A fila de clipes",
        blocks: [
          {
            kind: "p",
            text: "Adicionar clipe → fila prepara a Entrada/Saída + o enquadramento atuais como um cartão na faixa ao longo da parte inferior. Renderizar codifica a fila inteira de uma vez, para que você possa processar em lote vários clipes com enquadramentos diferentes de uma mesma origem.",
          },
          {
            kind: "list",
            items: [
              "Clique em um cartão para reabrir aquele clipe para edição; arraste os cartões para reordenar.",
              "Duplique um cartão para um segundo enquadramento do mesmo momento; ✕ o remove.",
              "Copiar JSON copia a fila como um manifesto que você pode salvar ou usar na CLI.",
            ],
          },
        ],
      },
      {
        id: "render",
        title: "Renderização e saída",
        blocks: [
          {
            kind: "p",
            text: "Renderizar codifica cada clipe da fila para MP4 H.264 1080×1920 na pasta de Destino. A janela de Atividade (ícone na barra de ferramentas) mostra os comandos exatos do ffmpeg e a saída, e abre automaticamente em caso de erro.",
          },
          {
            kind: "list",
            items: [
              "“Clipes gravados em …” mostra a pasta de saída resolvida após uma renderização bem-sucedida.",
              "Cada renderização bem-sucedida é salva no Histórico, para que você possa reabri-la e ajustá-la depois.",
            ],
          },
          {
            kind: "tip",
            text: "ffmpeg e ffprobe precisam estar instalados e no seu PATH — o Footlight os invoca, ele não os inclui.",
          },
        ],
      },
      {
        id: "history",
        title: "Histórico e sessões",
        blocks: [
          {
            kind: "p",
            text: "O botão de Histórico (barra superior) lista renderizações anteriores, das mais novas primeiro, agrupadas por dia. Abrir recarrega a origem daquele clipe e restaura sua Entrada/Saída e enquadramento para que você possa reenquadrar e recodificar — sem mexer na sua fila atual. Remover ou Limpar tudo poda a lista.",
          },
          {
            kind: "p",
            text: "O Footlight também salva automaticamente sua sessão de trabalho — origem, fila e destino — e a restaura na próxima vez que você abrir o app. Tudo é armazenado localmente no seu dispositivo; nada é enviado a lugar nenhum.",
          },
        ],
      },
      {
        id: "shortcuts",
        title: "Atalhos de teclado",
        blocks: [
          {
            kind: "p",
            text: "O Footlight é totalmente operável pelo teclado. Pressione ? a qualquer momento para a sobreposição completa de atalhos.",
          },
          {
            kind: "list",
            items: [
              "Space reproduz / pausa · ← / → avança um quadro · Shift+← / → ajusta ±0,1s.",
              "I / O define Entrada / Saída · S adiciona o clipe à fila · [ / ] pula para o corte anterior / próximo.",
              "Alt+setas ajustam a caixa de recorte · duplo-clique na caixa redefine o enquadramento.",
            ],
          },
        ],
      },
      {
        id: "tips",
        title: "Dicas e pegadinhas",
        blocks: [
          {
            kind: "list",
            items: [
              "Verifique o enquadramento pelos pixels, não por metadados de título/resolução/visualizações.",
              "Alinhe os tempos de troca de recorte aos cortes de cena para reenquadramentos invisíveis.",
              "Mantenha as aproximações moderadas em origens de baixa resolução para evitar amaciamento.",
              "Precedência quando mais de um está definido: caminho de rastreamento automático → janela de aproximação → deslocamento de recorte / cronograma.",
              "O H.264 precisa de dimensões pares; o Footlight arredonda os recortes para números pares por você.",
              "O recorte de conteúdo (remover letterbox/pillarbox antes do recorte 9:16) fica no campo content_crop do manifesto CSV/JSON — não há controle no app para ele.",
            ],
          },
        ],
      },
    ],
  },

  settings: {
    menuLabel: "Configurações",
    title: "Configurações",
    nav: {
      general: "Geral",
      rendering: "Renderização",
      ai: "IA e modelos",
      shortcuts: "Atalhos",
      about: "Sobre",
    },
    cancel: "Cancelar",
    save: "Salvar",
    saved: "Salvo",
    close: "Fechar",

    general: {
      title: "Geral",
      subtitle: "Preferências de todo o app, armazenadas localmente neste dispositivo.",
      appearance: "Aparência",
      theme: "Tema",
      themeLight: "Claro",
      themeDark: "Escuro",
      themeSystem: "Sistema",
      timecode: "Código de tempo",
      timecodeFrames: "Quadros",
      defaults: "Padrões",
      destination: "Destino",
      destinationBrowse: "Procurar…",
      destinationHint: "Pasta de saída padrão para clipes renderizados. Pré-preenche o destino do editor.",
      trackingInterval: "Intervalo de rastreamento",
      trackingIntervalHint: "Cadência de amostragem padrão da IA — mais amplo significa menos quadros, então mais barato.",
      session: "Sessão",
      autosave: "Salvar e restaurar a sessão automaticamente",
      autosaveHint: "Lembrar sua origem, fila e destino, e restaurá-los na próxima inicialização.",
      clearSession: "Limpar sessão salva",
      sessionCleared: "Sessão salva limpa.",
    },

    rendering: {
      title: "Renderização",
      subtitle: "Padrões para cada renderização — cada um corresponde a uma flag do footlight render.",
      quality: "Qualidade (CRF)",
      qualityNearLossless: "quase sem perdas",
      qualityHigh: "alta (padrão)",
      qualityGood: "boa",
      qualitySmaller: "arquivo menor",
      crfEndBest: "14 · quase sem perdas",
      crfEndSmall: "28 · menor",
      preset: "Predefinição do codificador",
      presetHint:
        "Predefinições mais lentas empacotam mais qualidade no mesmo tamanho — elas não mudam o CRF, apenas o tempo de codificação.",
      audio: "Áudio",
      audioCopy: "Copiar (sem perdas)",
      audioReencode: "Recodificar em AAC",
      audioCopyHint:
        "A faixa de origem passa intacta — a origem é o seu teto de qualidade.",
      audioReencodeHint: "Apenas para um corte de áudio exato no quadro em uma batida forte.",
      bitrate: "Taxa de bits",
      dryRun: "Mostrar o comando do ffmpeg antes de renderizar",
      dryRunHint: "Imprimir a invocação exata do ffmpeg para que você possa inspecioná-la ou copiá-la.",
      gapNote:
        "Esses padrões de renderização são persistidos; encadeá-los até a chamada de renderização é um passo seguinte.",
      captions: "Legendas",
      burnCaptions: "Gravar legendas no vídeo",
      burnCaptionsHint:
        "Desativado por padrão — uma exportação limpa é o padrão. Quando ativado, o texto e o estilo de legenda de cada clipe (definidos por clipe no editor) são desenhados no MP4 exportado.",
      fontsDir: "Pasta de fontes",
      fontsDirBrowse: "Procurar…",
      fontsDirPlaceholder: "Caminho para uma pasta de fontes .ttf/.otf",
      fontsDirHint:
        "Coloque suas fontes .ttf/.otf aqui para usá-las nas legendas. Elas aparecem em “Suas fontes” no seletor de fonte de legenda de cada clipe no editor.",
    },

    ai: {
      title: "IA e modelos",
      subtitle: "Opcional, use sua própria chave. Um único modelo multimodal faz tanto o rastreamento quanto o assistente.",
      provider: "Provedor",
      providerGemini: "Google Gemini",
      providerClaude: "Anthropic Claude",
      providerOpenai: "OpenAI",
      providerConnected: "conectado",
      providerAddKey: "+ adicionar chave",
      notImplemented: "ainda não implementado",
      notImplementedBody:
        "Apenas o Google Gemini está integrado hoje — Anthropic e OpenAI estão no roadmap.",
      apiKey: "Chave de API",
      apiKeyPlaceholder: "Chave de API do Gemini (use sua própria)",
      apiKeyShow: "Mostrar",
      apiKeyHide: "Ocultar",
      apiKeyTest: "Testar",
      apiKeyTesting: "Testando…",
      apiKeyValid: "A chave funciona",
      apiKeyInvalid: "A chave falhou",
      apiKeyHint: "Armazenada no chaveiro do sistema operacional, nunca em arquivos do projeto.",
      model: "Modelo de IA",
      recommended: "recomendado",
      costNote:
        "O rastreamento é o que gera custo: o Footlight envia quadros amostrados, não vídeo, então o custo escala com os quadros — definido pelo seu intervalo. Um plano típico de 20s a",
      costInterval: "Intervalo",
      advanced: "Usar um modelo separado para visão e rastreamento",
      advancedSub:
        "Caminho para usuários avançados: visão barata para o rastreamento, um modelo mais inteligente para o assistente. Desativado por padrão.",
      assistantModel: "Modelo do assistente",
      visionModel: "Modelo de visão e rastreamento",
      overlayTitle: "Preferências de enquadramento",
      overlaySub:
        "Adicionadas por cima da orientação de enquadramento do Footlight — seu gosto, não um substituto. Ex.: “mantenha meu rosto no terço superior”, “este local nunca usa letterbox”, “prefira recortes mais fechados nos solos”. A orientação de segurança (verifique os pixels, exportação limpa, áudio sem perdas) sempre prevalece em caso de conflito.",
      overlayPlaceholder: "Opcional: suas preferências pessoais de enquadramento…",
      baseView: "Orientação de enquadramento do Footlight",
      baseViewSub:
        "Somente leitura — a expertise aplicada a cada turno do assistente. Suas preferências acima se compõem por cima dela.",
      baseViewShow: "Mostrar",
      baseViewHide: "Ocultar",
    },

    shortcuts: {
      title: "Atalhos",
      subtitle: "Os atalhos voltados ao teclado. Pressione ? a qualquer momento para a sobreposição.",
    },

    about: {
      title: "Sobre",
      subtitle: "Versão, licenças e seu ambiente local do ffmpeg.",
      tagline: "Seu palco, na vertical.",
      repo: "Repositório no GitHub",
      reportBug: "Relatar um bug",
      licenses: "Licenças e avisos",
      environment: "Ambiente",
      environmentHint: "O Footlight invoca o ffmpeg/ffprobe do seu PATH — eles não são incluídos.",
      thanks: "Agradecimentos especiais a ",
    },
  },

  editor: {
    topbar: {
      noSource: "nenhuma origem carregada",
      render: "Renderizar",
      renderTitle: "Codificar cada clipe da fila para H.264 1080×1920.",
      activityTitle: "Mostrar saída de renderização, detecção de cenas e rastreamento automático",
      historyTitle: "Histórico — reabra uma renderização anterior para ajustar e recodificar",
      previewHide: "Ocultar a pré-visualização da saída 9:16",
      previewShow: "Mostrar a pré-visualização da saída 9:16",
      assistantTitle: "Assistente de IA (A) — proponha enquadramento em linguagem natural",
      themeToLight: "Mudar para o tema claro",
      themeToDark: "Mudar para o tema escuro",
      settingsTitle: "Configurações",
    },
    stage: {
      sourceTag: "ORIGEM",
      overlayTitle: "Arraste para reenquadrar · arraste um canto para aproximar / dar zoom · duplo-clique para redefinir",
      previewHeadTitle: "Arraste para mover · desative a pré-visualização na barra superior",
      guides: "guias",
      guidesTitle:
        "Mostrar as guias de área segura do TikTok/Reels — a faixa de legenda inferior + as zonas de botões à direita que a plataforma sobrepõe, para que você não enquadre o sujeito onde ele será coberto",
      heroH: "Seu palco, na vertical.",
      heroSub:
        "O Footlight transforma vídeo de performance 16:9 em clipes 9:16 perfeitos no quadro — você toma cada decisão.",
      heroCta: "Procurar… ou cole um caminho para carregar — depois marque, enquadre, enfileire, renderize.",
      frameAlt: "quadro atual",
    },
    transport: {
      playTitle: "Reproduza com áudio para encontrar sua Entrada/Saída de ouvido — Definir entrada/saída funciona durante a reprodução",
      inOut: "entrada→saída",
    },
    tabs: {
      frame: "Quadro",
      track: "Rastrear sujeito",
    },
    source: {
      header: "Origem",
      sourcePlaceholder: "/caminho/absoluto/para/origem.mp4",
      sourceTitle: "Digite ou cole um caminho absoluto e pressione Enter, ou use Procurar…",
      load: "Carregar",
      browse: "Procurar…",
      notLoaded: "Não carregada.",
      probing: "Analisando…",
      destPlaceholder: "clipes",
      destTitle: "Pasta onde os clipes renderizados são gravados.",
      dimKey: "dim",
      durKey: "dur",
      arKey: "proporção",
      cropdetectPrefix: "cropdetect (apenas barras pretas): crop=",
      cropdetectNone:
        "cropdetect: nenhuma barra preta detectada (pillarbox colorido/desfocado é invisível para ele — avalie o quadro a olho).",
      enterPath: "Insira um caminho absoluto para um arquivo de origem e clique em Carregar.",
      dropHint: "Arrastar e soltar carrega arquivos no app desktop — cole o caminho absoluto acima.",
    },
    clip: {
      header: "Clipe",
      setIn: "Definir entrada",
      setInTitle: "Marcar o início do clipe no quadro atual.",
      setOut: "Definir saída",
      setOutTitle: "Marcar o fim do clipe no quadro atual.",
      inKey: "entrada",
      outKey: "saída",
      durKey: "dur",
      offsetKey: "deslocamento",
    },
    framing: {
      header: "Enquadramento",
      loadASource: "crop_offset: (carregue uma origem)",
      contentOff: "content_crop: (desativado)",
      punchInPrefix: "aproximação: ",
      zoomMid: " · zoom ",
      resetSuffix: "× · duplo-clique para redefinir",
      cropOffsetPrefix: "crop_offset: ",
      contentCropPrefix: "content_crop: ",
      modeTrack: "rastreamento",
      modePunchIn: "aproximação",
      modeSchedule: "cronograma",
      defaultOffset: "centro",
    },
    captions: {
      header: "Legendas",
      hookPlaceholder: "gancho (linha grande, opcional)",
      hookTitle: "A linha grande de legenda gravada sobre o clipe (quando a gravação está ativa).",
      titlePlaceholder: "título (linha secundária, opcional)",
      titleTitle: "A linha secundária de legenda, exibida sob o gancho.",
      posVTitle: "Posicionamento vertical da legenda.",
      posHTitle: "Posicionamento horizontal da legenda.",
      posTop: "Topo",
      posCenter: "Centro",
      posBottom: "Base",
      posLeft: "Esquerda",
      posRight: "Direita",
      fontTitle:
        "Fonte da legenda — suas fontes (da pasta em Configurações), fontes do sistema, ou um caminho de arquivo personalizado.",
      fontPathPlaceholder: "/caminho/para/fonte.ttf",
      fontSystemDefault: "Padrão do sistema",
      fontYourFonts: "Suas fontes",
      fontSystemFonts: "Fontes do sistema",
      fontCustomPath: "Caminho personalizado…",
      fill: "Preenchimento",
      outline: "Contorno",
      bold: "Negrito",
      italic: "Itálico",
      underline: "Sublinhado",
      boxColor: "Cor da caixa",
      shadow: "Sombra",
      shadowTitle: "Sombra projetada atrás da legenda",
      box: "Caixa",
      boxTitle: "Caixa opaca atrás da legenda",
      rotate: "Girar",
    },
    keyframes: {
      header: "Recorte em movimento — keyframes",
      add: "Adicionar keyframe",
      addTitle: "Registrar o tempo atual + a posição da caixa como um ponto de troca de recorte.",
      clear: "Limpar",
      schedulePrefix: "cronograma: ",
      scheduleNone: "cronograma: (nenhum)",
      scheduleNoKeyframes: "cronograma: (sem keyframes — usa o deslocamento atual da caixa)",
      needIn: "Defina o ponto de Entrada antes de adicionar keyframes (os tempos de keyframe são relativos ao clipe).",
    },
    add: {
      header: "Adicionar à fila",
      namePlaceholder: "out_name (opcional, ex.: refrao_closeup)",
      addClip: "Adicionar clipe → fila",
      addClipTitle: "Adicionar a Entrada/Saída + o enquadramento atuais à fila.",
    },
    track: {
      header: "Rastrear sujeito",
      help: "Opcional. Faz panorâmicas para seguir um sujeito ao longo de um plano. Defina sua chave do Gemini em Configurações.",
      subjectPlaceholder: 'sujeito, ex.: "a pessoa tocando violão"',
      intervalPlaceholder: "0.75",
      intervalLabel: "intervalo (s)",
      autoTrack: "Rastrear automaticamente",
      autoTrackTitle: "Rastrear o sujeito ao longo do plano de Entrada/Saída e montar um caminho de recorte amortecido.",
      clearTrack: "Limpar rastreamento",
      clearTrackTitle: "Descartar o caminho rastreado; reverter para o enquadramento manual.",
      statusNone: "rastreamento: (nenhum — crop_offset manual em uso)",
      statusLoadSource: "rastreamento: carregue uma origem primeiro.",
      statusNeedInOut: "rastreamento: defina os pontos de Entrada e Saída primeiro.",
      statusOutAfterIn: "rastreamento: a Saída deve vir depois da Entrada.",
      statusNeedKey: "rastreamento: defina uma chave de API do Gemini em Configurações primeiro.",
      statusWorkingPrefix: "rastreamento: extraindo quadros + consultando o Gemini… ",
      statusWorkingSuffix: "s — isso pode demorar um pouco",
      statusNoBoxes: "rastreamento: nenhuma caixa utilizável — usando crop_offset manual.",
      statusOnPrefix: "rastreamento: LIGADO · ",
      statusOnSuffix: " keyframe(s). Limpe o rastreamento para reverter.",
      statusFailed: "rastreamento: falhou — veja a Saída.",
      noBoxesOutput:
        "Rastreamento automático: o rastreador não retornou caixas utilizáveis para a janela de Entrada→Saída. Revertendo para o crop_offset manual.",
      resultPrefix: "Rastreamento automático: ",
      resultMid: " keyframe(s) de ",
      resultSuffix:
        " amostra(s). A caixa de pré-visualização agora segue o sujeito ao longo do plano — Adicionar clipe → fila para renderizar com o caminho de recorte amortecido.",
      failedOutputPrefix: "O rastreamento automático falhou: ",
    },
    ask: {
      button: "Pergunte ao assistente…",
      title: "Abrir o assistente de IA para propor enquadramento em linguagem natural",
    },
    assistant: {
      title: "Assistente",
      sub: "Propõe cortes e enquadramentos — você aceita. Nunca ouve o áudio.",
      closeTitle: "Fechar o assistente (Esc / A)",
      suggestions: [
        "Encontre um refrão fechado perto da parte mais alta",
        "Rastreie o guitarrista ao longo deste plano",
        "Enquadre o cantor no momento atual",
        "Defina Entrada/Saída nos 15 segundos mais limpos",
      ],
      composerPlaceholder: "Peça ao assistente para encontrar um momento ou enquadrar um sujeito…",
      sendTitle: "Enviar (Enter)",
      greeting:
        "Diga-me o momento ou o sujeito que você quer e eu proporei o corte e o enquadramento. " +
        "Eu trabalho a partir do estado do seu projeto — cortes de cena e crescendos de volume — e olho para " +
        "quadros específicos quando enquadro ou rastreio um sujeito. Eu nunca ouço o áudio, e " +
        "cada proposta é pré-visualizada antes de mudar qualquer coisa.",
      youLabel: "você",
      assistantLabel: "assistente",
      needSource: "Carregue uma origem primeiro, então eu posso ler seus quadros e propor enquadramento.",
      needKey:
        "Eu preciso de uma chave de API do Gemini para ler os quadros. Adicione uma em Configurações → IA e modelos (ela fica armazenada no chaveiro do seu sistema operacional, nunca em arquivos do projeto), depois me pergunte de novo.",
      turnFailedPrefix: "Desculpe — esse turno falhou: ",
      grounded: "fundamentado em",
      proposed: "Proposto",
      actionSingular: "ação",
      actionPlural: "ações",
      arrow: "→",
      acceptAll: "Aceitar tudo",
      step: "Passo a passo",
      discard: "Descartar",
      appliedStagedPrefix: "Aplicado ",
      appliedStagedSuffix: " — renderização preparada. Use o botão Renderizar quando estiver pronto.",
      appliedPrefix: "Aplicada ",
      appliedSuffixSingular: " proposta.",
      appliedSuffixPlural: " propostas.",
      steppedThrough: "Percorreu todas as propostas.",
      discarded: "Descartado — seu estado permanece intacto.",
      renderStaged:
        "O assistente preparou a fila para renderização. Pressione Renderizar quando estiver pronto — eu nunca codifico automaticamente.",
      trackFromAssistantPrefix: "rastreamento: LIGADO · ",
      trackFromAssistantSuffix: " keyframe(s) (do assistente). Limpe o rastreamento para reverter.",
    },
    timeline: {
      prevCutTitle: "Pular para o corte anterior",
      nextCutTitle: "Pular para o próximo corte",
      suggested: "sugerido",
      cutsLabel: "cortes",
      swellsLabel: "crescendos",
      detectScenes: "Detectar cenas",
      detectScenesTitle: "Detectar cortes de cena — alinhe os tempos de troca de keyframe a eles.",
      seekSwellPrefix: "Ir para logo antes deste crescendo (",
      seekSwellSuffix: ")",
    },
    queue: {
      queueLabel: "Fila",
      addClip: "+ adicionar clipe",
      copyJson: "Copiar JSON",
      copyJsonTitle: "Copiar o JSON da fila para a área de transferência",
      renderN: "Renderizar",
      cardEditTitle: "Clique para reabrir este clipe para edição · arraste para reordenar",
      duplicateTitle: "Duplicar (ex.: um segundo enquadramento deste momento)",
      removeTitle: "Remover da fila",
    },
    activity: {
      title: "Atividade",
      copy: "⧉ Copiar",
      copyTitle: "Copiar a saída para a área de transferência",
      closeTitle: "Ocultar a janela de atividade",
      placeholder: "(a saída aparece aqui)",
      rendering: "Renderizando… (isso roda o ffmpeg por clipe; pode demorar um pouco)",
      okNoOutput: "OK (sem saída)",
      renderFailed: "A renderização falhou.",
      cantWritePrefix: "Não foi possível gravar em ",
      cantWriteFallbackReason: "escolha outra pasta",
      clipsWrittenTo: "Clipes gravados em ",
      detectingScenes: "Detectando cenas…",
      sceneCutsPrefix: "Cortes de cena (s): ",
      sceneCutsSuffix:
        "  (o rastreamento automático forçará uma nova amostra logo após cada corte dentro do intervalo de Entrada/Saída)",
      noScenes: "Nenhum corte de cena detectado (limite 0,4).",
      stagedForRender:
        "O assistente preparou a fila para renderização. Pressione Renderizar quando estiver pronto — eu nunca codifico automaticamente.",
      copied: "✓ Copiado",
      copyFailed: "A cópia falhou",
      copyIdle: "⧉ Copiar",
    },
    history: {
      ariaLabel: "Histórico de renderizações",
      title: "Histórico de renderizações",
      clearAll: "Limpar tudo",
      filterPlaceholder: "Filtrar por origem ou nome do clipe…",
      storedLabel: "armazenado",
      storedValue: "local",
      emptyHint: "Nenhuma renderização ainda — renderize um clipe e ele aparece aqui.",
      footHtmlBody:
        "<span><b>Abrir</b> carrega a origem e reenquadra o editor para aquela renderização. " +
        "Sua fila atual não é alterada.</span>",
      open: "Abrir",
      removeTitle: "Remover do histórico",
      noMatches: "Nenhuma correspondência.",
      renderSingular: "renderização",
      renderPlural: "renderizações",
      today: "Hoje",
      yesterday: "Ontem",
      modeTrack: "rastreamento",
      modePunchIn: "aproximação",
      modeKeyframes: "keyframes",
    },
    errors: {
      loadSourceFirst: "Carregue uma origem primeiro.",
      setInOut: "Defina os pontos de Entrada e Saída.",
      outAfterIn: "A Saída deve vir depois da Entrada.",
      addAtLeastOne: "Adicione pelo menos um clipe à fila.",
      previewPlayerFailed: "o reprodutor de pré-visualização não conseguiu carregar esta origem",
    },
    common: {
      close: "Fechar",
      dash: "—",
    },
  },

  shortcuts: {
    modalTitle: "Atalhos de teclado",
    close: "Fechar",
    groups: [
      {
        title: "Reprodução",
        items: [
          { keys: ["Space"], desc: "Reproduzir / pausar" },
          { keys: ["J"], desc: "Retroceder (pressione de novo para acelerar)" },
          { keys: ["K"], desc: "Pausar" },
          { keys: ["L"], desc: "Avançar (pressione de novo para acelerar)" },
          { keys: ["←", "→"], desc: "Avançar 1 quadro para trás / frente" },
          { keys: ["Shift", "←"], desc: "Ajustar o tempo em −0,1s" },
          { keys: ["Shift", "→"], desc: "Ajustar o tempo em +0,1s" },
        ],
      },
      {
        title: "Marcação",
        items: [
          { keys: ["I"], desc: "Definir Entrada no cabeçote" },
          { keys: ["O"], desc: "Definir Saída no cabeçote" },
          { keys: ["Shift", "I"], desc: "Ir para o ponto de Entrada" },
          { keys: ["Shift", "O"], desc: "Ir para o ponto de Saída" },
          { keys: ["S"], desc: "Adicionar o clipe atual à fila" },
        ],
      },
      {
        title: "Navegação",
        items: [
          { keys: ["["], desc: "Pular para o corte de cena anterior" },
          { keys: ["]"], desc: "Pular para o próximo corte de cena" },
        ],
      },
      {
        title: "Enquadramento",
        items: [
          { keys: ["Alt", "←"], desc: "Ajustar o recorte para a esquerda" },
          { keys: ["Alt", "→"], desc: "Ajustar o recorte para a direita" },
          { keys: ["Alt", "↑"], desc: "Ajustar o recorte para cima (aproximação)" },
          { keys: ["Alt", "↓"], desc: "Ajustar o recorte para baixo (aproximação)" },
          { keys: ["Double-click"], desc: "Redefinir o enquadramento para 9:16 de altura total" },
        ],
      },
      {
        title: "Ajuda",
        items: [
          { keys: ["?"], desc: "Mostrar esta sobreposição de atalhos" },
          { keys: ["Esc"], desc: "Fechar qualquer diálogo" },
        ],
      },
    ],
  },
};
