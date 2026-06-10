// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Localizable message shapes. All user-facing guide content is structured data
 * (not hardcoded HTML) so a new locale is just another `Messages` object — see
 * `en.ts` for the English catalog and `index.ts` for locale selection.
 */

/** One block of guide prose. */
export type GuideBlock =
  | { kind: "p"; text: string }
  | { kind: "steps"; items: string[] } // ordered how-to
  | { kind: "list"; items: string[] } // unordered bullets
  | { kind: "tip"; text: string }; // highlighted tip/gotcha

/** A titled section of the user guide. `id` anchors the table-of-contents link. */
export interface GuideSection {
  id: string;
  title: string;
  blocks: GuideBlock[];
}

/** Strings + content for the Help → User Guide dialog. */
export interface HelpMessages {
  menuLabel: string;
  /** In-app Help dropdown: trigger + the items beside the guide. */
  menuTrigger: string;
  about: string;
  reportBug: string;
  viewOnGithub: string;
  title: string;
  subtitle: string;
  tocLabel: string;
  close: string;
  sections: GuideSection[];
}

/** Strings for the Settings dialog — a 5-panel left-nav modal. */
export interface SettingsMessages {
  menuLabel: string;
  title: string;
  /** Left-nav item labels. */
  nav: {
    general: string;
    rendering: string;
    ai: string;
    shortcuts: string;
    about: string;
  };
  /** Shared footer actions. */
  cancel: string;
  save: string;
  saved: string;
  close: string;

  general: {
    title: string;
    subtitle: string;
    appearance: string;
    theme: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    timecode: string;
    timecodeFrames: string;
    defaults: string;
    destination: string;
    destinationBrowse: string;
    destinationHint: string;
    trackingInterval: string;
    trackingIntervalHint: string;
    session: string;
    autosave: string;
    autosaveHint: string;
    clearSession: string;
    sessionCleared: string;
  };

  rendering: {
    title: string;
    subtitle: string;
    quality: string;
    qualityNearLossless: string;
    qualityHigh: string;
    qualityGood: string;
    qualitySmaller: string;
    /** The CRF slider's low/high end captions. */
    crfEndBest: string;
    crfEndSmall: string;
    preset: string;
    presetHint: string;
    audio: string;
    audioCopy: string;
    audioReencode: string;
    audioCopyHint: string;
    audioReencodeHint: string;
    bitrate: string;
    dryRun: string;
    dryRunHint: string;
    captions: string;
    burnCaptions: string;
    burnCaptionsHint: string;
    fontsDir: string;
    fontsDirBrowse: string;
    fontsDirPlaceholder: string;
    fontsDirHint: string;
  };

  ai: {
    title: string;
    subtitle: string;
    provider: string;
    providerGemini: string;
    providerClaude: string;
    providerOpenai: string;
    providerConnected: string;
    providerAddKey: string;
    notImplemented: string;
    notImplementedBody: string;
    apiKey: string;
    apiKeyPlaceholder: string;
    apiKeyShow: string;
    apiKeyHide: string;
    apiKeyTest: string;
    apiKeyTesting: string;
    apiKeyValid: string;
    apiKeyInvalid: string;
    apiKeyHint: string;
    model: string;
    recommended: string;
    costNote: string;
    costInterval: string;
    /** Chat-stills budget (#40): label, the "off" option, and the hint. */
    chatStills: string;
    chatStillsOff: string;
    chatStillsHint: string;
    advanced: string;
    advancedSub: string;
    assistantModel: string;
    visionModel: string;
    overlayTitle: string;
    overlaySub: string;
    overlayPlaceholder: string;
    baseView: string;
    baseViewSub: string;
    baseViewShow: string;
    baseViewHide: string;
  };

  shortcuts: {
    title: string;
    subtitle: string;
  };

  about: {
    title: string;
    subtitle: string;
    tagline: string;
    repo: string;
    reportBug: string;
    licenses: string;
    environment: string;
    environmentHint: string;
    /** Prefix for the credit line; the linked name ("Lincoln Durham") is appended. */
    thanks: string;
  };
}

/** Strings for the single-clip cutter editor (the app's main surface). */
export interface EditorMessages {
  /** Top bar: breadcrumb + the icon-button tooltips. */
  topbar: {
    noSource: string;
    render: string;
    renderTitle: string;
    activityTitle: string;
    historyTitle: string;
    previewHide: string;
    previewShow: string;
    assistantTitle: string;
    themeToLight: string;
    themeToDark: string;
    settingsTitle: string;
    clear: string;
    clearTitle: string;
  };
  /** The stage (frame viewer): empty-state hero, tags and tooltips. */
  stage: {
    sourceTag: string;
    overlayTitle: string;
    previewHeadTitle: string;
    guides: string;
    guidesTitle: string;
    heroH: string;
    heroSub: string;
    dropTitle: string;
    dropTitleActive: string;
    dropRatio: string;
    pasteHint: string;
    flowMark: string;
    flowFrame: string;
    flowQueue: string;
    flowRender: string;
    guide: string;
    frameAlt: string;
  };
  /** Transport: the play button and the in→out chip. */
  transport: {
    playTitle: string;
    inOut: string;
  };
  /** Inspector tab labels. */
  tabs: {
    frame: string;
    track: string;
  };
  /** Source & destination section. */
  source: {
    header: string;
    sourcePlaceholder: string;
    sourceTitle: string;
    load: string;
    browse: string;
    notLoaded: string;
    probing: string;
    destPlaceholder: string;
    destTitle: string;
    dimKey: string;
    durKey: string;
    arKey: string;
    cropdetectPrefix: string;
    cropdetectNone: string;
    enterPath: string;
    dropHint: string;
  };
  /** Clip In/Out section. */
  clip: {
    header: string;
    setIn: string;
    setInTitle: string;
    setOut: string;
    setOutTitle: string;
    inKey: string;
    outKey: string;
    durKey: string;
    offsetKey: string;
    /** Per-clip fade controls (issue #165). */
    fadeInLabel: string;
    fadeInTitle: string;
    fadeOutLabel: string;
    fadeOutTitle: string;
    /** Shown when any fade is set: fades force an AAC audio re-encode. */
    fadeAudioHint: string;
    /** Loop-seam check: toggle label/tooltip + the two frame captions. */
    loopSeam: string;
    loopSeamTitle: string;
    loopSeamInLabel: string;
    loopSeamOutLabel: string;
  };
  /** Framing section + crop readouts. */
  framing: {
    header: string;
    loadASource: string;
    contentOff: string;
    /** `punch-in: WxH @ (x,y) · zoom Z× · double-click to reset` — composed in code. */
    punchInPrefix: string;
    zoomMid: string;
    resetSuffix: string;
    cropOffsetPrefix: string;
    contentCropPrefix: string;
    /** Framing-mode labels in the clip "offset" readout. */
    modeTrack: string;
    modePunchIn: string;
    modeSchedule: string;
    defaultOffset: string;
  };
  /** Captions section. */
  captions: {
    header: string;
    hookPlaceholder: string;
    hookTitle: string;
    titlePlaceholder: string;
    titleTitle: string;
    posVTitle: string;
    posHTitle: string;
    posTop: string;
    posCenter: string;
    posBottom: string;
    posLeft: string;
    posRight: string;
    fontTitle: string;
    fontPathPlaceholder: string;
    fontSystemDefault: string;
    fontYourFonts: string;
    fontSystemFonts: string;
    fontCustomPath: string;
    fill: string;
    outline: string;
    bold: string;
    italic: string;
    underline: string;
    boxColor: string;
    shadow: string;
    shadowTitle: string;
    box: string;
    boxTitle: string;
    rotate: string;
  };
  /** Moving-crop keyframes section. */
  keyframes: {
    header: string;
    add: string;
    addTitle: string;
    clear: string;
    schedulePrefix: string;
    scheduleNone: string;
    scheduleNoKeyframes: string;
    needIn: string;
  };
  /** Add-to-queue section. */
  add: {
    header: string;
    namePlaceholder: string;
    addClip: string;
    addClipTitle: string;
  };
  /** Track-subject (auto-track) tab. */
  track: {
    header: string;
    help: string;
    subjectPlaceholder: string;
    intervalPlaceholder: string;
    intervalLabel: string;
    autoTrack: string;
    autoTrackTitle: string;
    clearTrack: string;
    clearTrackTitle: string;
    statusNone: string;
    statusLoadSource: string;
    statusNeedInOut: string;
    statusOutAfterIn: string;
    statusNeedKey: string;
    /** `track: extracting frames + querying Gemini… {n}s — this can take a while` */
    statusWorkingPrefix: string;
    statusWorkingSuffix: string;
    statusNoBoxes: string;
    /** `track: ON · {n} keyframe(s). Clear track to revert.` — composed in code. */
    statusOnPrefix: string;
    statusOnSuffix: string;
    statusFailed: string;
    noBoxesOutput: string;
    /** `Auto-track: {n} keyframe(s) from {m} sample(s). …` — composed in code. */
    resultPrefix: string;
    resultMid: string;
    resultSuffix: string;
    failedOutputPrefix: string;
  };
  /** Inspector-base "Ask the assistant" button. */
  ask: {
    button: string;
    title: string;
  };
  /** AI assistant dock. */
  assistant: {
    title: string;
    sub: string;
    closeTitle: string;
    suggestions: string[];
    composerPlaceholder: string;
    sendTitle: string;
    greeting: string;
    youLabel: string;
    assistantLabel: string;
    needSource: string;
    needKey: string;
    turnFailedPrefix: string;
    grounded: string;
    proposed: string;
    /** `{n} action` / `{n} actions` — composed in code. */
    actionSingular: string;
    actionPlural: string;
    arrow: string;
    acceptAll: string;
    step: string;
    discard: string;
    /** Accept / step / discard completion notes. */
    appliedStagedPrefix: string;
    appliedStagedSuffix: string;
    appliedPrefix: string;
    appliedSuffixSingular: string;
    appliedSuffixPlural: string;
    steppedThrough: string;
    discarded: string;
    renderStaged: string;
    trackFromAssistantPrefix: string;
    trackFromAssistantSuffix: string;
    /** Per-turn usage/cost footer: unit word, in/out labels, and the estimate caveat. */
    usageTokens: string;
    usageInLabel: string;
    usageOutLabel: string;
    usageEstNote: string;
  };
  /** Timeline (loudness track). */
  timeline: {
    prevCutTitle: string;
    nextCutTitle: string;
    suggested: string;
    cutsLabel: string;
    swellsLabel: string;
    detectScenes: string;
    detectScenesTitle: string;
    /** `Seek to just before this swell ({clock})` — composed in code. */
    seekSwellPrefix: string;
    seekSwellSuffix: string;
  };
  /** Filmstrip queue + cards. */
  queue: {
    queueLabel: string;
    addClip: string;
    exportJson: string;
    exportJsonTitle: string;
    /** `Render {n}` — composed in code. */
    renderN: string;
    cardEditTitle: string;
    duplicateTitle: string;
    removeTitle: string;
  };
  /** Activity / Output panel. */
  activity: {
    title: string;
    copy: string;
    copyTitle: string;
    closeTitle: string;
    placeholder: string;
    rendering: string;
    okNoOutput: string;
    renderFailed: string;
    /** `Can't write to {path} — {reason}.` — composed in code. */
    cantWritePrefix: string;
    cantWriteFallbackReason: string;
    clipsWrittenTo: string;
    detectingScenes: string;
    /** `Scene cuts (s): {list}  (…)` — composed in code. */
    sceneCutsPrefix: string;
    sceneCutsSuffix: string;
    noScenes: string;
    stagedForRender: string;
    copied: string;
    copyFailed: string;
    copyIdle: string;
  };
  /** History modal. */
  history: {
    ariaLabel: string;
    title: string;
    clearAll: string;
    filterPlaceholder: string;
    storedLabel: string;
    storedValue: string;
    emptyHint: string;
    footHtmlBody: string;
    open: string;
    removeTitle: string;
    noMatches: string;
    /** `{n} render` / `{n} renders` — composed in code. */
    renderSingular: string;
    renderPlural: string;
    today: string;
    yesterday: string;
    modeTrack: string;
    modePunchIn: string;
    modeKeyframes: string;
  };
  /** Add-clip / render validation errors (inline or in Output). */
  errors: {
    loadSourceFirst: string;
    setInOut: string;
    outAfterIn: string;
    addAtLeastOne: string;
    previewPlayerFailed: string;
    /** The fades don't fit: fade_in + fade_out exceed the clip duration. */
    fadesTooLong: string;
  };
  /** Shared, reused short labels. */
  common: {
    close: string;
    dash: string;
  };
  /** "Clear everything" confirm dialog. */
  clear: {
    title: string;
    body: string;
    cancel: string;
    confirm: string;
  };
}

/** One key binding in the shortcuts reference: physical keys + what it does. */
export interface ShortcutBinding {
  /** Physical keys (NOT localized) — each rendered as its own `<kbd>`, joined by "+". */
  keys: string[];
  desc: string;
}

/** A titled group of key bindings. */
export interface ShortcutGroup {
  title: string;
  items: ShortcutBinding[];
}

/**
 * Strings for the keyboard-shortcuts reference. Single source of truth shared by
 * the Help overlay (`shortcuts.ts`) and the Settings → Shortcuts panel.
 */
export interface ShortcutsMessages {
  modalTitle: string;
  close: string;
  groups: ShortcutGroup[];
}

/** The full message catalog for one locale. */
export interface Messages {
  help: HelpMessages;
  settings: SettingsMessages;
  editor: EditorMessages;
  shortcuts: ShortcutsMessages;
}
