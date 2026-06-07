// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** English (en) message catalog. The reference locale; copy this to add another. */

import type { Messages } from "./types.js";

export const en: Messages = {
  help: {
    menuLabel: "User Guide",
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
            ],
          },
          {
            kind: "tip",
            text: "Swell suggestions only seek the playhead — they never set In for you. You always make the cut.",
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
              "Copy JSON copies the queue as a manifest you can save or feed to the CLI.",
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
              "Space play / pause · ← / → step one frame · Shift+← / → nudge ±0.1s.",
              "I / O set In / Out · S add the clip to the queue · [ / ] jump to the previous / next cut.",
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
      gapNote:
        "These render defaults are persisted; threading them through to the render call is a follow-up.",
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
};
