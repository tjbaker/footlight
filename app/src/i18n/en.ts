// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** English (en) message catalog. The reference locale; copy this to add another. */

import type { Messages } from "./types.js";

export const en: Messages = {
  help: {
    menuLabel: "User Guide",
    menuTrigger: "Help",
    about: "About Footlight",
    reportBug: "Report a Bug",
    viewOnGithub: "View on GitHub",
    title: "Footlight — User Guide",
    subtitle: "Cut 16:9 video into vertical 9:16 clips, with full control over framing.",
    tocLabel: "Contents",
    close: "Close",
    sections: [
      {
        id: "overview",
        title: "What Footlight is",
        blocks: [
          {
            kind: "p",
            text: "Footlight turns 16:9 source video into clean 1080×1920 (9:16) H.264 clips for Reels, TikTok, and YouTube Shorts. It is control-first: you choose the moment and the framing, and Footlight does the mechanical cut → crop → scale → encode.",
          },
          {
            kind: "p",
            text: "It is built for music and live-performance footage — content with no transcript to key off, where the subject moves across the frame so each clip needs its own horizontal framing. Footlight does not pick moments for you.",
          },
          {
            kind: "list",
            items: [
              "Pull a vertical highlight from a live concert or session video.",
              "Reframe a wide stage shot so the soloist stays in frame.",
              "Punch in on a performer for a tighter, more intimate crop.",
              "Follow a moving subject across one continuous shot (AI auto-track).",
            ],
          },
        ],
      },
      {
        id: "workflow",
        title: "Workflow at a glance",
        blocks: [
          {
            kind: "steps",
            items: [
              "Load a source (Browse…, drag a video onto the window, or paste an absolute path and press Enter).",
              "On the loudness timeline, drag across the part you want — that sets In and Out.",
              "Frame the shot with the orange 9:16 box (drag to move, drag a corner to punch in / zoom).",
              "Click Add clip → queue. Repeat for each clip you want.",
              "Pick a Destination folder and click Render.",
            ],
          },
          {
            kind: "tip",
            text: "Every clip carries its own framing, so you can batch many differently-framed clips from one source into a single render.",
          },
        ],
      },
      {
        id: "source",
        title: "Source & destination",
        blocks: [
          {
            kind: "p",
            text: "Load a source with Browse… (native app), by dragging a video file onto the window (native app), or by typing/pasting an absolute path and pressing Enter. The stage shows the exact frame at the playhead; recently-used sources autocomplete in the path field.",
          },
          {
            kind: "p",
            text: "Destination is the folder rendered clips are written to. Use Browse to choose it; your choice is remembered between sessions.",
          },
        ],
      },
      {
        id: "inout",
        title: "Setting In and Out",
        blocks: [
          {
            kind: "p",
            text: "In and Out mark the clip's start and end. Set them three ways: drag across the loudness timeline (quickest), click Set In / Set Out at the current frame, or press I / O. The readout shows in / out / duration; keyframe and auto-track times are measured from In.",
          },
          {
            kind: "p",
            text: "Fade in / Fade out (seconds, next to the In/Out readout) fade the clip's video from/to black and its audio from/to silence — burned captions fade with the picture. A fade forces that clip's audio to re-encode as AAC 256k, since a lossless audio copy cannot fade. The Loop seam toggle shows the clip's first and last frames side by side, so you can trim to a visually clean loop (the last frame cuts straight back to the first when the clip loops).",
          },
          {
            kind: "tip",
            text: "Click an In or Out marker on the timeline to select it, then nudge it a frame at a time with ← / → (hold Shift for ±0.1s).",
          },
        ],
      },
      {
        id: "timeline",
        title: "The loudness timeline",
        blocks: [
          {
            kind: "p",
            text: "The timeline under the viewer is the app's scrubber and trimmer. It draws the source's volume over time — bars warm from grey to orange as they get louder — so your eye is drawn to the dynamic moments.",
          },
          {
            kind: "list",
            items: [
              "Click to seek; drag across the track to set In→Out; drag the region edges to adjust.",
              "Hover the track to preview the frame at that time.",
              "Suggested “swell” chips mark quiet→loud build-ups — click one to jump to just before the rise.",
              "Scene cuts show as ticks; the ⏮ / ⏭ buttons jump between them. Detection runs automatically on load; Detect scenes re-runs it.",
              "Detected audio onsets — drum hits, note attacks — show as subtle ticks along the bottom of the track. Turn on Snap and a released In/Out drag (or pressing I / O) magnetizes the point to the nearest onset within ±150 ms, so cuts land on the beat.",
            ],
          },
          {
            kind: "tip",
            text: "Swell suggestions only seek the playhead — they never set In for you. You always make the cut. Onset snap is the same: off by default, applied only at release (never mid-drag), and the ← / → nudge keys always move a point exactly where you say.",
          },
        ],
      },
      {
        id: "framing",
        title: "Framing: the 9:16 box",
        blocks: [
          {
            kind: "p",
            text: "The orange box is the 9:16 region that becomes your vertical clip. Everything outside it is dimmed; the faint vertical line marks its center.",
          },
          {
            kind: "list",
            items: [
              "Drag the box to reframe horizontally (and vertically once it is a punch-in).",
              "Drag a corner to resize it — a smaller box zooms in (see Punch-in / zoom).",
              "Double-click to reset it to full height, centered.",
            ],
          },
          {
            kind: "tip",
            text: "ffmpeg's cropdetect only sees black bars. Colored or blurred pillarbox is invisible to it — judge the framing on the actual pixels, not on metadata.",
          },
        ],
      },
      {
        id: "punchin",
        title: "Punch-in / zoom",
        blocks: [
          {
            kind: "p",
            text: "A punch-in (zoom) is a 9:16 box shorter than the full frame. Because the output is always scaled to 1080×1920, a smaller box upscales the subject — a tighter, closer crop.",
          },
          {
            kind: "steps",
            items: [
              "Grab a corner of the orange box and drag inward; it stays locked to 9:16.",
              "Drag the body to position the window over the subject.",
              "The readout shows the window size and the zoom factor (e.g. zoom 1.30×).",
            ],
          },
          {
            kind: "tip",
            text: "Zoom magnifies the source, so very large punch-ins soften the image. Stay modest unless the source is high-resolution.",
          },
        ],
      },
      {
        id: "preview",
        title: "Live 9:16 output preview",
        blocks: [
          {
            kind: "p",
            text: "The small phone-shaped panel over the stage is a live preview of the actual vertical result — cropped and scaled, updating as you frame (and following the subject when auto-track is on). Its tag shows the live zoom factor.",
          },
          {
            kind: "list",
            items: [
              "Drag it by its header to any corner so it doesn't cover what you're framing; the preview button in the top bar hides/shows it.",
              "“guides” shades the bottom caption strip and right button rail that Reels / TikTok / Shorts overlay on top of your video — so you don't frame the subject where the app chrome will cover it.",
            ],
          },
          {
            kind: "tip",
            text: "The guides are a reference only — the rendered file is always the full, clean 9:16 frame.",
          },
        ],
      },
      {
        id: "keyframes",
        title: "Moving crop (keyframes & schedule)",
        blocks: [
          {
            kind: "p",
            text: "For edited, multi-shot sources where the subject jumps between positions after each cut, build a moving-crop schedule: a set of (time → framing) switch points.",
          },
          {
            kind: "steps",
            items: [
              "Set In first — keyframe times are clip-relative.",
              "Scrub to a moment, frame it with the box, and click Add keyframe at t.",
              "Repeat at each point the framing should change. Clear keyframes empties the list.",
            ],
          },
          {
            kind: "p",
            text: "At render the schedule hard-switches the crop at each time (an instant cut, not a glide). A single keyframe at t=0 is just a static framing.",
          },
          {
            kind: "tip",
            text: "Click Detect scenes and align your switch times to the source's own cuts — the framing change then lands on a cut and is invisible.",
          },
        ],
      },
      {
        id: "autotrack",
        title: "Auto-track subject (AI)",
        blocks: [
          {
            kind: "p",
            text: "Auto-track follows a moving subject across one continuous shot and builds a smooth, eased crop path that pans to keep them in frame. It is opt-in and never required.",
          },
          {
            kind: "list",
            items: [
              "Set In/Out around a single shot (no hard cuts inside).",
              'Enter a subject hint, e.g. "the person playing guitar".',
              "Set your Gemini API key in Settings (bring your own key).",
              "Click Auto-track, review the eased path, then Add clip. Clear track reverts to manual framing.",
            ],
          },
          {
            kind: "tip",
            text: "Auto-track is a suggestion to review, not a guarantee. It glides (unlike keyframes, which hard-switch) and is meant for within-shot motion, not cuts.",
          },
        ],
      },
      {
        id: "assistant",
        title: "AI assistant (chat)",
        blocks: [
          {
            kind: "p",
            text: "The AI assistant is a chat dock: describe a moment or a subject in plain language and it proposes the cut and framing — set In/Out, suggest a crop, track a subject, detect scene cuts. It is opt-in and bring-your-own-key; the rest of Footlight works fully without it.",
          },
          {
            kind: "p",
            text: "The assistant only ever PROPOSES. Each suggestion previews on the canvas and timeline as a ghost, and nothing changes until you Accept it — or Step through proposals one at a time, or Discard them. Even \"render\" only stages the queue; the assistant never encodes for you.",
          },
          {
            kind: "list",
            items: [
              "What it sees: your project state — In/Out, detected scene cuts, and loudness swells.",
              "Plus a sparse strip of stills sampled across your In/Out (or the whole source when none is set) — how many is the Settings → AI & models → Chat stills budget.",
              "It never hears the audio, and it cites the real signals (a swell, a scene cut, a still) behind each suggestion.",
              "Every reply shows its token usage and an estimated cost — you bring your own key, so usage is billed to you.",
            ],
          },
          {
            kind: "tip",
            text: "A proposal is a suggestion to review, not a guarantee. The stills are a sparse sample (it can miss things between them) and it cannot see colored or blurred pillarbox — verify the framing on the actual pixels. Any text inside a frame is treated as data to describe, never as an instruction to follow.",
          },
        ],
      },
      {
        id: "audio",
        title: "Audio",
        blocks: [
          {
            kind: "p",
            text: "Audio is copied losslessly by default — the source track passes through untouched, so the encode never adds a compression generation or resamples. The source is the quality ceiling; re-encode only when you need a frame-exact audio cut.",
          },
        ],
      },
      {
        id: "captions",
        title: "Captions (optional)",
        blocks: [
          {
            kind: "p",
            text: "Each clip can carry a hook (the big line) and a title (the second line) — your caption shot-list, which travels with the manifest. Either field can span several lines: press Enter for a line break, and each line is rendered at that field's size. Clips export clean by default; captions are burned into the video only when burn-in is on (Settings → Rendering → Captions, or --burn-captions on the CLI).",
          },
          {
            kind: "p",
            text: "Style is per clip, set in the editor's Captions group next to the text and the live preview: font, fill and outline colour, bold / italic / underline, a drop shadow, an opaque box, rotation, and placement on a 9-zone grid.",
          },
          {
            kind: "list",
            items: [
              "Font — choose from your installed system fonts, a custom fonts folder you set in Settings, or a one-off file path. Footlight bundles no fonts and downloads none.",
              "Position — nine zones: top / center / bottom, optionally suffixed -left / -center / -right.",
              "The preview is a guide; the burned result is the authority — and it cannot see colored or blurred pillarbox, so verify the pixels.",
            ],
          },
          {
            kind: "tip",
            text: "Keep headline text native where you can — typed into Reels / TikTok / Shorts — so it stays editable and avoids the non-native-text ranking penalty. Burn captions only when you need them in the pixels (a download, a cross-post, a platform with no text tool).",
          },
        ],
      },
      {
        id: "queue",
        title: "The clip queue",
        blocks: [
          {
            kind: "p",
            text: "Add clip → queue stages the current In/Out + framing as a card in the filmstrip along the bottom. Render encodes the whole queue at once, so you can batch many differently-framed clips from one source.",
          },
          {
            kind: "list",
            items: [
              "Click a card to re-open that clip for editing; drag cards to reorder.",
              "Duplicate a card for a second framing of the same moment; ✕ removes it.",
              "Export JSON saves the queue as a manifest you can keep or feed to the CLI (footlight render).",
              "Export cover saves the current frame — through the active framing, exactly as the render would crop it — as a 1080×1920 PNG, ready to upload as the post's cover image.",
              "Clear resets the workspace — source, queue, and framing — to start fresh; export first if you want to keep the queue.",
            ],
          },
        ],
      },
      {
        id: "render",
        title: "Rendering & output",
        blocks: [
          {
            kind: "p",
            text: "Render encodes every clip in the queue to 1080×1920 H.264 MP4 in the Destination folder. The Activity window (toolbar icon) shows the exact ffmpeg commands and output, and opens automatically on an error.",
          },
          {
            kind: "list",
            items: [
              "“Clips written to …” shows the resolved output folder after a successful render.",
              "Each successful render is saved to History, so you can re-open and tweak it later.",
            ],
          },
          {
            kind: "tip",
            text: "ffmpeg and ffprobe must be installed and on your PATH — Footlight invokes them, it does not bundle them.",
          },
        ],
      },
      {
        id: "history",
        title: "History & sessions",
        blocks: [
          {
            kind: "p",
            text: "The History button (top bar) lists past renders, newest first, grouped by day. Open re-loads that clip's source and restores its In/Out and framing so you can re-frame and re-encode — without touching your current queue. Remove or Clear all prunes the list.",
          },
          {
            kind: "p",
            text: "Footlight also autosaves your working session — source, queue, and destination — and restores it the next time you open the app. Everything is stored locally on your device; nothing is sent anywhere.",
          },
        ],
      },
      {
        id: "shortcuts",
        title: "Keyboard shortcuts",
        blocks: [
          {
            kind: "p",
            text: "Footlight is fully keyboard-drivable. Press ? at any time for the complete shortcuts overlay.",
          },
          {
            kind: "list",
            items: [
              "Space play / pause · J / K / L shuttle reverse / pause / forward (tap J or L again to speed up) · ← / → step one frame · Shift+← / → nudge ±0.1s.",
              "I / O set In / Out · Shift+I / O (or Q / W) jump to the In / Out point · S add the clip to the queue.",
              "↑ / ↓ (or [ / ]) jump to the previous / next scene cut · Home / End jump to the start / end.",
              "Alt+arrows nudge the crop box · double-click the box resets framing.",
            ],
          },
        ],
      },
      {
        id: "tips",
        title: "Tips & gotchas",
        blocks: [
          {
            kind: "list",
            items: [
              "Verify framing on the pixels, not on title/resolution/view-count metadata.",
              "Align crop switch times to scene cuts for invisible reframes.",
              "Keep punch-ins modest on low-resolution sources to avoid softening.",
              "Precedence when more than one is set: auto-track path → punch-in window → crop offset / schedule.",
              "H.264 needs even dimensions; Footlight rounds crops to even numbers for you.",
              "Content-crop (stripping letterbox/pillarbox before the 9:16 crop) lives in the CSV/JSON manifest’s content_crop field — there is no in-app control for it.",
            ],
          },
        ],
      },
    ],
  },

  settings: {
    menuLabel: "Settings",
    title: "Settings",
    nav: {
      general: "General",
      rendering: "Rendering",
      ai: "AI & models",
      shortcuts: "Shortcuts",
      about: "About",
    },
    cancel: "Cancel",
    save: "Save",
    saved: "Saved",
    close: "Close",

    general: {
      title: "General",
      subtitle: "App-wide preferences, stored locally on this device.",
      appearance: "Appearance",
      theme: "Theme",
      themeLight: "Light",
      themeDark: "Dark",
      themeSystem: "System",
      timecode: "Timecode",
      timecodeFrames: "Frames",
      defaults: "Defaults",
      destination: "Destination",
      destinationBrowse: "Browse…",
      destinationHint: "Default output folder for rendered clips. Pre-fills the editor's destination.",
      trackingInterval: "Tracking interval",
      trackingIntervalHint: "Default AI sampling cadence — wider means fewer frames, so cheaper.",
      session: "Session",
      autosave: "Autosave & restore session",
      autosaveHint: "Remember your source, queue, and destination, and restore them on next launch.",
      clearSession: "Clear saved session",
      sessionCleared: "Saved session cleared.",
    },

    rendering: {
      title: "Rendering",
      subtitle: "Defaults for every render — each maps to a footlight render flag.",
      quality: "Quality (CRF)",
      qualityNearLossless: "near-lossless",
      qualityHigh: "high (default)",
      qualityGood: "good",
      qualitySmaller: "smaller file",
      crfEndBest: "14 · near-lossless",
      crfEndSmall: "28 · smaller",
      preset: "Encoder preset",
      presetHint:
        "Slower presets pack more quality into the same size — they don't change the CRF, just encode time.",
      audio: "Audio",
      audioCopy: "Copy (lossless)",
      audioReencode: "Re-encode AAC",
      audioCopyHint:
        "The source track passes through untouched — the source is your quality ceiling.",
      audioReencodeHint: "Only for a frame-exact audio cut on a downbeat.",
      bitrate: "Bitrate",
      dryRun: "Show the ffmpeg command before rendering",
      dryRunHint: "Print the exact ffmpeg invocation so you can inspect or copy it.",
      captions: "Captions",
      burnCaptions: "Burn captions into the video",
      burnCaptionsHint:
        "Off by default — a clean export is the default. When on, each clip's caption text and style (set per clip in the editor) are drawn into the exported MP4.",
      fontsDir: "Fonts folder",
      fontsDirBrowse: "Browse…",
      fontsDirPlaceholder: "Path to a folder of .ttf/.otf fonts",
      fontsDirHint:
        "Drop your .ttf/.otf fonts here to use them in captions. They show up under “Your fonts” in each clip's caption font picker in the editor.",
    },

    ai: {
      title: "AI & models",
      subtitle: "Optional, bring-your-own-key. One multimodal model does both tracking and the assistant.",
      provider: "Provider",
      providerGemini: "Google Gemini",
      providerClaude: "Anthropic Claude",
      providerOpenai: "OpenAI",
      providerConnected: "connected",
      providerAddKey: "+ add key",
      notImplemented: "not yet implemented",
      notImplementedBody:
        "Only Google Gemini is wired today — Anthropic and OpenAI are on the roadmap.",
      apiKey: "API key",
      apiKeyPlaceholder: "Gemini API key (BYOK)",
      apiKeyShow: "Show",
      apiKeyHide: "Hide",
      apiKeyTest: "Test",
      apiKeyTesting: "Testing…",
      apiKeyValid: "Key works",
      apiKeyInvalid: "Key failed",
      apiKeyHint: "Stored in the OS keychain, never in project files.",
      model: "AI model",
      recommended: "recommended",
      costNote:
        "Tracking is the cost driver: Footlight sends sampled stills, not video, so cost scales with frames — set by your interval. A typical 20s shot at",
      costInterval: "Interval",
      chatStills: "Chat stills",
      chatStillsOff: "Off",
      chatStillsHint:
        "How many frames the assistant sees per message — sampled across your In/Out (or the whole source). More frames ground its suggestions better but cost more per message; Off sends none.",
      advanced: "Use a separate model for vision & tracking",
      advancedSub:
        "Power-user path: cheap vision for tracking, a smarter model for the assistant. Off by default.",
      assistantModel: "Assistant model",
      visionModel: "Vision & tracking model",
      overlayTitle: "Framing preferences",
      overlaySub:
        "Added on top of Footlight's framing guidance — your taste, not a replacement. e.g. “keep my face in the top third”, “this venue never letterboxes”, “prefer tighter crops on solos”. Safety guidance (verify the pixels, clean export, lossless audio) always wins on conflict.",
      overlayPlaceholder: "Optional: your personal framing preferences…",
      baseView: "Footlight's framing guidance",
      baseViewSub:
        "Read-only — the expertise applied to every assistant turn. Your preferences above compose on top of it.",
      baseViewShow: "Show",
      baseViewHide: "Hide",
    },

    shortcuts: {
      title: "Shortcuts",
      subtitle: "The keyboard-first bindings. Press ? at any time for the overlay.",
    },

    about: {
      title: "About",
      subtitle: "Version, licenses, and your local ffmpeg environment.",
      tagline: "Your stage, vertical.",
      repo: "GitHub repository",
      reportBug: "Report a bug",
      licenses: "Licenses & notices",
      environment: "Environment",
      environmentHint: "Footlight invokes ffmpeg/ffprobe from your PATH — they are not bundled.",
      thanks: "Special thanks to ",
    },
  },

  editor: {
    topbar: {
      noSource: "no source loaded",
      render: "Render",
      renderTitle: "Encode every clip in the queue to 1080×1920 H.264.",
      activityTitle: "Show render, scene-detect and auto-track output",
      historyTitle: "History — re-open a past render to tweak and re-encode",
      previewHide: "Hide the 9:16 output preview",
      previewShow: "Show the 9:16 output preview",
      assistantTitle: "AI assistant (A) — propose framing in plain language",
      themeToLight: "Switch to light theme",
      themeToDark: "Switch to dark theme",
      settingsTitle: "Settings",
      clear: "Clear",
      clearTitle: "Clear everything and start over",
    },
    stage: {
      sourceTag: "SOURCE",
      overlayTitle: "Drag to reframe · drag a corner to punch-in / zoom · double-click to reset",
      previewHeadTitle: "Drag to move · toggle the preview off in the top bar",
      guides: "guides",
      guidesTitle:
        "Show TikTok/Reels safe-area guides — the bottom caption + right button zones a platform overlays, so you don't frame the subject where it gets covered",
      heroH: "Your stage, vertical.",
      heroSub:
        "Footlight turns 16:9 performance video into frame-perfect 9:16 clips — you make every call.",
      dropTitle: "Drag a video here",
      dropTitleActive: "Drop to load",
      dropRatio: "9 : 16 out",
      pasteHint: "or paste a path",
      flowMark: "Mark",
      flowFrame: "Frame",
      flowQueue: "Queue",
      flowRender: "Render",
      guide: "New here? Read the guide →",
      frameAlt: "current frame",
    },
    transport: {
      playTitle: "Play with audio to find your In/Out by ear — Set In/Out works while playing",
      inOut: "in→out",
    },
    tabs: {
      frame: "Frame",
      track: "Track subject",
    },
    source: {
      header: "Source",
      sourcePlaceholder: "/absolute/path/to/source.mp4",
      sourceTitle: "Type or paste an absolute path and press Enter, or use Browse…",
      load: "Load",
      browse: "Browse…",
      notLoaded: "Not loaded.",
      probing: "Probing…",
      destPlaceholder: "clips",
      destTitle: "Folder where rendered clips are written.",
      dimKey: "dim",
      durKey: "dur",
      arKey: "ar",
      cropdetectPrefix: "cropdetect (black bars only): crop=",
      cropdetectNone:
        "cropdetect: no black bars detected (colored/blurred pillarbox is invisible to it — eyeball the frame).",
      enterPath: "Enter an absolute path to a source file, then click Load.",
      dropHint: "Drag-drop loads files in the desktop app — paste the absolute path above.",
    },
    clip: {
      header: "Clip",
      setIn: "Set In",
      setInTitle: "Mark the clip start at the current frame.",
      setOut: "Set Out",
      setOutTitle: "Mark the clip end at the current frame.",
      inKey: "in",
      outKey: "out",
      durKey: "dur",
      offsetKey: "offset",
      fadeInLabel: "Fade in",
      fadeInTitle:
        "Fade the clip in from black (and the audio up from silence) over this many seconds.",
      fadeOutLabel: "Fade out",
      fadeOutTitle:
        "Fade the clip out to black (and the audio down to silence) over this many seconds.",
      fadeAudioHint: "Fades re-encode this clip's audio (AAC 256k) — a lossless copy can't fade.",
      loopSeam: "Loop seam",
      loopSeamTitle:
        "Show the clip's first and last frames side by side to check how it loops (last → first).",
      loopSeamInLabel: "In frame",
      loopSeamOutLabel: "Out frame",
    },
    framing: {
      header: "Framing",
      loadASource: "crop_offset: (load a source)",
      contentOff: "content_crop: (off)",
      punchInPrefix: "punch-in: ",
      zoomMid: " · zoom ",
      resetSuffix: "× · double-click to reset",
      cropOffsetPrefix: "crop_offset: ",
      contentCropPrefix: "content_crop: ",
      modeTrack: "track",
      modePunchIn: "punch-in",
      modeSchedule: "schedule",
      defaultOffset: "center",
    },
    captions: {
      header: "Captions",
      hookPlaceholder: "hook (big line, optional)",
      hookTitle: "The big caption line burned over the clip (when burn-in is on). Enter adds a line break.",
      titlePlaceholder: "title (secondary line, optional)",
      titleTitle: "The secondary caption line, shown under the hook. Enter adds a line break.",
      posVTitle: "Vertical placement of the caption.",
      posHTitle: "Horizontal placement of the caption.",
      posTop: "Top",
      posCenter: "Center",
      posBottom: "Bottom",
      posLeft: "Left",
      posRight: "Right",
      fontTitle:
        "Caption font — your fonts (from the Settings folder), system fonts, or a custom file path.",
      fontPathPlaceholder: "/path/to/font.ttf",
      fontSystemDefault: "System default",
      fontYourFonts: "Your fonts",
      fontSystemFonts: "System fonts",
      fontCustomPath: "Custom path…",
      fill: "Fill",
      outline: "Outline",
      bold: "Bold",
      italic: "Italic",
      underline: "Underline",
      boxColor: "Box color",
      shadow: "Shadow",
      shadowTitle: "Drop shadow behind the caption",
      box: "Box",
      boxTitle: "Opaque box behind the caption",
      rotate: "Rotate",
    },
    keyframes: {
      header: "Moving crop — keyframes",
      add: "Add keyframe",
      addTitle: "Record the current time + box position as a crop switch point.",
      clear: "Clear",
      schedulePrefix: "schedule: ",
      scheduleNone: "schedule: (none)",
      scheduleNoKeyframes: "schedule: (no keyframes — uses current box offset)",
      needIn: "Set the In point before adding keyframes (keyframe times are clip-relative).",
    },
    add: {
      header: "Add to queue",
      namePlaceholder: "out_name (optional, e.g. chorus_closeup)",
      addClip: "Add clip → queue",
      addClipTitle: "Add the current In/Out + framing to the queue.",
    },
    track: {
      header: "Track subject",
      help: "Opt-in. Pans to follow a subject across one shot. Set your Gemini key in Settings.",
      subjectPlaceholder: 'subject, e.g. "the person playing guitar"',
      intervalPlaceholder: "0.75",
      intervalLabel: "interval (s)",
      autoTrack: "Auto-track",
      autoTrackTitle: "Track the subject across the In/Out shot and build an eased crop path.",
      clearTrack: "Clear track",
      clearTrackTitle: "Discard the tracked path; revert to manual framing.",
      statusNone: "track: (none — manual crop_offset in use)",
      statusLoadSource: "track: load a source first.",
      statusNeedInOut: "track: set both In and Out points first.",
      statusOutAfterIn: "track: Out must be after In.",
      statusNeedKey: "track: set a Gemini API key in Settings first.",
      statusWorkingPrefix: "track: extracting frames + querying Gemini… ",
      statusWorkingSuffix: "s — this can take a while",
      statusNoBoxes: "track: no usable boxes — using manual crop_offset.",
      statusOnPrefix: "track: ON · ",
      statusOnSuffix: " keyframe(s). Clear track to revert.",
      statusFailed: "track: failed — see Output.",
      noBoxesOutput:
        "Auto-track: the tracker returned no usable boxes for the In→Out window. Falling back to the manual crop_offset.",
      resultPrefix: "Auto-track: ",
      resultMid: " keyframe(s) from ",
      resultSuffix:
        " sample(s). The preview box now follows the subject across the shot — Add clip → queue to render with the eased crop path.",
      failedOutputPrefix: "Auto-track failed: ",
    },
    ask: {
      button: "Ask the assistant…",
      title: "Open the AI assistant to propose framing in plain language",
    },
    assistant: {
      title: "Assistant",
      sub: "Proposes cuts & framing — you accept. Never hears the audio.",
      closeTitle: "Close the assistant (Esc / A)",
      suggestions: [
        "Find a tight chorus around the loud part",
        "Track the guitarist across this shot",
        "Frame the singer at the current moment",
        "Set In/Out to the cleanest 15 seconds",
      ],
      composerPlaceholder: "Ask the assistant to find a moment or frame a subject…",
      sendTitle: "Send (Enter)",
      greeting:
        "Tell me the moment or subject you want and I'll propose the cut and framing. " +
        "I work from your project state — scene cuts and loudness swells — and look at " +
        "specific frames when I frame or track a subject. I never hear the audio, and " +
        "every proposal previews before it changes anything.",
      youLabel: "you",
      assistantLabel: "assistant",
      needSource: "Load a source first, then I can read its frames and propose framing.",
      needKey:
        "I need a Gemini API key to read frames. Add one in Settings → AI & models (it's stored in your OS keychain, never in project files), then ask me again.",
      turnFailedPrefix: "Sorry — that turn failed: ",
      grounded: "grounded in",
      proposed: "Proposed",
      actionSingular: "action",
      actionPlural: "actions",
      arrow: "→",
      acceptAll: "Accept all",
      step: "Step",
      discard: "Discard",
      appliedStagedPrefix: "Applied ",
      appliedStagedSuffix: " — render staged. Use the Render button when you're ready.",
      appliedPrefix: "Applied ",
      appliedSuffixSingular: " proposal.",
      appliedSuffixPlural: " proposals.",
      steppedThrough: "Stepped through every proposal.",
      discarded: "Discarded — your state is untouched.",
      renderStaged:
        "Assistant staged the queue for render. Press Render when you're ready — I never encode automatically.",
      trackFromAssistantPrefix: "track: ON · ",
      trackFromAssistantSuffix: " keyframe(s) (from the assistant). Clear track to revert.",
      usageTokens: "tokens",
      usageInLabel: "in",
      usageOutLabel: "out",
      usageEstNote: "estimated cost (tokens × list rate); actual billing may differ",
    },
    timeline: {
      prevCutTitle: "Jump to previous cut",
      nextCutTitle: "Jump to next cut",
      suggested: "suggested",
      cutsLabel: "cuts",
      swellsLabel: "swells",
      detectScenes: "Detect scenes",
      detectScenesTitle: "Detect scene cuts — align keyframe switch times to these.",
      snapLabel: "Snap",
      snapTitle:
        "Snap In/Out to the beat: when on, releasing a drag or pressing I/O pulls the point to the nearest detected audio onset (±150 ms). Off by default — your points stay exactly where you put them.",
      seekSwellPrefix: "Seek to just before this swell (",
      seekSwellSuffix: ")",
    },
    queue: {
      queueLabel: "Queue",
      addClip: "+ add clip",
      exportJson: "Export JSON",
      exportJsonTitle: "Save the queue as a JSON manifest (re-imports via footlight render)",
      exportCover: "Export cover",
      exportCoverTitle:
        "Save the current frame, through the active framing, as a 1080×1920 PNG cover image.",
      renderN: "Render",
      cardEditTitle: "Click to re-open this clip for editing · drag to reorder",
      duplicateTitle: "Duplicate (e.g. a second framing of this moment)",
      removeTitle: "Remove from queue",
    },
    activity: {
      title: "Activity",
      copy: "⧉ Copy",
      copyTitle: "Copy the output to the clipboard",
      closeTitle: "Hide the activity window",
      placeholder: "(output appears here)",
      rendering: "Rendering… (this runs ffmpeg per clip; may take a while)",
      okNoOutput: "OK (no output)",
      renderFailed: "Render failed.",
      cantWritePrefix: "Can't write to ",
      cantWriteFallbackReason: "pick another folder",
      clipsWrittenTo: "Clips written to ",
      detectingScenes: "Detecting scenes…",
      sceneCutsPrefix: "Scene cuts (s): ",
      sceneCutsSuffix:
        "  (auto-track will force a fresh sample just after each cut inside the In/Out range)",
      noScenes: "No scene cuts detected (threshold 0.4).",
      stagedForRender:
        "Assistant staged the queue for render. Press Render when you're ready — I never encode automatically.",
      coverExported: "Cover image saved.",
      copied: "✓ Copied",
      copyFailed: "Copy failed",
      copyIdle: "⧉ Copy",
    },
    history: {
      ariaLabel: "Render history",
      title: "Render history",
      clearAll: "Clear all",
      filterPlaceholder: "Filter by source or clip name…",
      storedLabel: "stored",
      storedValue: "local",
      emptyHint: "No renders yet — render a clip and it lands here.",
      footHtmlBody:
        "<span><b>Open</b> loads the source and re-frames the editor to that render. " +
        "Your current queue isn’t touched.</span>",
      open: "Open",
      removeTitle: "Remove from history",
      noMatches: "No matches.",
      renderSingular: "render",
      renderPlural: "renders",
      today: "Today",
      yesterday: "Yesterday",
      modeTrack: "track",
      modePunchIn: "punch-in",
      modeKeyframes: "keyframes",
    },
    errors: {
      loadSourceFirst: "Load a source first.",
      setInOut: "Set both In and Out points.",
      outAfterIn: "Out must be after In.",
      addAtLeastOne: "Add at least one clip to the queue.",
      previewPlayerFailed: "the preview player could not load this source",
      fadesTooLong: "Fades are longer than the clip — shorten them or widen In/Out.",
    },
    common: {
      close: "Close",
      dash: "—",
    },
    clear: {
      title: "Clear everything?",
      body: "This discards the loaded source, the entire queue, and your framing, and starts fresh. Export the queue first if you want to keep it.",
      cancel: "Cancel",
      confirm: "Clear everything",
    },
  },

  shortcuts: {
    modalTitle: "Keyboard shortcuts",
    close: "Close",
    groups: [
      {
        title: "Playback",
        items: [
          { keys: ["Space"], desc: "Play / pause" },
          { keys: ["J"], desc: "Shuttle backward (press again to speed up)" },
          { keys: ["K"], desc: "Pause" },
          { keys: ["L"], desc: "Shuttle forward (press again to speed up)" },
          { keys: ["←", "→"], desc: "Step 1 frame back / forward" },
          { keys: ["Shift", "←"], desc: "Nudge time −0.1s" },
          { keys: ["Shift", "→"], desc: "Nudge time +0.1s" },
        ],
      },
      {
        title: "Marking",
        items: [
          { keys: ["I"], desc: "Set In at the playhead" },
          { keys: ["O"], desc: "Set Out at the playhead" },
          { keys: ["Shift", "I"], desc: "Go to the In point (also Q)" },
          { keys: ["Shift", "O"], desc: "Go to the Out point (also W)" },
          { keys: ["S"], desc: "Add the current clip to the queue" },
        ],
      },
      {
        title: "Navigation",
        items: [
          { keys: ["["], desc: "Previous scene cut (also ↑)" },
          { keys: ["]"], desc: "Next scene cut (also ↓)" },
          { keys: ["Home"], desc: "Jump to the start" },
          { keys: ["End"], desc: "Jump to the end" },
        ],
      },
      {
        title: "Framing",
        items: [
          { keys: ["Alt", "←"], desc: "Nudge the crop left" },
          { keys: ["Alt", "→"], desc: "Nudge the crop right" },
          { keys: ["Alt", "↑"], desc: "Nudge the crop up (punch-in)" },
          { keys: ["Alt", "↓"], desc: "Nudge the crop down (punch-in)" },
          { keys: ["Double-click"], desc: "Reset framing to full-height 9:16" },
        ],
      },
      {
        title: "Help",
        items: [
          { keys: ["?"], desc: "Show this shortcuts overlay" },
          { keys: ["Esc"], desc: "Close any dialog" },
        ],
      },
    ],
  },
};
