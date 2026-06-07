// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Spanish (es) message catalog. First-pass translation; native review welcome. */

import type { Messages } from "./types.js";

export const es: Messages = {
  help: {
    menuLabel: "Guía de usuario",
    menuTrigger: "Ayuda",
    about: "Acerca de Footlight",
    reportBug: "Reportar un error",
    viewOnGithub: "Ver en GitHub",
    title: "Footlight — Guía de usuario",
    subtitle: "Corta video 16:9 en clips verticales 9:16, con control total sobre el encuadre.",
    tocLabel: "Contenido",
    close: "Cerrar",
    sections: [
      {
        id: "overview",
        title: "Qué es Footlight",
        blocks: [
          {
            kind: "p",
            text: "Footlight convierte video de origen 16:9 en clips H.264 1080×1920 (9:16) limpios para Reels, TikTok y YouTube Shorts. Es control primero: tú eliges el momento y el encuadre, y Footlight realiza el corte → recorte → escalado → codificación mecánicos.",
          },
          {
            kind: "p",
            text: "Está pensado para material de música y actuaciones en vivo — contenido sin una transcripción de la que partir, donde el sujeto se mueve por el cuadro, así que cada clip necesita su propio encuadre horizontal. Footlight no elige los momentos por ti.",
          },
          {
            kind: "list",
            items: [
              "Extrae un destacado vertical de un concierto en vivo o un video de sesión.",
              "Reencuadra una toma amplia del escenario para que el solista quede en cuadro.",
              "Acércate sobre un intérprete para un recorte más cerrado e íntimo.",
              "Sigue a un sujeto en movimiento a lo largo de una toma continua (seguimiento automático con IA).",
            ],
          },
        ],
      },
      {
        id: "workflow",
        title: "El flujo de trabajo de un vistazo",
        blocks: [
          {
            kind: "steps",
            items: [
              "Carga un origen (Examinar…, arrastra un video a la ventana, o pega una ruta absoluta y pulsa Enter).",
              "En la línea de tiempo de volumen, arrastra sobre la parte que quieras — eso fija el In y el Out.",
              "Encuadra la toma con el recuadro naranja 9:16 (arrastra para mover, arrastra una esquina para acercar / hacer zoom).",
              "Haz clic en Añadir clip → cola. Repite para cada clip que quieras.",
              "Elige una carpeta de destino y haz clic en Renderizar.",
            ],
          },
          {
            kind: "tip",
            text: "Cada clip lleva su propio encuadre, así que puedes procesar por lotes muchos clips con encuadres distintos desde un solo origen en una sola renderización.",
          },
        ],
      },
      {
        id: "source",
        title: "Origen y destino",
        blocks: [
          {
            kind: "p",
            text: "Carga un origen con Examinar… (app nativa), arrastrando un archivo de video a la ventana (app nativa), o escribiendo/pegando una ruta absoluta y pulsando Enter. El escenario muestra el fotograma exacto en el cabezal de reproducción; los orígenes usados recientemente se autocompletan en el campo de ruta.",
          },
          {
            kind: "p",
            text: "El destino es la carpeta donde se escriben los clips renderizados. Usa Examinar para elegirla; tu elección se recuerda entre sesiones.",
          },
        ],
      },
      {
        id: "inout",
        title: "Definir el In y el Out",
        blocks: [
          {
            kind: "p",
            text: "El In y el Out marcan el inicio y el final del clip. Defínelos de tres maneras: arrastrando sobre la línea de tiempo de volumen (lo más rápido), haciendo clic en Marcar In / Marcar Out en el fotograma actual, o pulsando I / O. La lectura muestra in / out / duración; los tiempos de fotogramas clave y de seguimiento automático se miden desde el In.",
          },
          {
            kind: "tip",
            text: "Haz clic en un marcador de In o Out en la línea de tiempo para seleccionarlo, luego ajústalo fotograma a fotograma con ← / → (mantén Shift para ±0,1s).",
          },
        ],
      },
      {
        id: "timeline",
        title: "La línea de tiempo de volumen",
        blocks: [
          {
            kind: "p",
            text: "La línea de tiempo bajo el visor es el deslizador y recortador de la app. Dibuja el volumen del origen a lo largo del tiempo — las barras pasan de gris a naranja conforme suben de volumen — para que tu vista se dirija a los momentos dinámicos.",
          },
          {
            kind: "list",
            items: [
              "Haz clic para desplazarte; arrastra sobre la pista para fijar el In→Out; arrastra los bordes de la región para ajustar.",
              "Pasa el cursor por la pista para previsualizar el fotograma en ese momento.",
              "Las etiquetas de “crescendo” sugeridas marcan los aumentos de silencio→fuerte — haz clic en una para saltar justo antes de la subida.",
              "Los cortes de escena aparecen como marcas; los botones ⏮ / ⏭ saltan entre ellos. La detección se ejecuta automáticamente al cargar; Detectar escenas la vuelve a ejecutar.",
            ],
          },
          {
            kind: "tip",
            text: "Las sugerencias de crescendo solo desplazan el cabezal de reproducción — nunca fijan el In por ti. El corte siempre lo haces tú.",
          },
        ],
      },
      {
        id: "framing",
        title: "Encuadre: el recuadro 9:16",
        blocks: [
          {
            kind: "p",
            text: "El recuadro naranja es la región 9:16 que se convierte en tu clip vertical. Todo lo que queda fuera se atenúa; la tenue línea vertical marca su centro.",
          },
          {
            kind: "list",
            items: [
              "Arrastra el recuadro para reencuadrar horizontalmente (y verticalmente una vez que es un acercamiento).",
              "Arrastra una esquina para cambiar su tamaño — un recuadro más pequeño acerca la imagen (ver Acercamiento / zoom).",
              "Haz doble clic para restablecerlo a altura completa y centrado.",
            ],
          },
          {
            kind: "tip",
            text: "El cropdetect de ffmpeg solo ve barras negras. El pillarbox de color o difuminado le es invisible — juzga el encuadre por los píxeles reales, no por los metadatos.",
          },
        ],
      },
      {
        id: "punchin",
        title: "Acercamiento / zoom",
        blocks: [
          {
            kind: "p",
            text: "Un acercamiento (zoom) es un recuadro 9:16 más bajo que el cuadro completo. Como la salida siempre se escala a 1080×1920, un recuadro más pequeño amplía el sujeto — un recorte más cerrado y cercano.",
          },
          {
            kind: "steps",
            items: [
              "Toma una esquina del recuadro naranja y arrastra hacia dentro; se mantiene fijo a 9:16.",
              "Arrastra el cuerpo para posicionar la ventana sobre el sujeto.",
              "La lectura muestra el tamaño de la ventana y el factor de zoom (p. ej. zoom 1,30×).",
            ],
          },
          {
            kind: "tip",
            text: "El zoom amplía el origen, así que los acercamientos muy grandes suavizan la imagen. Mantente moderado a menos que el origen sea de alta resolución.",
          },
        ],
      },
      {
        id: "preview",
        title: "Vista previa en vivo de la salida 9:16",
        blocks: [
          {
            kind: "p",
            text: "El pequeño panel con forma de teléfono sobre el escenario es una vista previa en vivo del resultado vertical real — recortado y escalado, actualizándose mientras encuadras (y siguiendo al sujeto cuando el seguimiento automático está activado). Su etiqueta muestra el factor de zoom en vivo.",
          },
          {
            kind: "list",
            items: [
              "Arrástralo por su encabezado a cualquier esquina para que no cubra lo que estás encuadrando; el botón de vista previa en la barra superior lo oculta/muestra.",
              "“guías” sombrea la franja inferior de subtítulos y la columna de botones de la derecha que Reels / TikTok / Shorts superponen sobre tu video — para que no encuadres al sujeto donde la interfaz de la app lo va a cubrir.",
            ],
          },
          {
            kind: "tip",
            text: "Las guías son solo de referencia — el archivo renderizado siempre es el cuadro 9:16 completo y limpio.",
          },
        ],
      },
      {
        id: "keyframes",
        title: "Recorte en movimiento (fotogramas clave y programación)",
        blocks: [
          {
            kind: "p",
            text: "Para orígenes editados con múltiples tomas donde el sujeto salta entre posiciones tras cada corte, crea una programación de recorte en movimiento: un conjunto de puntos de cambio (tiempo → encuadre).",
          },
          {
            kind: "steps",
            items: [
              "Define primero el In — los tiempos de los fotogramas clave son relativos al clip.",
              "Desplázate a un momento, encuádralo con el recuadro y haz clic en Añadir fotograma clave en t.",
              "Repite en cada punto donde el encuadre deba cambiar. Borrar fotogramas clave vacía la lista.",
            ],
          },
          {
            kind: "p",
            text: "Al renderizar, la programación cambia el recorte de golpe en cada tiempo (un corte instantáneo, no un desplazamiento suave). Un solo fotograma clave en t=0 es simplemente un encuadre estático.",
          },
          {
            kind: "tip",
            text: "Haz clic en Detectar escenas y alinea tus tiempos de cambio con los cortes propios del origen — así el cambio de encuadre cae sobre un corte y es invisible.",
          },
        ],
      },
      {
        id: "autotrack",
        title: "Seguimiento automático del sujeto (IA)",
        blocks: [
          {
            kind: "p",
            text: "El seguimiento automático sigue a un sujeto en movimiento a lo largo de una toma continua y crea una trayectoria de recorte suave y atenuada que hace paneo para mantenerlo en cuadro. Es opcional y nunca obligatorio.",
          },
          {
            kind: "list",
            items: [
              "Define el In/Out alrededor de una sola toma (sin cortes secos dentro).",
              'Introduce una pista del sujeto, p. ej. "la persona tocando la guitarra".',
              "Configura tu clave de API de Gemini en Ajustes (trae tu propia clave).",
              "Haz clic en Seguimiento automático, revisa la trayectoria atenuada y luego Añadir clip. Borrar seguimiento vuelve al encuadre manual.",
            ],
          },
          {
            kind: "tip",
            text: "El seguimiento automático es una sugerencia que debes revisar, no una garantía. Se desplaza suavemente (a diferencia de los fotogramas clave, que cambian de golpe) y está pensado para el movimiento dentro de una toma, no para los cortes.",
          },
        ],
      },
      {
        id: "audio",
        title: "Audio",
        blocks: [
          {
            kind: "p",
            text: "El audio se copia sin pérdidas de forma predeterminada — la pista de origen pasa sin tocarse, así que la codificación nunca añade una generación de compresión ni remuestrea. El origen es el techo de calidad; recodifica solo cuando necesites un corte de audio exacto al fotograma.",
          },
        ],
      },
      {
        id: "captions",
        title: "Subtítulos (opcional)",
        blocks: [
          {
            kind: "p",
            text: "Cada clip puede llevar un gancho (la línea grande) y un título (la segunda línea) — tu lista de subtítulos, que viaja con el manifiesto. Los clips se exportan limpios de forma predeterminada; los subtítulos se incrustan en el video solo cuando la incrustación está activada (Ajustes → Renderizado → Subtítulos, o --burn-captions en la CLI).",
          },
          {
            kind: "p",
            text: "El estilo es por clip, se ajusta en el grupo de Subtítulos del editor junto al texto y la vista previa en vivo: fuente, color de relleno y de contorno, negrita / cursiva / subrayado, una sombra, una caja opaca, rotación y ubicación en una cuadrícula de 9 zonas.",
          },
          {
            kind: "list",
            items: [
              "Fuente — elige entre tus fuentes del sistema instaladas, una carpeta de fuentes personalizada que definas en Ajustes, o una ruta de archivo puntual. Footlight no incluye ninguna fuente ni descarga ninguna.",
              "Posición — nueve zonas: top / center / bottom, opcionalmente con el sufijo -left / -center / -right.",
              "La vista previa es una guía; el resultado incrustado es la autoridad — y no puede ver el pillarbox de color o difuminado, así que verifica los píxeles.",
            ],
          },
          {
            kind: "tip",
            text: "Mantén el texto del titular nativo cuando puedas — escrito directamente en Reels / TikTok / Shorts — para que siga siendo editable y evites la penalización de posicionamiento por texto no nativo. Incrusta subtítulos solo cuando los necesites en los píxeles (una descarga, una publicación cruzada, una plataforma sin herramienta de texto).",
          },
        ],
      },
      {
        id: "queue",
        title: "La cola de clips",
        blocks: [
          {
            kind: "p",
            text: "Añadir clip → cola coloca el In/Out + encuadre actuales como una tarjeta en la tira de película de la parte inferior. Renderizar codifica toda la cola de una vez, así que puedes procesar por lotes muchos clips con encuadres distintos desde un solo origen.",
          },
          {
            kind: "list",
            items: [
              "Haz clic en una tarjeta para reabrir ese clip y editarlo; arrastra las tarjetas para reordenarlas.",
              "Duplica una tarjeta para un segundo encuadre del mismo momento; ✕ la elimina.",
              "Exportar JSON guarda la cola como un manifiesto que puedes conservar o pasar a la CLI (footlight render).",
              "Borrar restablece el espacio de trabajo — origen, cola y encuadre — para empezar de cero; exporta primero si quieres conservar la cola.",
            ],
          },
        ],
      },
      {
        id: "render",
        title: "Renderizado y salida",
        blocks: [
          {
            kind: "p",
            text: "Renderizar codifica cada clip de la cola a MP4 H.264 1080×1920 en la carpeta de destino. La ventana de Actividad (icono de la barra de herramientas) muestra los comandos exactos de ffmpeg y su salida, y se abre automáticamente ante un error.",
          },
          {
            kind: "list",
            items: [
              "“Clips escritos en …” muestra la carpeta de salida resuelta tras una renderización exitosa.",
              "Cada renderización exitosa se guarda en el Historial, así que puedes reabrirla y ajustarla más tarde.",
            ],
          },
          {
            kind: "tip",
            text: "ffmpeg y ffprobe deben estar instalados y en tu PATH — Footlight los invoca, no los incluye.",
          },
        ],
      },
      {
        id: "history",
        title: "Historial y sesiones",
        blocks: [
          {
            kind: "p",
            text: "El botón Historial (barra superior) lista las renderizaciones anteriores, las más recientes primero, agrupadas por día. Abrir recarga el origen de ese clip y restaura su In/Out y encuadre para que puedas reencuadrar y recodificar — sin tocar tu cola actual. Eliminar o Borrar todo recorta la lista.",
          },
          {
            kind: "p",
            text: "Footlight también guarda automáticamente tu sesión de trabajo — origen, cola y destino — y la restaura la próxima vez que abras la app. Todo se almacena localmente en tu dispositivo; nada se envía a ningún lado.",
          },
        ],
      },
      {
        id: "shortcuts",
        title: "Atajos de teclado",
        blocks: [
          {
            kind: "p",
            text: "Footlight se puede manejar completamente con el teclado. Pulsa ? en cualquier momento para ver la superposición completa de atajos.",
          },
          {
            kind: "list",
            items: [
              "Space reproducir / pausar · J / K / L lanzadera atrás / pausa / adelante (pulsa J o L de nuevo para acelerar) · ← / → avanzar un fotograma · Shift+← / → ajustar ±0,1s.",
              "I / O marcar In / Out · Shift+I / O (o Q / W) saltar al punto In / Out · S añadir el clip a la cola.",
              "↑ / ↓ (o [ / ]) saltar al corte de escena anterior / siguiente · Home / End saltar al inicio / final.",
              "Alt+flechas ajustan el recuadro de recorte · doble clic en el recuadro restablece el encuadre.",
            ],
          },
        ],
      },
      {
        id: "tips",
        title: "Consejos y trampas",
        blocks: [
          {
            kind: "list",
            items: [
              "Verifica el encuadre por los píxeles, no por los metadatos de título/resolución/número de vistas.",
              "Alinea los tiempos de cambio de recorte con los cortes de escena para reencuadres invisibles.",
              "Mantén moderados los acercamientos en orígenes de baja resolución para evitar el suavizado.",
              "Precedencia cuando hay más de uno definido: trayectoria de seguimiento automático → ventana de acercamiento → desplazamiento de recorte / programación.",
              "H.264 necesita dimensiones pares; Footlight redondea los recortes a números pares por ti.",
              "El recorte de contenido (eliminar letterbox/pillarbox antes del recorte 9:16) vive en el campo content_crop del manifiesto CSV/JSON — no hay control para ello dentro de la app.",
            ],
          },
        ],
      },
    ],
  },

  settings: {
    menuLabel: "Ajustes",
    title: "Ajustes",
    nav: {
      general: "General",
      rendering: "Renderizado",
      ai: "IA y modelos",
      shortcuts: "Atajos",
      about: "Acerca de",
    },
    cancel: "Cancelar",
    save: "Guardar",
    saved: "Guardado",
    close: "Cerrar",

    general: {
      title: "General",
      subtitle: "Preferencias de toda la app, almacenadas localmente en este dispositivo.",
      appearance: "Apariencia",
      theme: "Tema",
      themeLight: "Claro",
      themeDark: "Oscuro",
      themeSystem: "Sistema",
      timecode: "Código de tiempo",
      timecodeFrames: "Fotogramas",
      defaults: "Valores predeterminados",
      destination: "Destino",
      destinationBrowse: "Examinar…",
      destinationHint: "Carpeta de salida predeterminada para los clips renderizados. Rellena previamente el destino del editor.",
      trackingInterval: "Intervalo de seguimiento",
      trackingIntervalHint: "Cadencia de muestreo predeterminada de la IA — más amplia significa menos fotogramas, así que más barato.",
      session: "Sesión",
      autosave: "Guardar y restaurar sesión automáticamente",
      autosaveHint: "Recuerda tu origen, cola y destino, y los restaura en el próximo inicio.",
      clearSession: "Borrar sesión guardada",
      sessionCleared: "Sesión guardada borrada.",
    },

    rendering: {
      title: "Renderizado",
      subtitle: "Valores predeterminados para cada renderización — cada uno corresponde a un parámetro de footlight render.",
      quality: "Calidad (CRF)",
      qualityNearLossless: "casi sin pérdidas",
      qualityHigh: "alta (predeterminada)",
      qualityGood: "buena",
      qualitySmaller: "archivo más pequeño",
      crfEndBest: "14 · casi sin pérdidas",
      crfEndSmall: "28 · más pequeño",
      preset: "Preajuste del codificador",
      presetHint:
        "Los preajustes más lentos meten más calidad en el mismo tamaño — no cambian el CRF, solo el tiempo de codificación.",
      audio: "Audio",
      audioCopy: "Copiar (sin pérdidas)",
      audioReencode: "Recodificar AAC",
      audioCopyHint:
        "La pista de origen pasa sin tocarse — el origen es tu techo de calidad.",
      audioReencodeHint: "Solo para un corte de audio exacto al fotograma en un tiempo fuerte.",
      bitrate: "Tasa de bits",
      dryRun: "Mostrar el comando de ffmpeg antes de renderizar",
      dryRunHint: "Imprime la invocación exacta de ffmpeg para que puedas inspeccionarla o copiarla.",
      gapNote:
        "Estos valores predeterminados de renderizado se conservan; pasarlos a la llamada de renderizado es un paso pendiente.",
      captions: "Subtítulos",
      burnCaptions: "Incrustar subtítulos en el video",
      burnCaptionsHint:
        "Desactivado de forma predeterminada — una exportación limpia es lo predeterminado. Al activarse, el texto y el estilo del subtítulo de cada clip (definidos por clip en el editor) se dibujan en el MP4 exportado.",
      fontsDir: "Carpeta de fuentes",
      fontsDirBrowse: "Examinar…",
      fontsDirPlaceholder: "Ruta a una carpeta de fuentes .ttf/.otf",
      fontsDirHint:
        "Coloca aquí tus fuentes .ttf/.otf para usarlas en los subtítulos. Aparecen bajo “Tus fuentes” en el selector de fuente de subtítulo de cada clip en el editor.",
    },

    ai: {
      title: "IA y modelos",
      subtitle: "Opcional, trae tu propia clave. Un solo modelo multimodal hace tanto el seguimiento como el asistente.",
      provider: "Proveedor",
      providerGemini: "Google Gemini",
      providerClaude: "Anthropic Claude",
      providerOpenai: "OpenAI",
      providerConnected: "conectado",
      providerAddKey: "+ añadir clave",
      notImplemented: "aún no implementado",
      notImplementedBody:
        "Hoy solo Google Gemini está conectado — Anthropic y OpenAI están en la hoja de ruta.",
      apiKey: "Clave de API",
      apiKeyPlaceholder: "Clave de API de Gemini (trae tu propia clave)",
      apiKeyShow: "Mostrar",
      apiKeyHide: "Ocultar",
      apiKeyTest: "Probar",
      apiKeyTesting: "Probando…",
      apiKeyValid: "La clave funciona",
      apiKeyInvalid: "La clave falló",
      apiKeyHint: "Almacenada en el llavero del SO, nunca en archivos del proyecto.",
      model: "Modelo de IA",
      recommended: "recomendado",
      costNote:
        "El seguimiento es el principal factor de costo: Footlight envía fotogramas muestreados, no video, así que el costo escala con los fotogramas — definido por tu intervalo. Una toma típica de 20s a",
      costInterval: "Intervalo",
      advanced: "Usar un modelo separado para visión y seguimiento",
      advancedSub:
        "Ruta para usuarios avanzados: visión económica para el seguimiento, un modelo más inteligente para el asistente. Desactivado de forma predeterminada.",
      assistantModel: "Modelo del asistente",
      visionModel: "Modelo de visión y seguimiento",
      overlayTitle: "Preferencias de encuadre",
      overlaySub:
        "Se añaden encima de la guía de encuadre de Footlight — tu gusto, no un reemplazo. Por ejemplo: “mantén mi cara en el tercio superior”, “este recinto nunca pone letterbox”, “prefiere recortes más cerrados en los solos”. La guía de seguridad (verifica los píxeles, exportación limpia, audio sin pérdidas) siempre prevalece en caso de conflicto.",
      overlayPlaceholder: "Opcional: tus preferencias personales de encuadre…",
      baseView: "Guía de encuadre de Footlight",
      baseViewSub:
        "Solo lectura — la experiencia aplicada en cada turno del asistente. Tus preferencias de arriba se componen encima de ella.",
      baseViewShow: "Mostrar",
      baseViewHide: "Ocultar",
    },

    shortcuts: {
      title: "Atajos",
      subtitle: "Las combinaciones de teclas. Pulsa ? en cualquier momento para ver la superposición.",
    },

    about: {
      title: "Acerca de",
      subtitle: "Versión, licencias y tu entorno local de ffmpeg.",
      tagline: "Tu escenario, en vertical.",
      repo: "Repositorio de GitHub",
      reportBug: "Reportar un error",
      licenses: "Licencias y avisos",
      environment: "Entorno",
      environmentHint: "Footlight invoca ffmpeg/ffprobe desde tu PATH — no están incluidos.",
      thanks: "Agradecimientos especiales a ",
    },
  },

  editor: {
    topbar: {
      noSource: "ningún origen cargado",
      render: "Renderizar",
      renderTitle: "Codificar cada clip de la cola a H.264 1080×1920.",
      activityTitle: "Mostrar la salida de renderizado, detección de escenas y seguimiento automático",
      historyTitle: "Historial — reabre una renderización anterior para ajustarla y recodificarla",
      previewHide: "Ocultar la vista previa de salida 9:16",
      previewShow: "Mostrar la vista previa de salida 9:16",
      assistantTitle: "Asistente de IA (A) — propón encuadres en lenguaje natural",
      themeToLight: "Cambiar a tema claro",
      themeToDark: "Cambiar a tema oscuro",
      settingsTitle: "Ajustes",
      clear: "Limpiar",
      clearTitle: "Limpiar todo y empezar de nuevo",
    },
    stage: {
      sourceTag: "ORIGEN",
      overlayTitle: "Arrastra para reencuadrar · arrastra una esquina para acercar / hacer zoom · doble clic para restablecer",
      previewHeadTitle: "Arrastra para mover · desactiva la vista previa en la barra superior",
      guides: "guías",
      guidesTitle:
        "Muestra las guías de zona segura de TikTok/Reels — la franja inferior de subtítulos y la zona de botones de la derecha que una plataforma superpone, para que no encuadres al sujeto donde quedará cubierto",
      heroH: "Tu escenario, en vertical.",
      heroSub:
        "Footlight convierte video de actuaciones 16:9 en clips 9:16 perfectos al fotograma — cada decisión la tomas tú.",
      dropTitle: "Arrastra un video aquí",
      dropTitleActive: "Suelta para cargar",
      dropRatio: "9 : 16 salida",
      pasteHint: "o pega una ruta",
      flowMark: "Marca",
      flowFrame: "Encuadra",
      flowQueue: "Encola",
      flowRender: "Renderiza",
      guide: "¿Primera vez? Lee la guía →",
      frameAlt: "fotograma actual",
    },
    transport: {
      playTitle: "Reproduce con audio para encontrar tu In/Out de oído — Marcar In/Out funciona mientras se reproduce",
      inOut: "in→out",
    },
    tabs: {
      frame: "Fotograma",
      track: "Seguir sujeto",
    },
    source: {
      header: "Origen",
      sourcePlaceholder: "/ruta/absoluta/a/origen.mp4",
      sourceTitle: "Escribe o pega una ruta absoluta y pulsa Enter, o usa Examinar…",
      load: "Cargar",
      browse: "Examinar…",
      notLoaded: "No cargado.",
      probing: "Analizando…",
      destPlaceholder: "clips",
      destTitle: "Carpeta donde se escriben los clips renderizados.",
      dimKey: "dim",
      durKey: "dur",
      arKey: "ar",
      cropdetectPrefix: "cropdetect (solo barras negras): crop=",
      cropdetectNone:
        "cropdetect: no se detectaron barras negras (el pillarbox de color/difuminado le es invisible — examina el cuadro a ojo).",
      enterPath: "Introduce una ruta absoluta a un archivo de origen, luego haz clic en Cargar.",
      dropHint: "Arrastrar y soltar carga archivos en la app de escritorio — pega la ruta absoluta arriba.",
    },
    clip: {
      header: "Clip",
      setIn: "Marcar In",
      setInTitle: "Marca el inicio del clip en el fotograma actual.",
      setOut: "Marcar Out",
      setOutTitle: "Marca el final del clip en el fotograma actual.",
      inKey: "in",
      outKey: "out",
      durKey: "dur",
      offsetKey: "desplazamiento",
    },
    framing: {
      header: "Encuadre",
      loadASource: "crop_offset: (carga un origen)",
      contentOff: "content_crop: (desactivado)",
      punchInPrefix: "acercamiento: ",
      zoomMid: " · zoom ",
      resetSuffix: "× · doble clic para restablecer",
      cropOffsetPrefix: "crop_offset: ",
      contentCropPrefix: "content_crop: ",
      modeTrack: "seguimiento",
      modePunchIn: "acercamiento",
      modeSchedule: "programación",
      defaultOffset: "centro",
    },
    captions: {
      header: "Subtítulos",
      hookPlaceholder: "gancho (línea grande, opcional)",
      hookTitle: "La línea grande de subtítulo incrustada sobre el clip (cuando la incrustación está activada).",
      titlePlaceholder: "título (línea secundaria, opcional)",
      titleTitle: "La línea secundaria de subtítulo, mostrada bajo el gancho.",
      posVTitle: "Posición vertical del subtítulo.",
      posHTitle: "Posición horizontal del subtítulo.",
      posTop: "Arriba",
      posCenter: "Centro",
      posBottom: "Abajo",
      posLeft: "Izquierda",
      posRight: "Derecha",
      fontTitle:
        "Fuente del subtítulo — tus fuentes (de la carpeta de Ajustes), fuentes del sistema o una ruta de archivo personalizada.",
      fontPathPlaceholder: "/ruta/a/fuente.ttf",
      fontSystemDefault: "Predeterminada del sistema",
      fontYourFonts: "Tus fuentes",
      fontSystemFonts: "Fuentes del sistema",
      fontCustomPath: "Ruta personalizada…",
      fill: "Relleno",
      outline: "Contorno",
      bold: "Negrita",
      italic: "Cursiva",
      underline: "Subrayado",
      boxColor: "Color del recuadro",
      shadow: "Sombra",
      shadowTitle: "Sombra paralela detrás del subtítulo",
      box: "Recuadro",
      boxTitle: "Recuadro opaco detrás del subtítulo",
      rotate: "Rotar",
    },
    keyframes: {
      header: "Recorte en movimiento — fotogramas clave",
      add: "Añadir fotograma clave",
      addTitle: "Registra el tiempo + la posición del recuadro actuales como un punto de cambio de recorte.",
      clear: "Borrar",
      schedulePrefix: "programación: ",
      scheduleNone: "programación: (ninguna)",
      scheduleNoKeyframes: "programación: (sin fotogramas clave — usa el desplazamiento actual del recuadro)",
      needIn: "Define el punto In antes de añadir fotogramas clave (los tiempos de los fotogramas clave son relativos al clip).",
    },
    add: {
      header: "Añadir a la cola",
      namePlaceholder: "out_name (opcional, p. ej. coro_primerplano)",
      addClip: "Añadir clip → cola",
      addClipTitle: "Añade el In/Out + encuadre actuales a la cola.",
    },
    track: {
      header: "Seguir sujeto",
      help: "Opcional. Hace paneo para seguir a un sujeto a lo largo de una toma. Configura tu clave de Gemini en Ajustes.",
      subjectPlaceholder: 'sujeto, p. ej. "la persona tocando la guitarra"',
      intervalPlaceholder: "0.75",
      intervalLabel: "intervalo (s)",
      autoTrack: "Seguimiento automático",
      autoTrackTitle: "Sigue al sujeto a lo largo de la toma In/Out y crea una trayectoria de recorte atenuada.",
      clearTrack: "Borrar seguimiento",
      clearTrackTitle: "Descarta la trayectoria seguida; vuelve al encuadre manual.",
      statusNone: "seguimiento: (ninguno — crop_offset manual en uso)",
      statusLoadSource: "seguimiento: carga un origen primero.",
      statusNeedInOut: "seguimiento: define primero los puntos In y Out.",
      statusOutAfterIn: "seguimiento: el Out debe ir después del In.",
      statusNeedKey: "seguimiento: configura primero una clave de API de Gemini en Ajustes.",
      statusWorkingPrefix: "seguimiento: extrayendo fotogramas + consultando a Gemini… ",
      statusWorkingSuffix: "s — esto puede tardar un rato",
      statusNoBoxes: "seguimiento: sin recuadros utilizables — usando crop_offset manual.",
      statusOnPrefix: "seguimiento: ACTIVADO · ",
      statusOnSuffix: " fotograma(s) clave. Borrar seguimiento para revertir.",
      statusFailed: "seguimiento: falló — ver Salida.",
      noBoxesOutput:
        "Seguimiento automático: el seguidor no devolvió recuadros utilizables para la ventana In→Out. Volviendo al crop_offset manual.",
      resultPrefix: "Seguimiento automático: ",
      resultMid: " fotograma(s) clave de ",
      resultSuffix:
        " muestra(s). El recuadro de vista previa ahora sigue al sujeto a lo largo de la toma — Añadir clip → cola para renderizar con la trayectoria de recorte atenuada.",
      failedOutputPrefix: "El seguimiento automático falló: ",
    },
    ask: {
      button: "Pregúntale al asistente…",
      title: "Abre el asistente de IA para proponer encuadres en lenguaje natural",
    },
    assistant: {
      title: "Asistente",
      sub: "Propone cortes y encuadres — tú los aceptas. Nunca oye el audio.",
      closeTitle: "Cerrar el asistente (Esc / A)",
      suggestions: [
        "Encuentra un coro cerrado alrededor de la parte fuerte",
        "Sigue al guitarrista a lo largo de esta toma",
        "Encuadra al cantante en el momento actual",
        "Define el In/Out en los 15 segundos más limpios",
      ],
      composerPlaceholder: "Pídele al asistente que encuentre un momento o encuadre a un sujeto…",
      sendTitle: "Enviar (Enter)",
      greeting:
        "Dime el momento o el sujeto que quieres y propondré el corte y el encuadre. " +
        "Trabajo a partir del estado de tu proyecto — cortes de escena y crescendos de volumen — y miro " +
        "fotogramas específicos cuando encuadro o sigo a un sujeto. Nunca oigo el audio, y " +
        "cada propuesta se previsualiza antes de cambiar nada.",
      youLabel: "tú",
      assistantLabel: "asistente",
      needSource: "Carga un origen primero, luego podré leer sus fotogramas y proponer un encuadre.",
      needKey:
        "Necesito una clave de API de Gemini para leer fotogramas. Añade una en Ajustes → IA y modelos (se almacena en el llavero de tu SO, nunca en archivos del proyecto), luego pregúntame de nuevo.",
      turnFailedPrefix: "Lo siento — ese turno falló: ",
      grounded: "fundamentado en",
      proposed: "Propuesto",
      actionSingular: "acción",
      actionPlural: "acciones",
      arrow: "→",
      acceptAll: "Aceptar todo",
      step: "Paso a paso",
      discard: "Descartar",
      appliedStagedPrefix: "Aplicado ",
      appliedStagedSuffix: " — renderizado preparado. Usa el botón Renderizar cuando estés listo.",
      appliedPrefix: "Aplicado ",
      appliedSuffixSingular: " propuesta.",
      appliedSuffixPlural: " propuestas.",
      steppedThrough: "Revisadas todas las propuestas una a una.",
      discarded: "Descartado — tu estado queda intacto.",
      renderStaged:
        "El asistente preparó la cola para renderizar. Pulsa Renderizar cuando estés listo — nunca codifico automáticamente.",
      trackFromAssistantPrefix: "seguimiento: ACTIVADO · ",
      trackFromAssistantSuffix: " fotograma(s) clave (del asistente). Borrar seguimiento para revertir.",
    },
    timeline: {
      prevCutTitle: "Saltar al corte anterior",
      nextCutTitle: "Saltar al corte siguiente",
      suggested: "sugerido",
      cutsLabel: "cortes",
      swellsLabel: "crescendos",
      detectScenes: "Detectar escenas",
      detectScenesTitle: "Detecta cortes de escena — alinea con ellos los tiempos de cambio de fotogramas clave.",
      seekSwellPrefix: "Ir a justo antes de este crescendo (",
      seekSwellSuffix: ")",
    },
    queue: {
      queueLabel: "Cola",
      addClip: "+ añadir clip",
      exportJson: "Exportar JSON",
      exportJsonTitle: "Guarda la cola como un manifiesto JSON (se reimporta con footlight render)",
      renderN: "Renderizar",
      cardEditTitle: "Haz clic para reabrir este clip y editarlo · arrastra para reordenar",
      duplicateTitle: "Duplicar (p. ej. un segundo encuadre de este momento)",
      removeTitle: "Quitar de la cola",
    },
    activity: {
      title: "Actividad",
      copy: "⧉ Copiar",
      copyTitle: "Copia la salida al portapapeles",
      closeTitle: "Ocultar la ventana de actividad",
      placeholder: "(la salida aparece aquí)",
      rendering: "Renderizando… (esto ejecuta ffmpeg por clip; puede tardar un rato)",
      okNoOutput: "OK (sin salida)",
      renderFailed: "El renderizado falló.",
      cantWritePrefix: "No se puede escribir en ",
      cantWriteFallbackReason: "elige otra carpeta",
      clipsWrittenTo: "Clips escritos en ",
      detectingScenes: "Detectando escenas…",
      sceneCutsPrefix: "Cortes de escena (s): ",
      sceneCutsSuffix:
        "  (el seguimiento automático forzará una nueva muestra justo después de cada corte dentro del rango In/Out)",
      noScenes: "No se detectaron cortes de escena (umbral 0,4).",
      stagedForRender:
        "El asistente preparó la cola para renderizar. Pulsa Renderizar cuando estés listo — nunca codifico automáticamente.",
      copied: "✓ Copiado",
      copyFailed: "Copia fallida",
      copyIdle: "⧉ Copiar",
    },
    history: {
      ariaLabel: "Historial de renderizado",
      title: "Historial de renderizado",
      clearAll: "Borrar todo",
      filterPlaceholder: "Filtrar por origen o nombre de clip…",
      storedLabel: "almacenado",
      storedValue: "local",
      emptyHint: "Aún no hay renderizaciones — renderiza un clip y aparecerá aquí.",
      footHtmlBody:
        "<span><b>Abrir</b> carga el origen y reencuadra el editor a esa renderización. " +
        "Tu cola actual no se toca.</span>",
      open: "Abrir",
      removeTitle: "Quitar del historial",
      noMatches: "Sin coincidencias.",
      renderSingular: "renderización",
      renderPlural: "renderizaciones",
      today: "Hoy",
      yesterday: "Ayer",
      modeTrack: "seguimiento",
      modePunchIn: "acercamiento",
      modeKeyframes: "fotogramas clave",
    },
    errors: {
      loadSourceFirst: "Carga un origen primero.",
      setInOut: "Define los puntos In y Out.",
      outAfterIn: "El Out debe ir después del In.",
      addAtLeastOne: "Añade al menos un clip a la cola.",
      previewPlayerFailed: "el reproductor de vista previa no pudo cargar este origen",
    },
    common: {
      close: "Cerrar",
      dash: "—",
    },
    clear: {
      title: "¿Limpiar todo?",
      body: "Esto descarta la fuente cargada, toda la cola y tu encuadre, y empieza de cero. Exporta la cola primero si quieres conservarla.",
      cancel: "Cancelar",
      confirm: "Limpiar todo",
    },
  },

  shortcuts: {
    modalTitle: "Atajos de teclado",
    close: "Cerrar",
    groups: [
      {
        title: "Reproducción",
        items: [
          { keys: ["Space"], desc: "Reproducir / pausar" },
          { keys: ["J"], desc: "Retroceder (pulsa otra vez para acelerar)" },
          { keys: ["K"], desc: "Pausar" },
          { keys: ["L"], desc: "Avanzar (pulsa otra vez para acelerar)" },
          { keys: ["←", "→"], desc: "Avanzar 1 fotograma atrás / adelante" },
          { keys: ["Shift", "←"], desc: "Ajustar el tiempo −0,1s" },
          { keys: ["Shift", "→"], desc: "Ajustar el tiempo +0,1s" },
        ],
      },
      {
        title: "Marcado",
        items: [
          { keys: ["I"], desc: "Marcar In en el cabezal de reproducción" },
          { keys: ["O"], desc: "Marcar Out en el cabezal de reproducción" },
          { keys: ["Shift", "I"], desc: "Ir al punto In (también Q)" },
          { keys: ["Shift", "O"], desc: "Ir al punto Out (también W)" },
          { keys: ["S"], desc: "Añadir el clip actual a la cola" },
        ],
      },
      {
        title: "Navegación",
        items: [
          { keys: ["["], desc: "Corte de escena anterior (también ↑)" },
          { keys: ["]"], desc: "Corte de escena siguiente (también ↓)" },
          { keys: ["Home"], desc: "Ir al inicio" },
          { keys: ["End"], desc: "Ir al final" },
        ],
      },
      {
        title: "Encuadre",
        items: [
          { keys: ["Alt", "←"], desc: "Ajustar el recorte a la izquierda" },
          { keys: ["Alt", "→"], desc: "Ajustar el recorte a la derecha" },
          { keys: ["Alt", "↑"], desc: "Ajustar el recorte hacia arriba (acercamiento)" },
          { keys: ["Alt", "↓"], desc: "Ajustar el recorte hacia abajo (acercamiento)" },
          { keys: ["Double-click"], desc: "Restablecer el encuadre a 9:16 de altura completa" },
        ],
      },
      {
        title: "Ayuda",
        items: [
          { keys: ["?"], desc: "Mostrar esta superposición de atajos" },
          { keys: ["Esc"], desc: "Cerrar cualquier diálogo" },
        ],
      },
    ],
  },
};
