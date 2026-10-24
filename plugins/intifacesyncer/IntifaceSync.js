/**
 * IntifaceSync – Stash UI Plugin
 * Supports: Intiface Central + The Handy WiFi (HSSP)
 */

(function () {
  "use strict";
  if (window.__IntifaceSyncLoaded) return;
  window.__IntifaceSyncLoaded = true;

  const BACKEND_HOST    = window.location.hostname;
  const BACKEND_URL     = `ws://${BACKEND_HOST}:7880`;
  const PLUGIN_ID       = "IntifaceSync";
  const PLUGIN_VERSION  = "1.51-vibe";   // must match the backend; see updateToolbarStatus
  const DATA_KEYS       = ["patternPresets", "scriptSettings", "performerPatterns"];   // in Suite Data's store when it is installed
  const MIN_STROKE_GAP  = 5;
  const LS_KEY          = "IntifaceSync.settings";

  // ── Per-browser preferences (1.38) ─────────────────────────────────────────
  // off:  "Not using it". The bar is a small pill under the player, no socket
  //       is opened, no backend task is started and no Intiface connect is
  //       tried, in every tab of this browser, until it is turned back on.
  //       Turning it off goes through the stop path first (goOff). Nothing
  //       the toy's safety depends on lives here: the backend's deadman and
  //       its disconnect panic do not read it.
  // heat: the 1.38-1.45 heat strip's switch; the strip is gone (1.46, the
  //       user skips around and it did not help), the value rides through.
  // fold: 1.46, the deck folds back to the pill 4 s after the last change
  //       while the video plays. Off unless turned on (the user's choice).
  // pauseQuiet: 1.49, silent while the scene's video is paused (or ended, or
  //       buffering for long), in every mode; on unless turned off. A
  //       convenience, not a safety path: Stop, mute, the deadman and the
  //       disconnect panic do not read it.
  const PREFS_KEY = `IntifaceSyncPrefs`;
  function readPrefs(raw) {
    let o = null;
    try { o = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) {}
    if (!o || typeof o !== "object") o = {};
    return { ...o, off: o.off === true, heat: o.heat !== false, fold: o.fold === true, pauseQuiet: o.pauseQuiet !== false };
  }
  let prefs = readPrefs((() => { try { return localStorage.getItem(PREFS_KEY); } catch (_) { return null; } })());
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
  }
  let pluginOff = prefs.off;

  // What turning it off has to do, given what this tab knows. The driving
  // tab sends "stop" (the backend's stop path, _panic()), and so does a tab
  // when nobody drives (nothing to lose, and it clears a stale manual flag).
  // A spectator does not: the driver may be another browser the user is
  // still using; this browser's own driver tab hears the same switch through
  // the storage event and stops. Every tab then closes its socket, and the
  // backend panics when the driver's socket goes (_client_gone).
  function offPlan(s) {
    const canSend = !!(s && s.wsReady);
    return {
      sendStop:    canSend && !!(s.isOwner || s.legacy || !s.driver),
      closeSocket: true,
    };
  }

  // Intiface Central not running answered every connect with "Failed to
  // connect", and every tab that became the driver tried again: two tabs
  // handing the device back and forth filled the console. After a failed
  // connect the automatic one waits NOSERVER_RETRY_MS, shared across tabs;
  // the Retry action always tries at once.
  const NOSERVER_LS_KEY   = "intifaceSyncNoServerAt";
  const NOSERVER_RETRY_MS = 60000;
  function noServerAt() {
    try { return parseInt(localStorage.getItem(NOSERVER_LS_KEY) || "0", 10) || 0; }
    catch (_) { return 0; }
  }
  function noteNoServer(t) {
    try { localStorage.setItem(NOSERVER_LS_KEY, String(t)); } catch (_) {}
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let ws                    = null;
  let wsReady               = false;
  let currentScenePath      = null;
  let sceneReadError        = null;    // why the last scene lookup failed, for the status line
  let funscripts            = [];
  let selectedFunscript     = null;
  let funscriptLoaded       = false;
  let pendingPlay           = null;
  let statusData            = { connected: false, playing: false, devices: [], mode: "intiface" };
  let offsetMs              = 0;
  let strokeMin             = 0;
  let strokeMax             = 100;
  let mode                  = "intiface";   // "intiface" | "handy_wifi"
  let handyKey              = "";
  let videoEl               = null;
  let toolbarInjected       = false;
  let reconnectTimer        = null;
  let reconnectDelay        = 3000;
  let intifaceReady         = false;
  let connectingToIntiface  = false;
  let pendingFindFunscripts = null;
  let statusPollInterval    = null;
  let backendEverConnected  = false;
  let backendStartInFlight  = false;
  let backendStartCooldown  = 0;
  let pendingIntifaceConnect = false;   // Connect was pressed before the backend was up
  let toolbarEl              = null;   // set early in buildToolbar, before mounting
  let autoStartCount         = 0;     // auto-start attempts this page session
  let backendStartGaveUp     = false; // stop nagging Stash once the cap is hit

  // The cooldown lives in localStorage so several open tabs share one budget
  // instead of each queueing its own Start Backend task.
  const START_LS_KEY   = "intifaceSyncLastBackendStart";
  const START_COOLDOWN = 60000;       // ms between task submissions, any tab
  const MAX_AUTO_STARTS = 3;          // then stop and tell the user

  function lastStartAt() {
    try { return parseInt(localStorage.getItem(START_LS_KEY) || "0", 10) || 0; }
    catch { return 0; }
  }
  function noteStartAt(t) {
    try { localStorage.setItem(START_LS_KEY, String(t)); } catch (_) {}
  }

  // ── Which tab drives the device ────────────────────────────────────────────
  // The backend is one global player, so one tab drives it at a time. Up to
  // 1.24 the tabs agreed among themselves through a localStorage lock, which
  // each browser keeps separately: two browsers (PC and phone) both drove. Now
  // every tab connects and the backend picks the driver (see _route() in the
  // Python). This tab only asks: "claim" when it wants the device, "presence"
  // so the backend and other tabs know what it is showing.
  const TAB_ID       = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let   backendStatusSeen = false;   // a real status arrived (the version check needs one)
  let   isOwner      = false;     // this tab is the driver, per the last status
  let   initDone     = false;
  let   driverInfo   = null;      // {tab, scene, title, playing} or null
  let   legacyBackend = false;    // backend older than 1.25: no arbitration
  let   currentSceneId    = null;
  let   currentSceneTitle = "";
  // From the same scene read (1.38): who is in it (favourite patterns), its
  // studio (the no-funscript list), and Stash's own funscript for the heat
  // strip when Stash flags the scene interactive.
  let   currentScenePerformers = [];
  let   currentSceneStudio     = null;
  let   currentSceneFunscript  = null;   // Stash's /scene/<id>/funscript, or null
  let   currentSceneDurationMs = 0;

  function videoIsPlaying() {
    return !!(videoEl && !videoEl.paused && !videoEl.ended);
  }

  // ── Silent while the video is paused (1.49) ──
  // The user: "no buzzing while the video is paused, even if Manual is on or
  // Goon mode". While the scene's player is paused, ended or buffering for
  // longer than PAUSE_BUFFER_MS, every manual message carries a ceiling of 0
  // (silence since 1.44, the same 0 Goon's pauses use; Manual stays on, the
  // heartbeat and the deadman run); the script is silent paused anyway. Goon
  // holds its clock as it does muted. On play the real ceiling goes out
  // again. A hold, not a stop path: Stop, halt, mute, Disconnect, the
  // deadman and the driving tab leaving are untouched and work while held.
  // Only the scene's own player counts (videoEl, cleared off the scene
  // pages): with no player on the page (Manual on /performers, Goon carried
  // across pages by 1.48) nothing is held, as before 1.49.
  const PAUSE_BUFFER_MS = 2000;
  let pauseHold      = false;      // held silent now
  let bufferingSince = 0;          // a "waiting" with no "playing" since
  let bufferTimer    = null;
  let pauseToastShown = false;
  let pauseZeroSent  = false;      // the held 0 went out with Manual on (sendManual keeps it)
  // Pure, tested. o: { on (the setting), has (a player on the page), paused,
  // ended, waitingMs, can (the backend plays a 0 ceiling as silence) }
  function pauseHoldDue(o) {
    return !!(o && o.on && o.has && o.can && (o.paused || o.ended || (o.waitingMs || 0) >= PAUSE_BUFFER_MS));
  }
  function pauseHoldNow() {
    const v = videoEl && videoEl.isConnected !== false ? videoEl : null;
    return pauseHoldDue({ on: prefs.pauseQuiet, has: !!v, paused: !!(v && v.paused), ended: !!(v && v.ended),
                          waitingMs: bufferingSince ? Date.now() - bufferingSince : 0,
                          can: !backendStatusSeen || backendAtLeast("1.44") });
  }
  // Called on every play / pause / ended / waiting / playing / emptied, on a
  // route change, when the setting changes, on the heartbeat, every Goon
  // tick and when a status turns Manual on. Sends on a change, or while held
  // when the 0 has not gone out with Manual on yet (a page that loaded with
  // the video paused and heard only later that Manual runs: found in the
  // harness, the toy would have played on).
  function refreshPauseHold() {
    const h = pauseHoldNow();
    const changed = h !== pauseHold;
    pauseHold = h;
    if (!changed && !(h && manualOn && !pauseZeroSent)) return;
    if (changed) {
      log(`Pause hold ${h ? "on: silent until play" : "off"}`, "debug");
      if (goonOn) goonLastTick = Date.now();     // the held time does not count
    }
    if (manualOn) {
      // Goon: its own pattern and level (it may have started while held)
      if (goonOn && goonSt) goonSend(goonLim(), Date.now());
      sendManual();
      if (h && !pauseToastShown && !deckIsOpen()) {
        pauseToastShown = true;
        toast("Paused: the toy is silent until you press play (settings: Silent while the video is paused).");
      }
    }
    updateGoonUI();
  }

  function presence() {
    return { tab: TAB_ID, scene: currentSceneId, title: currentSceneTitle,
             playing: videoIsPlaying(), visible: document.visibilityState === "visible" };
  }
  function sendPresence() { sendMsg({ type: "presence", ...presence() }); }

  // Pressing play or the Take over button forces it; anything softer (tab
  // became visible, toolbar clicked) only wins when the driver is not playing.
  function tryTakeover(reason) {
    if (isOwner || !initDone || !wsReady) return;
    const force = reason === "play" || reason === "button";
    // A tab opened in the background (middle-click) must not take the device
    // from one that is merely paused; it only takes a device nobody drives.
    const ifFree = reason === "open" && document.visibilityState !== "visible";
    log(`Asking to drive the device (${reason}${force ? ", forced" : ""})`, "debug");
    sendMsg({ type: "claim", force, ifFree, reason });
  }

  // Called with every status. The backend is the only authority.
  function applyDriver(msg) {
    if (!("driver" in msg)) {
      // Old backend still running after a plugin update: it cannot arbitrate,
      // so behave like a single tab and say how to fix it.
      if (!legacyBackend) log("Backend is older than this page; run Stop Backend and Start Backend", "error");
      legacyBackend = true;
      if (!isOwner) { isOwner = true; becomeOwner(); }
      return;
    }
    legacyBackend = false;
    driverInfo = msg.driver;
    const mine = !!driverInfo && driverInfo.tab === TAB_ID;
    if (mine && !isOwner) {
      isOwner = true;
      log("This tab now drives the device");
      becomeOwner();
    } else if (!mine && isOwner) {
      isOwner = false;
      intifaceReady = false;
      pendingPlay = null;
      log("Another tab took the device", "warn");
    }
  }

  // Fresh driver: the backend dropped the previous tab's script, so send this
  // tab's settings, script and play state.
  function becomeOwner() {
    intifaceReady   = false;
    funscriptLoaded = false;
    loadAsked       = null;        // the backend dropped the last driver's script: load again
    sendMsg({ type: "setMode", mode });
    sendSettings();
    sendOutput();
    connectingToIntiface = false;
    autoConnectIntiface();
    if (selectedFunscript) loadFunscript(selectedFunscript);
    else if (currentScenePath) askFunscripts(currentScenePath);
    if (videoIsPlaying() && !haltHeld) pendingPlay = { time: videoEl.currentTime * 1000, rate: videoEl.playbackRate };
    if (dockOpen && previewWanted) setPreview(true);
    setTimeout(autoManualCheck, 300);       // after the status has told us manual's state
    updateToolbarStatus();
  }

  document.addEventListener("visibilitychange", () => {
    sendPresence();
    if (document.visibilityState === "visible") tryTakeover("visible");
  });
  window.addEventListener("focus", () => tryTakeover("focus"));
  window.addEventListener("pagehide", () => {
    if (previewOn) { previewOn = false; previewSamples = []; }
  });

  // Heartbeat timer that survives background-tab throttling. Chrome slows
  // timers in hidden tabs to once a minute after five minutes, and a muted
  // video counts as silent, so a driver playing in the background could miss
  // the 15 s deadman and stop mid-scene. Worker timers are not throttled that
  // way. Falls back to setInterval if workers are blocked.
  function startTicker(ms, fn) {
    try {
      const src = `setInterval(() => postMessage(0), ${ms});`;
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const w = new Worker(url);
      URL.revokeObjectURL(url);
      w.onmessage = fn;
      return { stop: () => w.terminate() };
    } catch (_) {
      const id = setInterval(fn, ms);
      return { stop: () => clearInterval(id) };
    }
  }

  // 1.46: the deck and the two sheets are built once and may be detached
  // (the deck between scenes, a sheet while closed), so they are searched too.
  let deckEl = null;
  function byId(id) {
    const d = document.getElementById(id);
    if (d) return d;
    const sel = `#${CSS.escape(id)}`;
    let roots = [toolbarEl, deckEl];
    try { roots = roots.concat([manualPop, settingsPop, scriptPop]); } catch (_) { /* not declared yet during startup */ }
    for (const r of roots) {
      if (!r) continue;
      if (r.id === id) return r;
      const f = r.querySelector(sel);
      if (f) return f;
    }
    return null;
  }

  // Line icons on the 16 grid, stroke 1.6, currentColor, like Todo and
  // Lockdown (suite conventions). They replace the text glyphs (power, gear,
  // play, stop, warning, note, caret) the toolbar used as icons, which
  // rendered at a different size and weight in every font and OS.
  const ICON_PATHS = {
    power:   '<path d="M8 2.2v5.3"/><path d="M4.7 4.4a5 5 0 1 0 6.6 0"/>',
    gear:    '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/><circle cx="8" cy="8" r="4.5"/>',
    play:    '<path d="M5 3.3v9.4L12.5 8z"/>',
    stop:    '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
    dot:     '<circle cx="8" cy="8" r="3" fill="currentColor"/>',
    warn:    '<path d="M8 2.3l6.2 11H1.8z"/><path d="M8 6.6v3"/><path d="M8 11.6v.1"/>',
    blocked: '<circle cx="8" cy="8" r="5.8"/><path d="M3.9 12.1l8.2-8.2"/>',
    info:    '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.6"/><path d="M8 5.1v.1"/>',
    help:    '<circle cx="8" cy="8" r="5.8"/><path d="M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1v.3"/><path d="M8 11.4v.1"/>',
    plus:    '<path d="M8 3.5v9M3.5 8h9"/>',
    note:    '<path d="M6.5 12V3l6-1.3v8.6"/><circle cx="4.7" cy="12" r="1.8"/><circle cx="10.7" cy="10.3" r="1.8"/>',
    tabs:    '<rect x="2" y="3.5" width="12" height="9.5" rx="1.5"/><path d="M2 6.5h12M5.5 3.5v3"/>',
    refresh: '<path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7"/><path d="M13.2 2.6v3.2H10"/>',
    down:    '<path d="M4.5 6.3L8 9.8l3.5-3.5"/>',
    up:      '<path d="M4.5 9.7L8 6.2l3.5 3.5"/>',
    x:       '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    tune:    '<path d="M2.5 4.5h3.2M9 4.5h4.5M2.5 11.5h7.3M13 11.5h.5"/><circle cx="7.3" cy="4.5" r="1.6"/><circle cx="11.4" cy="11.5" r="1.6"/>',
    plug:    '<path d="M6 1.5v3M10 1.5v3"/><path d="M4 4.5h8v3a4 4 0 0 1-8 0z"/><path d="M8 11.5v3"/>',
    unplug:  '<path d="M6 1.5v3M10 1.5v3"/><path d="M4 4.5h8v3a4 4 0 0 1-8 0z"/><path d="M8 11.5v3"/><path d="M2 2l12 12"/>',
    fold:    '<path d="M4.5 5.5L8 9l3.5-3.5"/><path d="M3.5 12.5h9"/>',
    list:    '<path d="M6 4h7.5M6 8h7.5M6 12h7.5"/><path d="M2.6 4h.1M2.6 8h.1M2.6 12h.1"/>',
    star:    '<path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4-2.9-2.8 4-.6z"/>',
    ext:     '<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L8 8"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
  };
  // side: "lead" before text, "trail" after it (a caret), nothing alone.
  function ic(name, side = "") {
    return `<svg class="${PLUGIN_ID}-ic${side ? " is-" + side : ""}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ` +
           `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
  }
  function escHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // An icon and a line of text; the text alone stays in textContent, so
  // tooltips built from textContent read as before.
  function setIconText(el, icon, text) {
    el.innerHTML = (icon ? ic(icon, text ? "lead" : "") : "") + escHtml(text);
  }
  let eventInfoTimer = null;
  let eventInfoActive = false;
  let invert                = false;     // kept for Handy script reload only
  let outputOn              = true;      // global kill switch, hotkey E
  let manualOn              = false;
  // 1.46, one Strength per mode, said at the motor (docs/intiface-ux §5.2):
  // Manual: manualLevel is the share of the pattern's Power limit (Max), so
  // the Strength shown is manualLevel x Power limit, and a preset with a
  // higher Max still climbs into it (as up to 1.45). Script: scriptLevel is
  // the backend's master for the script; Strength = scriptLevel x Strongest.
  // Goon: the Level, with the master held at 100 (what Goon says is what
  // the motor gets). Up to 1.45 manualLevel was one master for both.
  let manualLevel           = 100;       // percent of the Power limit in Manual
  let scriptLevel           = 100;       // percent, the master while the script drives
  let manualShape           = "constant";
  let manualPeriod          = 4.0;       // seconds per cycle for shaped modes
  let manualOnMs            = 400;       // burst length for Pulse / Tease
  let manualDepth           = 15;        // % floor for Wave / Ramp
  let manualBuild           = 0;         // Tease: cycles spent escalating, 0 = off
  let manualOnFromMs        = 200;       // Tease: first buzz length while building
  // Scenes with no funscript play the manual pattern while the video plays.
  // autoManualActive: this plugin turned manual on, so it also turns it off.
  // autoManualVeto: the user turned it off during this scene; leave it off.
  let autoManual            = true;
  let autoManualActive      = false;
  let autoManualVeto        = false;
  let sceneHasNoScript      = false;
  let autoManualInternal    = false;
  let manualBuildAmp        = 0;         // Tease: cycles spent growing strength, 0 = off
  let manualAmpFrom         = 20;        // Tease: first buzz strength, % of peak
  let manualCeiling         = 100;       // % of motor output the slider maxes at
  let manualMicroMs         = 120;       // micro on-pulse length
  let scalarStep            = 0.05;      // device floor, refreshed from status
  let handyEnabled          = false;     // Handy UI hidden unless enabled in settings
  let advancedOpen          = false;
  let hotkeysOn             = true;    // toolbar toggle, per-browser
  let hotkeysAllowed        = true;    // plugin setting; false disables them outright
  // New installs start on Auto (Flow, or Beat for beat scripts). Saved settings
  // keep whatever the user chose.
  let vibeMode              = "auto";    // "auto" | "flow" | "speed" | "position" | "beat" | "off"
  let flowSmooth            = 50;        // % : 0 follows each stroke, 100 follows the scene
  let flowRhythm            = 30;        // % : 0 smooth level, 100 a burst per stroke
  let flowGain              = 1.0;       // sensitivity around the script's own level
  let flowOverview          = null;      // {t0, t1, levels} whole-scene strip from the backend
  let beatMs                = 120;       // beat mode burst length
  let beatEdge              = "all";     // "all" | "low" | "high"
  let beatProminence        = 20;        // peak picking swing threshold for dense scripts
  let previewOn             = false;     // scope streaming right now
  let previewWanted         = false;     // the Live signal switch (persisted)
  let dockOpen              = false;     // script dock under the player (persisted)
  const PREVIEW_WINDOW_MS   = 8000;      // seconds of history shown
  let previewSamples        = [];        // {t, tg, lv, m, s}
  let previewCanvas         = null;
  let previewRaf            = null;
  let previewSentCount      = 0;         // rolling count for the cmd/s readout
  let previewScript         = null;      // {t0, t1, pts:[[mediaMs,pos]], beats:[mediaMs]}
  let vibeMaxSpeed          = 500;       // funscript units/sec = full intensity
  let vibeSmooth            = 0.30;
  let vibeSubstep           = false;    // pulse below the hardware floor
  let vibeTrackOn           = true;     // play a dedicated .vib track when one exists

  function log(msg, level = "info") {
    const prefix = "[IntifaceSync]";
    const debugOn = localStorage.getItem("intifaceSyncDebug") === "1";

    if (level === "error")      console.error(prefix, msg);
    else if (level === "debug") { if (debugOn) console.log(prefix, msg); }
    else                        console.log(prefix, msg);
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  function loadSettingsFromStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.offsetMs   === "number")  offsetMs  = s.offsetMs;
      if (typeof s.strokeMin  === "number")  strokeMin = s.strokeMin;
      if (typeof s.strokeMax  === "number")  strokeMax = s.strokeMax;
      if (typeof s.invert     === "boolean") invert    = s.invert;
      if (typeof s.mode       === "string")  mode      = s.mode;
      if (typeof s.handyKey   === "string")  handyKey  = s.handyKey;
      if (typeof s.vibeMode     === "string") vibeMode     = s.vibeMode;
      if (typeof s.vibeMaxSpeed === "number") vibeMaxSpeed = s.vibeMaxSpeed;
      if (typeof s.vibeSmooth   === "number") vibeSmooth   = s.vibeSmooth;
      if (typeof s.vibeSubstep  === "boolean") vibeSubstep = s.vibeSubstep;
      if (typeof s.vibeTrackOn  === "boolean") vibeTrackOn = s.vibeTrackOn;
      if (typeof s.flowSmooth   === "number") flowSmooth   = s.flowSmooth;
      if (typeof s.flowRhythm   === "number") flowRhythm   = s.flowRhythm;
      if (typeof s.flowGain     === "number") flowGain     = s.flowGain;
      if (typeof s.beatMs       === "number") beatMs       = s.beatMs;
      if (typeof s.beatEdge     === "string") beatEdge     = s.beatEdge;
      if (typeof s.beatProminence === "number") beatProminence = s.beatProminence;
      if (typeof s.manualLevel  === "number") manualLevel  = s.manualLevel;
      if (typeof s.manualShape  === "string") manualShape  = s.manualShape;
      if (typeof s.outputOn     === "boolean") outputOn    = s.outputOn;
      else if (typeof s.manualLevel === "number") {
        // Settings written before the slider became a master gain.
        manualLevel = 100;
        log("Migrated old manual level to master intensity 100%");
      }
      // 1.46: the script's own master. Settings from 1.45 and older had one
      // master for both, so the script starts where it was (nothing jumps).
      if (typeof s.scriptLevel === "number") scriptLevel = s.scriptLevel;
      else scriptLevel = manualLevel;
      if (typeof s.manualPeriod  === "number") manualPeriod  = s.manualPeriod;
      if (typeof s.manualOnMs    === "number") manualOnMs    = s.manualOnMs;
      if (typeof s.manualDepth   === "number") manualDepth   = s.manualDepth;
      if (typeof s.manualBuild   === "number") manualBuild   = s.manualBuild;
      if (typeof s.manualOnFromMs === "number") manualOnFromMs = s.manualOnFromMs;
      if (typeof s.autoManual   === "boolean") autoManual  = s.autoManual;
      if (typeof s.manualBuildAmp === "number") manualBuildAmp = s.manualBuildAmp;
      if (typeof s.manualAmpFrom  === "number") manualAmpFrom  = s.manualAmpFrom;
      if (typeof s.manualCeiling === "number") manualCeiling = s.manualCeiling;
      if (typeof s.manualMicroMs === "number") manualMicroMs = s.manualMicroMs;
      if (typeof s.hotkeysOn    === "boolean") hotkeysOn   = s.hotkeysOn;
      if (typeof s.presetBase   === "string")  presetBase  = s.presetBase;
      if (typeof s.dockOpen     === "boolean") dockOpen    = s.dockOpen;
      if (typeof s.previewWanted === "boolean") previewWanted = s.previewWanted;
    } catch (e) {
      log(`Failed to load settings: ${e}`, "error");
    }
  }

  function saveSettingsToStorage() {
    // Script settings are saved as the defaults, not as whatever the current
    // script was tuned to; see "Per-script memory".
    let defaults = {};
    try { if (scriptDefaults) defaults = scriptDefaults; } catch (_) {}   // not declared yet during startup
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        offsetMs, strokeMin, strokeMax, invert, mode, handyKey,
        vibeMode, vibeMaxSpeed, vibeSmooth, vibeSubstep, beatMs, beatEdge, beatProminence,
        vibeTrackOn, flowSmooth, flowRhythm, flowGain,
        manualLevel, scriptLevel, manualShape, manualPeriod,
        manualOnMs, manualDepth, manualBuild, manualCeiling, manualMicroMs, manualOnFromMs, autoManual,
        manualBuildAmp, manualAmpFrom,
        outputOn, hotkeysOn, presetBase, dockOpen, previewWanted,
        ...defaults,
      }));
    } catch (e) {
      log(`Failed to save settings: ${e}`, "error");
    }
  }

  function sendSettings() {
    saveSettingsToStorage();
    sendMsg({
      type:      "settings",
      offsetMs:  offsetMs,
      strokeMin: strokeMin / 100,
      strokeMax: strokeMax / 100,
      invert:    invert,
      vibeMode:     vibeMode,
      vibeMaxSpeed: vibeMaxSpeed,
      vibeSmooth:   vibeSmooth,
      vibeSubstep:  vibeSubstep,
      beatMs:       beatMs,
      beatEdge:     beatEdge,
      beatProminence: beatProminence,
      vibeTrack:    vibeTrackOn,
      flowSmooth:   flowSmooth / 100,
      flowRhythm:   flowRhythm / 100,
      flowGain:     flowGain,
    });
  }

  // ── Global output toggle ───────────────────────────────────────────────────
  function sendOutput() {
    sendMsg({ type: "output", enabled: outputOn });
  }

  function setOutput(on) {
    outputOn = !!on;
    saveSettingsToStorage();
    updateOutputUI();
    sendOutput();
    log(`Output: ${outputOn ? "enabled" : "disabled"}`);
  }

  function updateOutputUI() {
    const btn = byId(`${PLUGIN_ID}-output-btn`);
    if (btn) {
      // The word says the state (1.17), short so the bar stays one line.
      btn.innerHTML = ic("power") + `<span class="${PLUGIN_ID}-word">${outputOn ? "Live" : "Muted"}</span>`;
      btn.classList.toggle("is-live", outputOn);
      btn.classList.toggle("is-muted", !outputOn);
      btn.setAttribute("aria-label", outputOn ? "Device live" : "Device muted");
      btn.setAttribute("aria-keyshortcuts", "E");
      btn.title = outputOn
        ? "Device live: the toy can be driven. Click (or E) to cut all output at once."
        : "Device muted: nothing reaches the toy, script or manual. Click (or E) to allow output again.";
    }
    const bar = byId(`${PLUGIN_ID}-toolbar`);
    if (bar) bar.classList.toggle("is-muted", !outputOn);
    updateToolbarStatus();
  }

  // ── Manual control ─────────────────────────────────────────────────────────
  let manualThrottle = 0;
  function throttledManual() {
    const now = Date.now();
    if (now - manualThrottle < 80) return;
    manualThrottle = now;
    sendManual();
  }

  // 1.43: Goon mode and a quick-slot ramp change only what is sent, never
  // the user's own values: patternOverride is the pattern Goon plays,
  // ceilOverride the strength it (or the ramp) allows right now. Both are
  // page state, never stored. 1.44: Goon's beat shape adds its fields, and
  // its silences are a ceiling of 0 (off, not micro pulsing).
  function sendManual() {
    saveSettingsToStorage();
    // 1.45: Goon's floor is at the motor, so its ceiling depends on the
    // intensity slider: a slider move sends the matching one at once (it
    // dipped to the old ceiling x the new intensity until the next tick).
    if (goonOn && goonSt) ceilOverride = g2Output(goonLim(), goonSt, g2Mot()).ceil;
    // 1.49: Manual's Tidal is the backend's buzz shape with phrases
    const p = wireShape(patternOverride || currentPattern());
    const beat = p.shape === "beat" ? { bpm: p.bpm, div: p.div, steps: p.steps, beatLow: p.beatLow / 100,
                                         swing: p.swing / 100, drop: p.drop / 100 } : {};
    const buzz = p.shape === "buzz" ? { gapMs: p.gapMs, varyAmp: p.varyAmp / 100, varyGap: p.varyGap / 100, taps: p.taps / 100,
                                         longs: p.longs / 100, seed: p.seed, minLevel: p.minLevel / 100,
                                         // 1.49 phrases (0 / 1 when off: the 1.47 train)
                                         phraseMin: p.phraseMin || 1, phraseMax: p.phraseMax || 1, accent: (p.accent || 0) / 100,
                                         holdChance: (p.hold || 0) / 100, breathS: p.breathS || 0 } : {};
    if (manualOn) pauseZeroSent = pauseHold;      // 1.49: the held 0 is out (refreshPauseHold)
    sendMsg({
      ...beat,
      ...buzz,
      type:    "manual",
      enabled: manualOn,
      level:   masterNow() / 100,
      shape:   p.shape,
      period:  p.period,
      onMs:    p.onMs,
      depth:   p.depth / 100,
      build:   p.build,
      onFromMs: p.onFromMs,
      buildAmp: p.buildAmp,
      ampFrom:  p.ampFrom / 100,
      // 1.49: 0 while the scene's video is paused (pauseHold): silence, not a stop
      ceiling: effectiveCeiling() / 100 * (pauseHold ? 0 : 1),
      microMs: p.microMs,
    });
  }

  // 1.46: the master the backend gets now (see manualLevel at the top).
  function masterNow() {
    if (goonOn) return 100;
    return manualOn ? manualLevel : scriptLevel;
  }

  function setManual(on, level) {
    if (on === false && autoManualActive && !autoManualInternal) {
      autoManualActive = false;
      autoManualVeto   = true;
    }
    if (typeof level === "number") manualLevel = Math.max(0, Math.min(100, Math.round(level * 10) / 10));
    if (typeof on === "boolean")   manualOn    = on;
    // a manual stop ends Goon mode and any slot ramp with it (not a stop path
    // of their own: manual off below is the existing one)
    if (!manualOn) { if (goonOn) goonStop(""); stopCeilRamp(); }
    updateManualUI();
    sendManual();
    log(`Manual: ${manualOn ? "on" : "off"} @ ${manualLevel}%`, "debug");
  }

  // ── Strength and the mode (1.46) ───────────────────────────────────────
  // What plays: Goon is Manual with Goon on top, so the three never overlap.
  function currentMode() { return goonOn ? "goon" : manualOn ? "manual" : "script"; }
  // The Max mark on the Strength track: the pattern's Power limit in
  // Manual, the script's Strongest for the script.
  function strengthMax(mode) {
    return mode === "manual" ? clampN(Math.round(manualCeiling), 1, 100) : clampN(Math.round(strokeMax), 5, 100);
  }
  // A Strength at the motor as the stored share of Max (pure, tested).
  function strengthToLevel(v, max) {
    if (!(max > 0)) return 0;
    return clampN(Math.round(clampN(Number(v) || 0, 0, max) / max * 1000) / 10, 0, 100);
  }
  // What the Strength control shows (pure, tested). Goon: the level, and
  // what reaches the motor at it; otherwise the number at the motor and Max.
  function strengthView(o) {
    if (o.mode === "goon") return { kind: "level", value: o.goonLevel, min: 1, max: 10, pct: o.goonPct, maxPct: o.ceiling };
    const max = o.mode === "manual" ? clampN(Math.round(o.ceiling), 1, 100) : clampN(Math.round(o.strongest), 5, 100);
    const lv = o.mode === "manual" ? o.manualLevel : o.scriptLevel;
    return { kind: "pct", value: Math.round(clampN(lv, 0, 100) * max / 100), min: 0, max, pct: null, maxPct: max };
  }
  function strengthNow() {
    const ro = goonOn && goonSt ? g2Readout(goonLim(), goonSt, g2Mot()) : null;
    return strengthView({ mode: currentMode(), manualLevel, scriptLevel, ceiling: manualCeiling, strongest: strokeMax,
                          goonLevel: ro ? ro.level : goonSet.level, goonPct: ro ? ro.playing : 0 });
  }
  // v at the motor (a level in Goon). final: the slider was let go.
  function setStrength(v, final) {
    const mode = currentMode();
    if (mode === "goon") { if (goonSt) goonLevel(clampN(Math.round(v), 1, 10)); return; }
    const lv = strengthToLevel(v, strengthMax(mode));
    if (mode === "manual") {
      manualLevel = lv;
      if (final) setManual(undefined, lv); else { throttledManual(); updateDeck(); updateFsPill(); }
    } else {
      scriptLevel = lv;
      saveSettingsToStorage();
      if (final) sendManual(); else throttledManual();
      updateDeck(); updateFsPill();
    }
  }
  // [ and ] (and - =): the strength of what plays, never the mode. Up to
  // 1.44 a nudge also turned Manual on, so lowering the strength during a
  // script session replaced the script with the pattern. 1.46: five points
  // at the motor, or one Goon level.
  function nudgeManual(delta) {
    const mode = currentMode();
    if (mode === "goon") { if (goonSt) goonLevel(goonSt.L + Math.sign(delta)); return; }
    setStrength(strengthNow().value + delta, true);
  }

  // One choice, Script · Manual · Goon (1.46; bug 13: it only sets the mode,
  // Tune is its own button). Manual and Goon start the pattern now, as the
  // Manual button always did; Script turns Manual off, and with it Goon.
  // Leaving Goon for Manual hands back to the pattern (goonStop), never a
  // jump up. Returns the mode that plays afterwards.
  function chooseMode(m) {
    const cur = currentMode();
    if (m === cur) return cur;
    if (m === "goon") {
      const why = goonRefusal();
      if (why) { toast(why, "warn"); updateDeck(); return cur; }
      if (!manualOn) setManual(true);
      goonStart();
      updateDeck();
      return currentMode();
    }
    if (m === "manual") { if (goonOn) goonStop(""); else setManual(true); }
    else setManual(false);
    updateDeck();
    return currentMode();
  }

  // "1.45-vibe" -> 1045, so 1.10 sorts after 1.9.
  function versionNum(v) {
    const m = /^(\d+)\.(\d+)/.exec(String(v || ""));
    return m ? +m[1] * 1000 + +m[2] : 0;
  }
  function backendAtLeast(min) {
    return backendStatusSeen && !legacyBackend && versionNum(statusData && statusData.version) >= versionNum(min);
  }

  // ── Stop (1.45) ────────────────────────────────────────────────────────────
  // One full stop for every mode: the script, the manual pattern, Goon mode
  // and a slot ramp. The bar's Stop, the fullscreen pill's and the 0 key.
  // Local first, so nothing in this page re-arms it (the scriptless
  // pattern, a queued play, Goon's tick), then the backend: "halt" is
  // _panic() keeping the Intiface link (rule 1). A backend older than this
  // page does not know halt, so it gets "stop" (also _panic(), plus the
  // Intiface disconnect). Both are kill switches the backend takes from any
  // tab. Mute is left as it is, so the next play is heard. Never pause.
  let haltHeld = false;   // after Stop only the user's own play restarts the script
  function stopAll() {
    haltHeld = true;
    pendingPlay = null;
    if (autoManualTimer) { clearTimeout(autoManualTimer); autoManualTimer = null; }
    autoManualDeadline = 0;
    autoManualActive = false;
    autoManualVeto = true;          // the scriptless pattern does not come back this scene
    // 1.46: Manual off before Goon ends, so Goon's hand-back sends nothing
    // (up to 1.45 it sent one "manual on" with the pattern just before halt)
    manualOn = false;
    if (goonOn) goonStop("");
    stopCeilRamp();
    ceilOverride = null;
    updateManualUI();
    if (!ws || !wsReady) {
      // Nothing can be driven from this tab without a socket (the backend
      // panics when the driver's socket goes, the deadman covers the rest),
      // but say so instead of doing nothing visible.
      toast("Not connected: nothing is being sent from here. Stopped in this tab; the backend stops the toy " +
            "by itself when its driving tab goes away.", "warn", 8000);
      showInfoFor("Not connected: nothing is being sent from here", 8000);
      return "offline";
    }
    // halt exists since 1.45: a 1.45 backend under a 1.46 page still gets it
    const halt = backendAtLeast("1.45");
    sendMsg(halt ? { type: "halt" } : { type: "stop" });
    sendManual();                   // manual off too: the existing kill switch, any tab
    toast(halt ? "Stopped. The script starts again on the next play; Manual starts the pattern."
               : "Stopped. The backend is older than this page, so this also disconnected Intiface: " +
                 "run Stop Backend, then Start Backend.", halt ? "info" : "warn", halt ? 4000 : 8000);
    showInfoFor("Stopped", 4000);
    return halt ? "halt" : "stop";
  }

  // ── Pattern presets ────────────────────────────────────────────────────────
  // A preset is the shape of a pattern: which pattern and its timing and power
  // limit. It never carries the on-switch, so loading one can change what a
  // running session feels like but can never start one. The intensity slider
  // is left out too: it is the live knob and is expected to stay put.
  //
  // Stored twice. The copy in Stash's own plugin config is the real one: it
  // survives plugin updates and cleared browser data, and every browser sees
  // it. The browser copy exists because Stash's settings page writes back the
  // whole plugin config it loaded, so a settings tab left open while a preset
  // is saved elsewhere can put back an older list. Whichever copy has the
  // newer `rev` wins and the loser is overwritten.
  const PRESET_STORE_KEY = "IntifaceSync.presets";
  const PRESET_CFG_KEY   = "patternPresets";
  const PRESET_MAX       = 40;
  const PRESET_NAME_MAX  = 40;
  let presetStore = { v: 1, rev: 0, active: null, presets: [] };
  // Name of the preset this browser's current values were loaded from. Kept
  // with the other settings so a new tab knows whether its values are the
  // active preset (possibly edited) or leftovers that should be replaced.
  let presetBase  = null;

  function currentPattern() {
    return {
      shape: manualShape, period: manualPeriod, onMs: manualOnMs,
      depth: manualDepth, build: manualBuild, ceiling: manualCeiling,
      microMs: manualMicroMs, buildAmp: manualBuildAmp, ampFrom: manualAmpFrom,
      onFromMs: manualOnFromMs,
    };
  }

  function cleanPattern(p) {
    const num = (v, lo, hi, d) => (typeof v === "number" && isFinite(v))
      ? Math.max(lo, Math.min(hi, v)) : d;
    // 1.44: Goon mode's beat shape (accents, Heartbeat, Gallop, Stutter) is
    // not a card in the panel; only Goon plays it, so only it carries these.
    const beat = p?.shape === "beat" ? {
      bpm:     Math.round(num(p?.bpm, 20, 240, 120)),
      div:     Math.round(num(p?.div, 1, 4, 1)),
      steps:   typeof p?.steps === "string" && /^[.xX]{1,32}$/.test(p.steps) ? p.steps : "x",
      beatLow: Math.round(num(p?.beatLow, 30, 100, 80)),   // % of the peak for an x; an X plays at the peak
      swing:   Math.round(num(p?.swing, 0, 40, 0)),        // % of a step the odd steps come late
      drop:    Math.round(num(p?.drop, 0, 60, 0)),         // % chance a hit is left out
    } : null;
    // 1.47: Goon mode's buzz shape (buzzes with silence between, each its
    // own length, strength and gap); like beat, only Goon plays it
    const buzz = p?.shape === "buzz" ? {
      gapMs:    Math.round(num(p?.gapMs, 150, 60000, 1500)),   // the base silence between buzzes
      varyAmp:  Math.round(num(p?.varyAmp, 0, 60, 0)),         // % a buzz may be softer than the ceiling
      varyGap:  Math.round(num(p?.varyGap, 0, 100, 0)),        // 100: gaps 0.6-2.5x the base
      taps:     Math.round(num(p?.taps, 0, 50, 0)),            // % chance of a double or triple tap
      longs:    Math.round(num(p?.longs, 0, 40, 0)),           // % chance of a longer silence
      seed:     Math.round(num(p?.seed, 1, 2147483646, 1)),
      minLevel: Math.round(num(p?.minLevel, 0, 100, 0)),       // % at the motor: no buzz softer (never above the ceiling)
      // 1.49 phrases (Tidal): 1 / 1, 0, 0, 0 is the 1.47 train
      phraseMin: Math.round(num(p?.phraseMin, 1, 6, 1)),         // buzzes in a phrase, at least
      phraseMax: Math.round(Math.max(num(p?.phraseMin, 1, 6, 1), num(p?.phraseMax, 1, 6, 1))),
      accent:   Math.round(num(p?.accent, 0, 50, 0)),             // % chance a buzz is an accent (full strength, long end)
      hold:     Math.round(num(p?.hold, 0, 30, 0)),               // % chance a phrase ends in a 0.8-1.2 s hold
      breathS:  (() => { const b = num(p?.breathS, 0, 180, 0); return b <= 0 ? 0 : Math.round(Math.max(10, b)); })(),   // the tide's period, 0 = none
    } : null;
    return {
      ...(beat || {}),
      ...(buzz || {}),
      shape:   MANUAL_SHAPES.some((s) => s[0] === p?.shape) || beat || buzz ? p.shape : "constant",
      period:  num(p?.period, 0.5, 60, 4),
      onMs:    Math.round(num(p?.onMs, 60, 10000, 400)),
      depth:   Math.round(num(p?.depth, 0, 95, 15)),
      build:   Math.round(num(p?.build, 0, 200, 0)),
      ceiling: Math.round(num(p?.ceiling, 1, 100, 100)),
      microMs: Math.round(num(p?.microMs, 40, 1000, 120)),
      // Presets saved before 1.22 have neither; they load as "no strength build".
      buildAmp: Math.round(num(p?.buildAmp, 0, 200, 0)),
      ampFrom:  Math.round(num(p?.ampFrom, 0, 100, 20)),
      // Presets saved before 1.29 grew from the old fixed 60 ms.
      onFromMs: Math.round(num(p?.onFromMs, 60, 10000, 60)),
    };
  }

  // Only the fields the pattern actually reads decide whether it was edited.
  // Dragging "Dip to" on a Pulse pattern changes nothing you can feel.
  function patternFieldsFor(shape) {
    const f = ["ceiling", "microMs"];      // numeric only; samePattern checks shape
    if (shape !== "constant") f.push("period");
    if (shape === "pulse" || shape === "tease" || shape === "tidal") f.push("onMs");
    if (shape === "wave" || shape === "ramp" || shape === "random") f.push("depth");
    if (shape === "tease") f.push("build", "buildAmp", "ampFrom", "onFromMs");
    if (shape === "tidal") f.push("onFromMs");    // 1.49: the shortest buzz
    return f;
  }

  // ── Tidal (1.49) ──
  // A richer base than the user's Build up (one 80-280 ms buzz every 6 s at
  // a 10% Power limit): phrases of 2-5 buzzes, 100-700 ms, a short silence
  // inside a phrase and a longer one between phrases; the phrases come
  // closer, run longer and play a little stronger towards high tide and
  // thin out at low tide, over a 40 s breath; a quarter of the buzzes are
  // accents (full strength, the long end of the range), a fifth of the
  // phrases end in a 0.8-1.2 s hold, about one gap in eight is a 6-12 s
  // silence. Always true silence between buzzes. The backend's buzz shape
  // with its 1.49 phrase fields draws it (seeded) and keeps the BLE budget
  // (at most 4 buzz starts a second, buzzes >= 100 ms, silences >= 150 ms;
  // inside a phrase >= 180 ms). In Manual it is the "Tidal" card: Repeat
  // every is the phrase cycle, Buzz length the longest buzz, Shortest buzz
  // the other end. In Goon it is a base ("Tidal (built in)" or a saved
  // Tidal preset). Power limit 30% when saved from Goon's Built on (Build
  // up's 10% is very gentle for this many buzzes).
  const TIDAL = { period: 6, onFromMs: 100, onMs: 700, ceiling: 30, phraseMin: 2, phraseMax: 5, accent: 25, hold: 20,
                  breathS: 40, longs: 12, varyAmp: 35, varyGap: 60 };
  const TIDAL_INNER_MS = [180, 420];   // the backend's BUZZ_INNER_GAP_MS
  const TIDAL_HOLD_MS  = [800, 1200];  // BUZZ_HOLD_MS
  const TIDAL_LONG_MAX_MS = 12000;     // BUZZ_LONG_MAX_MS
  const tidalSeed = 1 + Math.floor(Math.random() * 2147480000);   // this page session's train
  // The base gap between phrases for a phrase cycle (s) and a length range:
  // the cycle less the mean phrase (its buzzes and the silences inside it),
  // divided by the mean of the gap's variety factor. Pure.
  function tidalGap(cycleS, lo, hi, pmin, pmax, vg) {
    const k = ((pmin || 2) + (pmax || 5)) / 2, inner = (TIDAL_INNER_MS[0] + TIDAL_INNER_MS[1]) / 2;
    const phrase = k * (lo + hi) / 2 + (k - 1) * inner;
    return Math.round(clampN((cycleS * 1000 - phrase) / (1 + 0.55 * (vg || 0) / 100), 150, 60000));
  }
  // Manual's Tidal as the backend's buzz shape (pure).
  function tidalWire(p, seed) {
    const lo = clampN(Math.round(p.onFromMs || TIDAL.onFromMs), 100, 2000);
    const hi = clampN(Math.round(Math.max(lo, p.onMs || TIDAL.onMs)), lo, 2000);
    const cycle = clampN(Number(p.period) || TIDAL.period, 2, 30);
    return { ...p, shape: "buzz", onFromMs: lo, onMs: hi, depth: 0, taps: 0, minLevel: 0,
             gapMs: tidalGap(cycle, lo, hi, TIDAL.phraseMin, TIDAL.phraseMax, TIDAL.varyGap),
             varyAmp: TIDAL.varyAmp, varyGap: TIDAL.varyGap, longs: TIDAL.longs, phraseMin: TIDAL.phraseMin,
             phraseMax: TIDAL.phraseMax, accent: TIDAL.accent, hold: TIDAL.hold, breathS: TIDAL.breathS,
             seed: Math.round(clampN(Number(seed) || 1, 1, 2147483646)) };
  }
  function wireShape(p) { return p && p.shape === "tidal" ? tidalWire(p, tidalSeed) : p; }

  function samePattern(a, b) {
    if (!a || !b || a.shape !== b.shape) return false;
    return patternFieldsFor(a.shape).every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-6);
  }

  function activePreset() {
    return presetStore.active
      ? presetStore.presets.find((p) => p.name === presetStore.active) || null
      : null;
  }

  function presetEdited() {
    const p = activePreset();
    return !!p && !samePattern(cleanPattern(p), currentPattern());
  }

  function applyPattern(p) {
    const c = cleanPattern(p);
    manualShape = c.shape;   manualPeriod  = c.period;  manualOnMs    = c.onMs;
    manualDepth = c.depth;   manualBuild   = c.build;   manualCeiling = c.ceiling;
    manualMicroMs = c.microMs; manualBuildAmp = c.buildAmp; manualAmpFrom = c.ampFrom;
    manualOnFromMs = c.onFromMs;
    saveSettingsToStorage();
    updateManualUI();
    // Pattern only. sendManual() also carries the current on/off, which is
    // whatever this tab last heard from the backend, so this never arms it.
    sendManual();
  }

  function parseStore(raw) {
    try {
      const s = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!s || !Array.isArray(s.presets)) return null;
      const seen = new Set();
      const presets = [];
      for (const p of s.presets) {
        const name = String(p?.name ?? "").trim().slice(0, PRESET_NAME_MAX);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        // 1.43: a preset's fields this page does not know ride through (rule 5)
        presets.push({ ...p, name, ...cleanPattern(p) });
      }
      const active = presets.some((p) => p.name === s.active) ? s.active : null;
      // 1.43: so do the store's own (slots and goon are read where they are
      // used, never cleaned away here)
      return { ...s, v: 1, rev: Number(s.rev) || 0, active, presets: presets.slice(0, PRESET_MAX) };
    } catch (_) {
      return null;
    }
  }

  function readBrowserStore() {
    try { return parseStore(localStorage.getItem(PRESET_STORE_KEY)); }
    catch (_) { return null; }
  }

  function writeBrowserStore() {
    try { localStorage.setItem(PRESET_STORE_KEY, JSON.stringify(presetStore)); }
    catch (e) { log(`Could not save presets in this browser: ${e}`, "error"); }
  }

  // ── Suite Data client: the same in every plugin that keeps data (checked
  // by scripts/check_shared.py; MAINTENANCE §4.24) ────────────────────────
  // Stash's Settings page re-saves every plugin's config from the copy it
  // loaded when it opened, so data written since can be rolled back (§6
  // "All"). With the Suite Data plugin installed and enabled the data keys
  // (o.keys) live in its store instead: files outside every plugin folder, a
  // revision per key, a write based on an old revision refused so the change
  // is run again on what is there now. Settings stay in the plugin config.
  // Without Suite Data everything stays in the config, as before.
  //   o: { id, keys, gql, readConfig(), writeConfig(map, opt), notify(text), label }
  //   read(map?)           the plugin's map: its config (or the one given, read
  //                        with other things), the stored keys over it
  //   update(fn, opt)      one at a time; fn(copy) returns the whole new map
  //                        (null: nothing to write; throw: refuse), as before;
  //                        opt.mirror: rewrite the copy now; opt reaches writeConfig
  //                        (the copy itself is written with {copy: true})
  //   overlay(id, map)     another plugin's map with its stored keys over it
  //   mode()               "store", "config", or "mirror" (Suite Data off or
  //                        not answering after it held this plugin's data)
  // The first time a plugin sees Suite Data its data keys are copied in
  // (base revision 0: never over something already there; the config keeps
  // its copy, rule 5). From then on the store is the original and the config
  // a copy (the mirror), rewritten when the store is ahead of it, at most
  // every MIRROR_MS or at once with {mirror: true}: uninstalling Suite Data
  // still leaves a recent copy. A change made in the config while Suite Data
  // was off is marked and taken back into the store when it answers again;
  // if the store moved on too, the store's version stays and the other
  // becomes one of its backups (Your data restores it).
  function suiteData(o) {
    const MARK = "suiteDataMirror", MIRROR_MS = o.mirrorMs || 5 * 60 * 1000, TRIES = 6;
    const name = o.label || o.id;
    const S = { inst: null, err: false, syncing: null, revs: {}, vals: {}, loaded: false, at: 0, mrevs: {}, timer: 0, told: "", chain: Promise.resolve() };
    const own = (k) => o.keys.indexOf(k) >= 0;
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    const mark = (m) => { try { const v = JSON.parse((m && m[MARK]) || "null"); return v && typeof v === "object" ? v : null; } catch (_) { return null; } };
    const tell = (text) => { if (S.told !== text) { S.told = text; try { if (o.notify) o.notify(text); } catch (_) {} } };
    async function op(args) {
      const d = await o.gql(`mutation ($a: Map) { runPluginOperation(plugin_id: "SuiteData", args: $a) }`, { a: args });
      const r = d && d.runPluginOperation;
      if (!r || typeof r !== "object") throw new Error("Suite Data did not answer");
      return r;
    }
    // Installed and enabled? Asked once per page for every plugin; a failed
    // ask counts as "not installed" and is asked again after a minute.
    function installed() {
      const w = typeof window !== "undefined" ? window : {};
      const p = w.__suiteDataProbe;
      if (p && (p.ok || Date.now() - p.at < 60000)) return p.promise;
      const rec = { at: Date.now(), ok: false, promise: null };
      rec.promise = Promise.resolve().then(() => o.gql(`query { plugins { id enabled } }`)).then((d) => {
        rec.ok = true;
        const me = ((d && d.plugins) || []).find((x) => x && x.id === "SuiteData");
        return !!(me && me.enabled !== false);
      }).catch(() => false);
      w.__suiteDataProbe = rec;
      return rec.promise;
    }
    function absorb(items) {
      Object.keys(items || {}).forEach((k) => {
        if (!own(k)) return;
        const it = items[k];
        if (it && typeof it.rev === "number") { S.revs[k] = it.rev; S.vals[k] = it.value; }
        else { delete S.revs[k]; delete S.vals[k]; }
      });
    }
    function over(mine) {
      const m = { ...mine };
      o.keys.forEach((k) => {
        if (!S.revs[k]) return;
        if (S.vals[k] === null || S.vals[k] === undefined) delete m[k]; else m[k] = S.vals[k];
      });
      return m;
    }
    async function put(items, by) {
      const r = await op({ mode: "put", plugin: o.id, items: JSON.stringify(items), by: by || name });
      if (r.ok) Object.keys(items).forEach((k) => { S.revs[k] = r.revs[k]; S.vals[k] = items[k].value; });
      else absorb(r.conflict);
      return !!r.ok;
    }
    // First contact: read the store, copy in what it lacks, take back what
    // was changed in the config while Suite Data was off.
    async function sync(mine) {
      absorb((await op({ mode: "get", plugin: o.id, keys: JSON.stringify(o.keys) })).items);
      const mk = mark(mine), fresh = {}, back = [];
      o.keys.forEach((k) => {
        if (mine[k] === undefined) return;
        if (!S.revs[k]) fresh[k] = { value: mine[k], base: 0 };
        else if (mk && mk.dirty && !same(mine[k], S.vals[k])) back.push(k);
      });
      if (Object.keys(fresh).length && !(await put(fresh, "copied from the plugin settings"))) {
        // another tab copied first: what it wrote stands, the rest goes in
        const left = {};
        Object.keys(fresh).forEach((k) => { if (!S.revs[k]) left[k] = fresh[k]; });
        if (Object.keys(left).length) await put(left, "copied from the plugin settings");
      }
      for (const k of back) {
        const base = S.revs[k], theirs = S.vals[k];
        if (mk.revs && mk.revs[k] === base) {
          await put({ [k]: { value: mine[k], base } }, "changed while Suite Data was off");
        } else {
          // both moved on: the store's version stays, the other is a backup
          if (await put({ [k]: { value: mine[k], base } }, "kept from the plugin settings"))
            await put({ [k]: { value: theirs, base: S.revs[k] } }, "store version kept");
          tell(`${name}: changes made while Suite Data was off were kept as a backup (Suite Data, Your data).`);
        }
      }
      S.at = (mk && !mk.dirty && mk.at) || 0;
      S.mrevs = (mk && !mk.dirty && mk.revs) || {};
      S.loaded = true;
    }
    // one first contact at a time (a page reads several things at once)
    function ensure(mine) {
      if (!S.syncing) S.syncing = sync(mine).then(() => { S.syncing = null; }, (e) => { S.syncing = null; throw e; });
      return S.syncing;
    }
    // Rewrite the copy in the config when the store is ahead of it.
    function plan(now) {
      if (!o.keys.some((k) => S.revs[k] && S.revs[k] !== S.mrevs[k])) return;
      const due = S.at + MIRROR_MS - Date.now();
      if (now || due <= 0) { if (S.timer) clearTimeout(S.timer); S.timer = 0; Promise.resolve().then(mirror); }
      else if (!S.timer) S.timer = setTimeout(() => { S.timer = 0; mirror(); }, due);
    }
    function mirror() {
      const run = S.chain.then(async () => {
        if (!S.loaded || S.err) return;
        const next = over(await o.readConfig());
        const revs = { ...S.revs };
        next[MARK] = JSON.stringify({ at: Date.now(), revs });
        await o.writeConfig(next, { copy: true });   // the mirror itself: a plugin may skip its refetch
        S.at = Date.now();
        S.mrevs = revs;
      });
      S.chain = run.catch(() => {});
      return S.chain;
    }
    function failed(mine, e) {
      S.err = true;
      S.loaded = false;          // the next answer syncs again, taking back changes made meanwhile
      tell(`${name}: Suite Data did not answer (${(e && e.message) || e}); using the copy in the plugin settings for now.`);
    }
    // Said once per page, and "off" at most every 12 hours per plugin
    // (localStorage SuiteDataPrefs): it is true on every page until the user
    // acts, and a dozen plugins would say it at once.
    function off(mine) {
      const mk = mark(mine);
      if (!mk) return;
      let seen = {};
      try { seen = JSON.parse(localStorage.getItem("SuiteDataPrefs") || "{}").off || {}; } catch (_) {}
      if (Date.now() - (seen[o.id] || 0) < 12 * 3600 * 1000) { S.told = S.told || "off"; return; }
      try { seen[o.id] = Date.now(); localStorage.setItem("SuiteDataPrefs", JSON.stringify({ off: seen })); } catch (_) {}
      tell(`${name}: Suite Data is off; using the copy in the plugin settings${mk.at ? " from " + new Date(mk.at).toLocaleString() : ""}.`);
    }
    // The config alone, as before Suite Data. Once Suite Data held this
    // plugin's data, a changed data key is marked for taking back.
    async function configUpdate(mine, fn, cur, opt) {
      const base = cur || mine;
      const next = fn({ ...base });
      if (next === null || next === undefined) return next;
      const mk = mark(mine);
      if ((mk || cur) && o.keys.some((k) => !same(base[k], next[k])))
        next[MARK] = JSON.stringify({ ...(mk || {}), dirty: Date.now(), revs: cur ? { ...S.revs } : ((mk && mk.revs) || {}) });
      await o.writeConfig(next, opt || {});
      return next;
    }
    async function useStore() {
      if (S.inst === null) S.inst = await installed();
      return S.inst;
    }
    async function read(given) {
      const mine = given || await o.readConfig();
      if (!(await useStore())) { off(mine); return mine; }
      try {
        if (!S.loaded) await ensure(mine);
        else absorb((await op({ mode: "get", plugin: o.id, keys: JSON.stringify(o.keys) })).items);
        S.err = false;
        plan(false);
        return over(mine);
      } catch (e) {
        const had = Object.keys(S.revs).length > 0;
        failed(mine, e);
        return had ? over(mine) : mine;
      }
    }
    function update(fn, opt) {
      const run = S.chain.then(async () => {
        const mine = await o.readConfig();
        if (!(await useStore())) { off(mine); return configUpdate(mine, fn, null, opt); }
        try {
          if (!S.loaded) await ensure(mine);
        } catch (e) { failed(mine, e); return configUpdate(mine, fn, Object.keys(S.revs).length ? over(mine) : null, opt); }
        for (let i = 0; i < TRIES; i++) {
          const cur = over(mine);
          const next = fn({ ...cur });
          if (next === null || next === undefined) return next;
          const items = {};
          o.keys.forEach((k) => {
            if (S.revs[k] ? !same(S.vals[k], next[k]) : next[k] !== undefined)
              items[k] = { value: next[k] === undefined ? null : next[k], base: S.revs[k] || 0 };
          });
          if (Object.keys(items).length) {
            let ok;
            try { ok = await put(items); }
            catch (e) { failed(mine, e); return configUpdate(mine, fn, cur, opt); }
            if (!ok) continue;      // someone else wrote first: run fn again on theirs
          }
          S.err = false;
          // a setting the plugin's own UI changed goes to the config as before
          const changed = Object.keys({ ...mine, ...next }).filter((k) => !own(k) && k !== MARK && !same(mine[k], next[k]));
          if (changed.length) {
            const fresh = { ...(await o.readConfig()) };
            changed.forEach((k) => { if (next[k] === undefined) delete fresh[k]; else fresh[k] = next[k]; });
            await o.writeConfig(fresh, opt || {});
          }
          plan(!!(opt && opt.mirror));
          return { ...next };
        }
        throw new Error("Suite Data: other writes kept getting in first; nothing was saved, try again");
      });
      S.chain = run.catch(() => {});
      return run;
    }
    async function overlay(id, map) {
      try {
        if (!(await useStore())) return map;
        const r = await op({ mode: "get", plugin: id });
        const m = { ...(map || {}) };
        Object.keys(r.items || {}).forEach((k) => {
          const v = r.items[k] && r.items[k].value;
          if (v === null || v === undefined) delete m[k]; else m[k] = v;
        });
        return m;
      } catch (_) { return map; }
    }
    return {
      read, update, overlay,
      mirror: () => (S.inst && S.loaded ? mirror() : Promise.resolve()),
      mode: () => (S.inst ? (S.err ? "mirror" : "store") : S.told ? "mirror" : "config"),
    };
  }

  // Read-merge-write. configurePlugin replaces the plugin's whole config, so
  // the URL and other settings have to be carried through untouched. A read
  // that fails must abort the write: writing a blank map would wipe them.
  // Writes are chained: two read-merge-writes in flight at once (a preset and
  // a script's settings) would each write back the map they read, and the
  // second would undo the first.
  // 1.39: with the Suite Data plugin installed the three stores (DATA_KEYS:
  // presets, per-script settings, per-performer patterns) live in its store,
  // where Stash's Settings page cannot roll them back (MAINTENANCE §4.24);
  // its client (SD) runs the chain and keeps a copy in the config. Nothing
  // here is on the safety path: these are UI preferences only.
  function writeStashKey(key, value) {
    return SD.update((mine) => ({ ...mine, [key]: JSON.stringify(value) }));
  }
  const SD = suiteData({ id: PLUGIN_ID, keys: DATA_KEYS, gql: gqlQuery, label: "Intiface Sync", readConfig: readOwnConfig,
                         writeConfig: writeOwnConfig, notify: (t) => toast(t, "warn") });
  // the three stores: the config with Suite Data's copies over it
  async function loadPluginData() {
    return SD.read(await loadPluginConfig());
  }

  async function readOwnConfig() {
    const resp = await fetch("/graphql", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { configuration { plugins } }" }),
    });
    const json = await resp.json();
    const plugins = json?.data?.configuration?.plugins;
    if (json?.errors?.length || !plugins || typeof plugins !== "object") {
      throw new Error(json?.errors?.[0]?.message || "could not read the plugin config");
    }
    return plugins[PLUGIN_ID] || {};
  }
  async function writeOwnConfig(input) {
    const w = await fetch("/graphql", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
        variables: { id: PLUGIN_ID, input },
      }),
    });
    const wj = await w.json();
    if (wj?.errors?.length) throw new Error(wj.errors[0].message);
  }

  let presetSyncNote = "";   // shown in the popover when Stash could not be written
  function persistPresets() {
    presetStore.rev = Date.now();
    writeBrowserStore();
    writeStashKey(PRESET_CFG_KEY, presetStore).then(() => {
      presetSyncNote = "";
      updatePresetUI();
    }).catch((e) => {
      presetSyncNote = "Saved in this browser only. Stash did not accept it: " + e.message;
      log(`Preset sync to Stash failed: ${e.message}`, "error");
      updatePresetUI();
    });
  }

  // A preset that became active somewhere else (another tab, another browser,
  // a previous session) replaces this browser's values. One that is already
  // the base here is left alone, because the values may be deliberate edits.
  function adoptActivePreset() {
    const p = activePreset();
    if (!p) { presetBase = null; saveSettingsToStorage(); return; }
    if (presetBase === p.name) return;
    presetBase = p.name;
    applyPattern(p);
    log(`Preset "${p.name}" is active, loaded its pattern`);
  }

  async function loadPresets() {
    const local = readBrowserStore();
    let remote = null;
    try {
      const cfg = await loadPluginData();
      remote = parseStore(cfg?.[PRESET_CFG_KEY]);
    } catch (_) {}
    const best = [local, remote].filter(Boolean).sort((a, b) => b.rev - a.rev)[0];
    if (best) presetStore = best;
    goonSet = cleanGoon2(presetStore.goon2);
    // 1.46: the quick slots become the first four cards, once
    const ordered = slotsToOrder(presetStore);
    if (ordered !== presetStore) {
      presetStore = ordered;
      log("Quick slots became the first four preset cards");
      persistPresets();
    }
    if (local && (!remote || local.rev > remote.rev)) {
      // Stash lost it (see the header comment) or never had it: put it back.
      writeStashKey(PRESET_CFG_KEY, presetStore).catch((e) => log(`Preset sync to Stash failed: ${e.message}`));
    }
    if (best && best !== local) writeBrowserStore();
    adoptActivePreset();
    updatePresetUI();
  }

  // Other tabs in this browser learn about changes the moment they happen.
  window.addEventListener("storage", (ev) => {
    if (ev.key !== PRESET_STORE_KEY) return;
    const s = parseStore(ev.newValue);
    if (!s || s.rev <= presetStore.rev) return;
    presetStore = slotsToOrder(s);
    goonSet = cleanGoon2(presetStore.goon2);
    adoptActivePreset();
    updatePresetUI();
  });

  function selectPreset(name) {
    const p = presetStore.presets.find((x) => x.name === name);
    if (!p) return;
    presetStore.active = name;
    presetBase = name;
    applyPattern(p);
    persistPresets();
    updatePresetUI();
    log(`Preset selected: ${name}`);
  }

  function savePresetAs(rawName) {
    const name = String(rawName || "").trim().slice(0, PRESET_NAME_MAX);
    if (!name) return "Give it a name first.";
    const existing = presetStore.presets.findIndex((p) => p.name === name);
    if (existing < 0 && presetStore.presets.length >= PRESET_MAX) {
      return `That is ${PRESET_MAX} presets already. Delete one first.`;
    }
    const entry = { ...(existing >= 0 ? presetStore.presets[existing] : {}), name, ...currentPattern() };
    if (existing >= 0) presetStore.presets[existing] = entry;
    else presetStore.presets.push(entry);
    presetStore.active = name;
    presetBase = name;
    saveSettingsToStorage();
    persistPresets();
    updatePresetUI();
    return "";
  }

  // 1.49: the built-in Tidal as a preset of the user's own ("Tidal", or
  // "Tidal 2" when that name is taken), Power limit 30%. The active preset
  // and what plays in Manual are left alone; Goon is then built on the copy.
  function tidalPresetEntry(name) {
    return { name, ...cleanPattern({ shape: "tidal", period: TIDAL.period, onMs: TIDAL.onMs, onFromMs: TIDAL.onFromMs,
                                    ceiling: TIDAL.ceiling, depth: 0, microMs: manualMicroMs }) };
  }
  function saveTidalPreset() {
    let name = "Tidal";
    for (let n = 2; presetStore.presets.some((p) => p.name === name) && n < 100; n++) name = `Tidal ${n}`;
    if (presetStore.presets.length >= PRESET_MAX) { toast(`That is ${PRESET_MAX} presets already. Delete one first.`, "warn"); return ""; }
    presetStore = { ...presetStore, presets: presetStore.presets.concat([tidalPresetEntry(name)]) };
    persistPresets();
    goonSetBase(name);
    updatePresetUI();
    toast(`Saved as "${name}" (Power limit ${TIDAL.ceiling}%): a card in Manual; Goon is built on it now.`, "done");
    return name;
  }

  function updateActivePreset() {
    const p = activePreset();
    if (p) savePresetAs(p.name);
  }

  function revertActivePreset() {
    const p = activePreset();
    if (p) applyPattern(p);
    updatePresetUI();
  }

  function deletePreset(name) {
    presetStore.presets = presetStore.presets.filter((p) => p.name !== name);
    if (presetStore.active === name) { presetStore.active = null; presetBase = null; }
    presetStore = syncSlots(renameInSlots(presetStore, name, null));
    saveSettingsToStorage();
    persistPresets();
    updatePresetUI();
  }

  function renamePreset(from, rawTo) {
    const to = String(rawTo || "").trim().slice(0, PRESET_NAME_MAX);
    if (!to) return "Give it a name first.";
    if (to === from) return "";
    if (presetStore.presets.some((p) => p.name === to)) return "A preset with that name exists.";
    const p = presetStore.presets.find((x) => x.name === from);
    if (!p) return "";
    p.name = to;
    if (presetStore.active === from) { presetStore.active = to; presetBase = to; }
    presetStore = syncSlots(renameInSlots(presetStore, from, to));
    saveSettingsToStorage();
    persistPresets();
    updatePresetUI();
    return "";
  }

  function clearActivePreset() {
    presetStore.active = null;
    presetBase = null;
    saveSettingsToStorage();
    persistPresets();
    updatePresetUI();
  }

  // ── Quick slots (1.43) and Goon mode 2 (1.44) ─────────────────────────────
  // Quick slots: four presets a key away (Alt+1..4 switches, Alt+Shift+1..4
  // or the pin in the pattern panel puts the active preset there). Stored in
  // the preset store as `slots` (names), next to the presets they point at.
  // While Goon mode runs the digits are its launch pads instead.
  //
  // Goon mode 2 (docs/goon-mode-2.md, replaces 1.43's waves): an autopilot
  // plays a build-up (the baseline) from three choices, Style, Level and
  // Pace, and the user only steers: Level, three moves (Edge, Hold, Cool
  // down) and a launch pad of short flavours that take over for their length
  // and glide back to the baseline. It only changes what the existing manual
  // message carries (patternOverride: the pattern it plays now; ceilOverride:
  // the strength), so every buzz still goes through the backend's manual path:
  // scalar steps, the beat shape's 4-a-second cap, VIBE_MIN_INTERVAL_MS and
  // the deadman are the backend's. It never starts the toy (Manual must be on
  // and this tab must drive), and it is not a stop path: turning it off hands
  // back to the pattern as it was, a manual stop ends it. Its state is page
  // state (learning included, fresh each session); its settings ride in the
  // preset store as `goon2`.
  const SLOT_COUNT        = 4;
  const DEFAULT_SLOTS     = ["Goon 1 - Easy", "Goon 2 - Medium", "Goon 3 - Hard", "Goon 4 - Brutal"];
  const GOON_TICK_MS      = 250;
  const GOON_UP_PER_S     = 4;     // % points a second: the baseline, Edge and the return from a pad
  const GOON_PAD_UP_PER_S = 8;     // a pad's entry only, so a 5 s burst can be felt
  const GOON_DOWN_PER_S   = 12;    // falling is the safe way; pads, Cool down and pauses drop at once
  const GOON_SEND_MS      = 500;   // manual messages at most twice a second (plus pattern changes)
  const GOON_MIN_CHANGE   = 0.5;   // % points; smaller changes are not sent
  const GOON_WHEEL_MS     = 150;   // one wheel step at most this often
  const GOON_WHEEL_UNIT   = 50;    // px of wheel for one step (a notch is ~100)
  const G2_PLAN_S         = 75;    // the autopilot always has at least this much planned
  const G2_PAST_S         = 90;    // the big graph's past (kept for the history it keeps)
  const G2_DECK_PAST_S    = 40;    // 1.50: what the deck's graph shows of it
  const G2_EDGE_MAX_S     = 90;    // an Edge releases by itself after this long
  const G2_FLOOR          = 10;    // nothing sounds below this (%): under it is off, never micro pulsing
  const G2_PAD_GAP_MS     = 300;   // one pad start per 300 ms at most
  const G2_DOUBLE_MS      = 350;   // a second press of the same pad this soon latches it
  const G2_PACE_UP_MAX    = 3;     // Pace raises the level at most this far above the start
  const G2_BPM_MAX        = 240;
  const G2_MAX_HITS       = 4;     // pulses a second, anywhere (8 BLE commands)
  const PAD_MIN = 1, PAD_MAX = 8, PAD_DEFAULT = 4;
  const G2_STYLES = [
    ["climb",     "Steady climb",  "Climbs, edges, eases off, climbs higher."],
    ["waves",     "Waves",         "Long smooth waves of changing length."],
    ["rhythm",    "Rhythm",        "Beat rounds, faster each round, rests between."],
    ["tease",     "Tease",         "Stop-start: up to the edge, pause, again."],
    ["coaster",   "Rollercoaster", "A mix of everything, never the same twice."],
    ["endurance", "Endurance",     "A long plateau near your level, rare edges."],
  ];
  // [id, label, minutes per level]
  const G2_PACES = [["slow", "Slow", 6], ["normal", "Normal", 4], ["fast", "Fast", 2]];
  // 1.50: the floating pad's head names the style in a word
  const G2_STYLE_SHORT = { climb: "Climb", waves: "Waves", rhythm: "Rhythm", tease: "Tease", coaster: "Coaster", endurance: "Endurance" };
  // [id, label, BPM, share of the peak]
  const G2_TIERS = [["slow", "Slow", 70, 0.75], ["medium", "Medium", 110, 0.8], ["fast", "Fast", 150, 0.85], ["frenzy", "Frenzy", 200, 0.9]];
  const G2_STAGE_NAMES = { lead: "Lead-in", warm: "Warm-up", climb: "Climb", plateau: "Plateau", rhythm: "Rhythm",
    tclimb: "Tease", edge: "Edge", pause: "Pause", cool: "Cool-down", rest: "Rest", surge: "Surge", rise: "Wave up", fall: "Wave down" };
  const G2_STAGE_HUE = { lead: "grey", warm: "bl", climb: "cy", plateau: "cy", rhythm: "cy", tclimb: "ye", edge: "or",
    pause: "grey", cool: "grey", rest: "grey", surge: "or", rise: "cy", fall: "bl" };
  // stages a Cool down "during a climb" teaches from (section 7, rule 1)
  const G2_CLIMBS = ["lead", "warm", "climb", "rise", "tclimb", "surge", "edge", "rhythm"];
  // The launch pad's built-in flavours. gain(t, len) times the baseline's
  // strength; 0 is off. The rhythms stay at or under 4 pulses a second.
  const G2_FLAVOURS = {
    pulse:   { name: "Pulse burst", len: 5,  hue: "cy", pat: { shape: "pulse", period: 0.25, onMs: 120 }, gain: () => 1.1 },
    heart:   { name: "Heartbeat",   len: 8,  hue: "ma", pat: { shape: "beat", bpm: 70, div: 4, steps: "xx..", onMs: 100 }, gain: () => 1.0 },
    stutter: { name: "Stutter",     len: 6,  hue: "pu", pat: { shape: "beat", bpm: 150, div: 2, steps: "xx.xxx.x", onMs: 100, drop: 25 }, gain: () => 1.0 },
    // 1.47: the swell, Tease stop and Surge were a wave and two steady
    // levels (continuous output); now buzzes with silence between them
    swell:   { name: "Wave swell",  len: 10, hue: "bl", pat: { shape: "buzz", onFromMs: 250, onMs: 700, gapMs: 260, varyAmp: 15, varyGap: 40 },
               gain: (t, len) => 1 + 0.2 * Math.sin(Math.PI * Math.max(0, Math.min(1, t / len))) },
    fast:    { name: "Fast rhythm", len: 8,  hue: "gr", pat: { shape: "pulse", period: 0.3, onMs: 135 }, gain: () => 1.1 },
    tstop:   { name: "Tease stop",  len: 6,  hue: "ye", pat: { shape: "buzz", onFromMs: 120, onMs: 300, gapMs: 180, varyAmp: 10, varyGap: 30, taps: 20 },
               gain: (t) => (t < 4 ? 0.7 + 0.45 * t / 4 : 0) },
    surge:   { name: "Surge",       len: 5,  hue: "or", pat: { shape: "buzz", onFromMs: 500, onMs: 900, gapMs: 170, varyAmp: 8, varyGap: 20 }, gain: () => 1.3 },
  };
  const G2_FLAVOUR_IDS = ["pulse", "heart", "stutter", "swell", "fast", "tstop", "surge"];
  // pad 8's default is the first quick slot's preset (Pulse burst without one)
  const G2_PAD_DEFAULTS = ["pulse", "heart", "fast", "surge", "stutter", "swell", "tstop", "slot"];
  const G2_PRESET_LENS = [6, 12, 20, 30];
  // 1.47: Goon plays buzzes with silence between them, always (the user's
  // Gush 2 test of 1.46: "it is constantly vibrating"; its waves and steady
  // stages never went quiet). Built on the user's own rhythm: the preset
  // chosen as Goon's base (by default their "Build up") gives the cycle and
  // the buzz length range; a stage only says how many buzzes a cycle, how
  // long against that range, how varied, how often a double or triple tap
  // or a longer silence. The backend's buzz shape draws each buzz (seeded)
  // and keeps the BLE budget. Rhythm rounds stay pulse and beat: those are
  // off between hits too.
  const G2_BASE_NAME    = "Build up";
  const G2_BASE_TIDAL   = "builtin:tidal";   // 1.49: goon2.base for the built-in Tidal (not a preset name)
  const G2_TIDAL_LABEL  = "Tidal (built in)";
  const G2_BASE_DEFAULT = { name: "", cycle: 6, lo: 100, hi: 280 };   // the user's Build up: a buzz every 6 s, 80 (held to 100) to 280 ms
  const G2_BUZZ_MIN_MS  = 100;     // the backend's BUZZ_MIN_ON_MS
  const G2_BUZZ_MAX_MS  = 2000;    // BUZZ_MAX_ON_MS: never solid
  const G2_BUZZ_GAP_MS  = 150;     // BUZZ_MIN_GAP_MS: the shortest silence
  // n buzzes per base cycle; lo / hi times the base's shortest and longest
  // buzz; amp strength variety (%), vg gap variety (%: 100 = 0.6-2.5x the
  // base gap); taps and longs: chances (%) of a double / triple tap and of a
  // longer silence. Edge: fast, long, strong, short gaps (still gaps);
  // Cool down: sparse light taps, long silences.
  const G2_BUZZ_SPECS = {
    lead:     { n: 1.5, lo: 1,   hi: 1.2, amp: 25, vg: 70,  taps: 10, longs: 5 },
    warm:     { n: 1.2, lo: 1,   hi: 1,   amp: 30, vg: 80,  taps: 10, longs: 10 },
    climb:    { n: 2,   lo: 1.2, hi: 1.6, amp: 25, vg: 70,  taps: 15, longs: 8 },
    climbS:   { n: 1.8, lo: 1.5, hi: 2.2, amp: 30, vg: 50,  taps: 5,  longs: 5 },
    plateau:  { n: 2.5, lo: 1.3, hi: 1.8, amp: 20, vg: 60,  taps: 20, longs: 10 },
    plateauS: { n: 2.2, lo: 1.6, hi: 2.4, amp: 30, vg: 50,  taps: 10, longs: 8 },
    plateauR: { n: 2.8, lo: 1,   hi: 2,   amp: 40, vg: 100, taps: 25, longs: 15 },
    rise:     { n: 2.2, lo: 1.2, hi: 1.8, amp: 25, vg: 60,  taps: 15, longs: 5 },
    fall:     { n: 1.4, lo: 1,   hi: 1.3, amp: 30, vg: 80,  taps: 10, longs: 15 },
    tclimb:   { n: 1.6, lo: 1,   hi: 1.5, amp: 20, vg: 90,  taps: 10, longs: 20 },
    edge:     { n: 7,   lo: 1.8, hi: 3,   amp: 10, vg: 40,  taps: 0,  longs: 0 },
    edgeP:    { n: 9,   lo: 1.2, hi: 2,   amp: 10, vg: 30,  taps: 0,  longs: 0 },
    surge:    { n: 5,   lo: 2,   hi: 3,   amp: 10, vg: 30,  taps: 0,  longs: 0 },
    cool:     { n: 0.9, lo: 0.8, hi: 1,   amp: 35, vg: 80,  taps: 10, longs: 25 },
    rest:     { n: 0.8, lo: 0.8, hi: 1.1, amp: 30, vg: 80,  taps: 10, longs: 20 },
    pause:    { n: 0.5, lo: 1,   hi: 1,   amp: 0,  vg: 0,   taps: 0,  longs: 0 },
  };
  // Alt+letter while Goon mode runs. Free in Stash, Quick Tools, Lockdown,
  // Ratings Toolkit and Performers Toolkit (plain keys or a bare Alt) and in
  // Chrome, Edge and Firefox on Windows. Not Alt+E (Chrome and Edge open
  // their menu, Firefox its Edit menu), not Alt+S (Firefox History).
  const GOON_KEYS = { w: "edge", a: "hold", q: "cool" };
  const GOON_KEY_LABEL = { edge: "Alt+W", hold: "Alt+A", cool: "Alt+Q" };
  // 1.50: the moves' and End Goon's words for their tooltips (the keys live
  // there, not on the buttons)
  const G2_MOVE_TIPS = {
    edge: `Edge (Alt+W): up to your peak and held there; press again to let go (by itself after ${G2_EDGE_MAX_S} s).`,
    hold: "Hold (Alt+A): keep the level where it is; press again to go on.",
    cool: "Cool down (Alt+Q): down to a rest, then it climbs again. Teaches Goon where your peaks are.",
  };
  const GOON_END_TIP = "End Goon: back to the Manual pattern as it was. Not a stop: Stop (0) stops everything.";
  // 1.50: one level control, the same on the floating pad and in the deck:
  // a stepper around ten small dots, the number and what reaches the motor.
  // attr/down/up: the steppers' own data attribute and values (the pad's
  // data-goon, the deck's data-dk), so each keeps its own click handler.
  function levelDots() {
    let h = "";
    for (let n = 1; n <= 10; n++) h += `<button type="button" data-lv="${n}" aria-label="Level ${n}" title="Level ${n}"><i></i></button>`;
    return h;
  }
  function levelControl(cls, attr, down, up) {
    const P = PLUGIN_ID;
    return `<div class="${P}-lvctl ${cls}" role="group" aria-label="Goon level">` +
      `<button type="button" class="${P}-lvstep" ${attr}="${down}" aria-label="Level down" title="Level down ([ or Alt + wheel)" aria-keyshortcuts="[">−</button>` +
      `<span class="${P}-lvdots">${levelDots()}</span>` +
      `<button type="button" class="${P}-lvstep" ${attr}="${up}" aria-label="Level up" title="Level up (] or Alt + wheel)" aria-keyshortcuts="]">+</button>` +
      `<span class="${P}-lvnum"><b></b><small></small></span></div>`;
  }
  // Lights the dots up to the level (the level itself solid).
  function paintLevel(root, level, pct, startLevel) {
    if (!root) return;
    root.querySelectorAll("[data-lv]").forEach((b) => {
      const n = +b.dataset.lv;
      b.classList.toggle("is-on", n === level);
      b.classList.toggle("is-below", n < level);
      b.classList.toggle("is-start", n === startLevel && n !== level);
      b.setAttribute("aria-pressed", n === level ? "true" : "false");
    });
    const num = root.querySelector(`.${PLUGIN_ID}-lvnum`);
    if (num) {
      const b = num.querySelector("b"), sm = num.querySelector("small");
      if (b) b.textContent = String(level);
      if (sm) sm.textContent = `${pct}%`;
      num.title = `Level ${level} of 10: ${pct}% reaches the motor now.`;
    }
  }

  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smoothStep = (f) => { f = clampN(f, 0, 1); return f * f * (3 - 2 * f); };
  const mmss = (sec) => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; };

  // The slot names: the store's own, else the Goon presets by their names
  // (exactly, or the first whose name starts "Goon N"), else empty.
  function slotNames(store) {
    const s = store && Array.isArray(store.slots) ? store.slots : null;
    const names = (store && Array.isArray(store.presets) ? store.presets : []).map((p) => p && p.name);
    const out = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (s) { out.push(typeof s[i] === "string" && s[i] ? s[i] : null); continue; }
      const exact = names.includes(DEFAULT_SLOTS[i]) ? DEFAULT_SLOTS[i] : null;
      out.push(exact || names.find((n) => typeof n === "string" && n.startsWith(`Goon ${i + 1}`)) || null);
    }
    return out;
  }
  // A new store with slot i set (null empties it). Everything else rides
  // through untouched, including whatever an older or newer page stored.
  function setSlot(store, i, name) {
    if (i < 0 || i >= SLOT_COUNT) return store;
    const slots = slotNames(store).slice();
    slots[i] = name || null;
    const extra = Array.isArray(store.slots) ? store.slots.slice(SLOT_COUNT) : [];
    return { ...store, slots: slots.concat(extra) };
  }
  // Rename follows into the slots and the pads; delete empties a slot and
  // gives a pad its default flavour back.
  function renameInSlots(store, from, to) {
    let out = store;
    if (Array.isArray(store.slots) && store.slots.includes(from)) {
      out = { ...out, slots: store.slots.map((n) => (n === from ? (to || null) : n)) };
    }
    const g = store.goon2;
    if (g && Array.isArray(g.pads) && g.pads.some((e) => e && e.preset === from)) {
      out = { ...out, goon2: { ...g, pads: g.pads.map((e) => (e && e.preset === from ? (to ? { ...e, preset: to } : null) : e)) } };
    }
    // 1.47: and into Goon's base (deleted: back to the default)
    if (g && g.base === from) out = { ...out, goon2: { ...(out.goon2 || g), base: to || null } };
    return out;
  }
  function slotPreset(store, i) {
    const n = slotNames(store)[i];
    return n ? (store.presets || []).find((p) => p.name === n) || null : null;
  }
  // 1.46: the quick slots are the first four preset cards (Alt+1..4). The
  // 1.43 `slots` list becomes the cards' order once (cardOrder marks it),
  // the slot presets first in slot order, every other preset after them as
  // it was. From then on `slots` is kept equal to the first four names, so
  // a 1.45 page still open somewhere finds the same presets on Alt+1..4;
  // entries past the fourth ride through (rule 5). Pure, tested.
  function slotsToOrder(store) {
    if (!store || !Array.isArray(store.presets) || store.cardOrder) return store;
    const first = [];
    slotNames(store).forEach((n) => {
      const p = n ? store.presets.find((x) => x.name === n) : null;
      if (p && !first.includes(p)) first.push(p);
    });
    return syncSlots({ ...store, presets: first.concat(store.presets.filter((p) => !first.includes(p))), cardOrder: 1 });
  }
  function syncSlots(store) {
    if (!store || !store.cardOrder || !Array.isArray(store.presets)) return store;
    const extra = Array.isArray(store.slots) ? store.slots.slice(SLOT_COUNT) : [];
    const first = [];
    for (let i = 0; i < SLOT_COUNT; i++) first.push(store.presets[i] ? store.presets[i].name : null);
    return { ...store, slots: first.concat(extra) };
  }
  // A new store with card `from` moved to `to` (drag, Shift+arrow, Alt+Shift+N).
  function movePreset(store, from, to) {
    const n = store && Array.isArray(store.presets) ? store.presets.length : 0;
    if (from < 0 || from >= n) return store;
    to = clampN(Math.round(to), 0, n - 1);
    if (from === to) return store;
    const presets = store.presets.slice();
    const [p] = presets.splice(from, 1);
    presets.splice(to, 0, p);
    return syncSlots({ ...store, cardOrder: 1, presets });
  }
  function cardPreset(store, i) { return ((store && store.presets) || [])[i] || null; }

  // ── Goon mode 2: settings ──
  // { style, level (where it starts), pace, padCount, pads: [entry per pad] }.
  // A pad entry is { f: flavour id } or { preset: name, len }; a missing or
  // unusable one is the pad's default. Unknown fields (and pads past the
  // eighth) ride through (rule 5).
  function cleanGoon2(g) {
    const src = g && typeof g === "object" ? g : {};
    const n = (v) => (typeof v === "number" && isFinite(v) ? v : NaN);
    const lvl = n(src.level), pc = n(src.padCount);
    return { ...src,
      style:    G2_STYLES.some((s) => s[0] === src.style) ? src.style : "climb",
      level:    isFinite(lvl) ? Math.round(clampN(lvl, 1, 10)) : 3,
      pace:     G2_PACES.some((p) => p[0] === src.pace) ? src.pace : "normal",
      padCount: isFinite(pc) ? Math.round(clampN(pc, PAD_MIN, PAD_MAX)) : PAD_DEFAULT,
      pads:     Array.isArray(src.pads) ? src.pads.slice() : [],
      // 1.47: the preset Goon is built on (null: "Build up", else the first Tease)
      base:     typeof src.base === "string" && src.base ? src.base : null,
    };
  }
  // The preset Goon is built on: { name, cycle (s), lo, hi (ms), gone }.
  // set.base names it; without one, "Build up", else the first Tease
  // preset; without either, or when the named one is gone or is not a
  // Tease or Pulse, the built-in Build up timing (gone names the missing one).
  // 1.49: a Tidal preset too, and the built-in Tidal (base G2_BASE_TIDAL),
  // which carries its phrases (tide) into every stage
  const g2BaseUsable = (p) => !!p && (p.shape === "tease" || p.shape === "pulse" || p.shape === "tidal");
  function g2BaseList(store) {
    return ((store && store.presets) || []).filter(g2BaseUsable).map((p) => p.name);
  }
  function g2TidalRhythm(name, p) {
    const w = tidalWire(p || TIDAL, 1);
    return { name, cycle: clampN(Number((p || TIDAL).period) || TIDAL.period, 2, 20), lo: w.onFromMs, hi: w.onMs, gone: "",
             tide: { phraseMin: TIDAL.phraseMin, phraseMax: TIDAL.phraseMax, accent: TIDAL.accent, hold: TIDAL.hold,
                     breathS: TIDAL.breathS, longs: TIDAL.longs } };
  }
  function g2BaseRhythm(set, store) {
    const presets = (store && Array.isArray(store.presets)) ? store.presets : [];
    const want = set && typeof set.base === "string" && set.base ? set.base : null;
    if (want === G2_BASE_TIDAL) return g2TidalRhythm(G2_TIDAL_LABEL, null);
    const p = want ? presets.find((x) => x.name === want)
      : presets.find((x) => x.name === G2_BASE_NAME && g2BaseUsable(x)) || presets.find((x) => x.shape === "tease");
    if (!g2BaseUsable(p)) return { ...G2_BASE_DEFAULT, gone: want || "" };
    if (p.shape === "tidal") return g2TidalRhythm(p.name, cleanPattern(p));
    const c = cleanPattern(p);
    const hi = clampN(c.onMs, G2_BUZZ_MIN_MS, G2_BUZZ_MAX_MS);
    // a Tease with a length build-up grows from its starting length: that is
    // the range; without one (or a Pulse) the buzzes vary from 60% up
    const lo = c.shape === "tease" && c.build > 0 ? clampN(c.onFromMs, G2_BUZZ_MIN_MS, hi) : clampN(Math.round(hi * 0.6), G2_BUZZ_MIN_MS, hi);
    return { name: p.name, cycle: clampN(c.period, 1.5, 20), lo, hi, gone: "" };
  }
  // A stage's buzz pattern on the base rhythm at level L (pure). Higher
  // levels play a few more and slightly longer buzzes (level 1: 0.89x as
  // many, level 10: 1.2x); the strength is the level's own (the ceiling).
  function g2BuzzPattern(spec, rhy, L, seed) {
    const r = rhy || G2_BASE_DEFAULT, sp = spec || G2_BUZZ_SPECS.plateau;
    const lv = clampN(Math.round(Number(L) || 3), 1, 10);
    const rate = 0.85 + 0.035 * lv, grow = 0.9 + 0.025 * lv;
    const lo = Math.round(clampN(r.lo * sp.lo * grow, G2_BUZZ_MIN_MS, G2_BUZZ_MAX_MS));
    const hi = Math.round(clampN(r.hi * sp.hi * grow, lo, G2_BUZZ_MAX_MS));
    const per = r.cycle * 1000 / (sp.n * rate);           // ms from one buzz start to the next, on average
    const sd = Math.round(clampN(Number(seed) || 1, 1, 2147483646));
    // 1.49: a Tidal base plays phrases in every stage (a pause aside): the
    // same buzzes a cycle, grouped; the gap is then the one between phrases.
    // Edge and Surge play longer phrases with more accents; no long
    // silences where the stage has none (Edge, Surge), fewer holds resting.
    const t = r.tide;
    if (t && sp.n > 0.5) {
      const hard = sp.longs === 0;
      const pmin = hard ? Math.min(6, t.phraseMin + 1) : t.phraseMin, pmax = hard ? Math.min(6, t.phraseMax + 1) : t.phraseMax;
      const k = (pmin + pmax) / 2, inner = (TIDAL_INNER_MS[0] + TIDAL_INNER_MS[1]) / 2;
      const gapP = Math.round(clampN((k * per - k * (lo + hi) / 2 - (k - 1) * inner) / (1 + 0.55 * sp.vg / 100), G2_BUZZ_GAP_MS, 60000));
      return { shape: "buzz", period: r.cycle, onFromMs: lo, onMs: hi, gapMs: gapP, varyAmp: sp.amp, varyGap: sp.vg,
               taps: 0, longs: hard ? 0 : Math.max(sp.longs, t.longs), seed: sd, depth: 0,
               phraseMin: pmin, phraseMax: pmax, accent: hard ? Math.min(50, t.accent + 15) : t.accent,
               hold: sp.n < 1 ? Math.round(t.hold / 2) : t.hold, breathS: t.breathS };
    }
    const gap = Math.round(clampN((per - (lo + hi) / 2) / (1 + 0.55 * sp.vg / 100), G2_BUZZ_GAP_MS, 60000));
    return { shape: "buzz", period: r.cycle, onFromMs: lo, onMs: hi, gapMs: gap, varyAmp: sp.amp, varyGap: sp.vg,
             taps: sp.taps, longs: sp.longs, seed: sd, depth: 0 };
  }
  // One line on what the base gives Goon (pure).
  function g2BaseNote(rhy) {
    const r = rhy || G2_BASE_DEFAULT;
    if (r.tide) return `${r.name}: phrases of ${r.tide.phraseMin} to ${r.tide.phraseMax} buzzes, ${fmtSecs(r.lo / 1000)} to ${fmtSecs(r.hi / 1000)}, ` +
      `about one phrase every ${fmtSecs(r.cycle)}, breathing over ${r.tide.breathS} s, with accents, holds and long silences. ` +
      "Goon builds them up with silence between every buzz.";
    const who = r.gone ? `${r.gone} is gone (or not a Tease or Pulse): the built-in Build up timing` : r.name ? r.name : "The built-in Build up timing";
    return `${who}: ${fmtSecs(r.lo / 1000)} to ${fmtSecs(r.hi / 1000)} buzzes, one every ${fmtSecs(r.cycle)}. ` +
           "Goon builds them up (more of them, longer, stronger) with silence between every buzz.";
  }
  // A seed per stage, move or pad, from the session's own (pure).
  function g2SeedFor(st, salt, t) {
    return 1 + Math.abs(Math.round((Number(st && st.seed0) || 1) * 7919 + salt * 104729 + (Number(t) || 0) * 10)) % 2147483640;
  }
  function g2PadEntry(set, store, i) {
    const e = set && Array.isArray(set.pads) ? set.pads[i] : null;
    if (e && typeof e === "object") {
      if (typeof e.preset === "string" && e.preset) return { kind: "preset", name: e.preset, len: Math.round(clampN(Number(e.len) || 12, 3, 60)) };
      if (G2_FLAVOURS[e.f]) return { kind: "flavour", id: e.f };
    }
    const d = G2_PAD_DEFAULTS[i] || "pulse";
    if (d === "slot") {
      const name = slotNames(store)[0];
      if (name && ((store && store.presets) || []).some((p) => p.name === name)) return { kind: "preset", name, len: 12, auto: true };
      return { kind: "flavour", id: "pulse" };
    }
    return { kind: "flavour", id: d };
  }
  // What pad i plays: { i, name, hue, len, pat, gain, limit, preset?, gone? }
  function g2PadInfo(set, store, i) {
    const e = g2PadEntry(set, store, i);
    if (e.kind === "preset") {
      const p = ((store && store.presets) || []).find((x) => x.name === e.name);
      if (p) {
        const c = cleanPattern(p);
        return { i, kind: "preset", name: p.name, hue: "grey", len: e.len, pat: c, gain: () => 1, limit: c.ceiling, preset: p.name };
      }
      const d = G2_PAD_DEFAULTS[i] === "slot" || !G2_PAD_DEFAULTS[i] ? "pulse" : G2_PAD_DEFAULTS[i];
      return { ...g2FlavourInfo(i, d), gone: e.name };
    }
    return g2FlavourInfo(i, e.id);
  }
  function g2FlavourInfo(i, id) {
    const f = G2_FLAVOURS[id] || G2_FLAVOURS.pulse;
    return { i, kind: "flavour", id, name: f.name, hue: f.hue, len: f.len, pat: cleanPattern(f.pat), gain: f.gain, limit: 100 };
  }
  // A new settings object with pad i set (null: back to its default).
  function g2SetPad(set, i, entry) {
    if (i < 0 || i >= PAD_MAX) return set;
    const pads = (Array.isArray(set.pads) ? set.pads : []).slice();
    while (pads.length <= i) pads.push(null);
    pads[i] = entry ? { ...(pads[i] && typeof pads[i] === "object" ? pads[i] : {}), ...entry } : null;
    if (entry && entry.f) delete pads[i].preset;
    if (entry && entry.preset) delete pads[i].f;
    return { ...set, pads };
  }

  // ── Goon mode 2: the autopilot (pure; the page calls g2Step every tick) ──
  // Level L gives the working peak P(L) = round(PowerLimit * L / 10), under
  // the learned cap; rest R = max(10, 30% of P). Stage strengths are kept as
  // shares of P ("R" is the rest, "R+" ten above it), so a level change
  // moves everything at once.
  function g2Peak(level, limit, cap) {
    const L = clampN(Math.round(Number(level) || 1), 1, 10), lim = clampN(Number(limit) || 100, 1, 100);
    let P = Math.round(lim * L / 10);
    if (cap != null) P = Math.min(P, cap);
    return Math.max(1, P);
  }
  const g2Rest = (P) => Math.min(P, Math.max(G2_FLOOR, Math.round(0.3 * P)));
  function g2Frac(v, P, R) {
    if (v === "R") return R;
    if (v === "R+") return Math.min(P, R + 10);
    return clampN(Number(v) || 0, 0, 1.3) * P;
  }
  function g2Rnd(s) { s.seed = (s.seed * 1103515245 + 12345) % 2147483648; return s.seed / 2147483648; }
  const g2Between = (s, a, b) => a + (b - a) * g2Rnd(s);
  function g2Learn0() { return { cap: null, slow: 1, tierDown: {}, cools: {}, padGain: {}, why: {} }; }
  function g2Copy(st) {
    const l = st.learn || g2Learn0();
    return { ...st, gen: { ...st.gen }, plan: st.plan.slice(),
      learn: { ...l, tierDown: { ...l.tierDown }, cools: { ...l.cools }, padGain: { ...l.padGain }, why: { ...l.why } },
      move: st.move ? { ...st.move } : null, pad: st.pad ? { ...st.pad } : null };
  }
  function g2Ctx(st, lim) {
    const limit = clampN(Number(lim && lim.limit) || 100, 1, 100);
    const P = g2Peak(st.L, limit, st.learn.cap), R = g2Rest(P);
    return { P, R, limit, top: Math.min(limit, st.learn.cap != null ? st.learn.cap : 100) };
  }
  const g2PlanEnd = (s) => { const l = s.plan[s.plan.length - 1]; return l ? l.t0 + l.dur : s.t; };
  function g2StageAt(s, t) {
    for (let i = 0; i < s.plan.length; i++) { const g = s.plan[i]; if (t >= g.t0 && t < g.t0 + g.dur) return i; }
    return s.plan.length - 1;
  }
  // The rhythm tier a stage plays, one lower once learning says so.
  const g2Tier = (sg, learn) => Math.max(0, (sg.tier || 0) - (learn && learn.tierDown[sg.tier || 0] ? 1 : 0));
  function g2StageLabel(sg, learn) {
    if (sg.k === "rhythm") return `Rhythm · ${G2_TIERS[g2Tier(sg, learn)][1].toLowerCase()}`;
    return G2_STAGE_NAMES[sg.k] || sg.k;
  }

  // The next stage of a style (section 10.2). Never the same stage twice in
  // a row; an Edge is always followed by a Cool-down or a Pause.
  function g2Next(set, s) {
    const prev = s.plan[s.plan.length - 1];
    const t0 = prev ? prev.t0 + prev.dur : s.t;
    const g = s.gen; g.n += 1;
    const R = (a, b) => g2Between(s, a, b);
    const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(g2Rnd(s) * arr.length))];
    const slow = s.learn.slow || 1;
    const last = prev ? prev.k : "";
    const mk = (k, v, dur, fb, extra) => ({ k, v: v || "", t0, dur: Math.max(3, Math.round(dur)), fa: prev ? prev.fb : 0.5, fb, ...(extra || {}) });
    const edge = (a, b) => { g.lastEdge = t0; return mk("edge", pick(["const", "pulse"]), R(a, b), 1); };
    const st = set.style;
    if (st === "waves") {
      if (last === "rise") {
        if (g.waves % 4 === 0) return edge(15, 25);
        return mk("fall", pick(["const", "wave"]), g.pairLen / 2, pick([R(0.3, 0.5), "R"]));
      }
      if (last === "edge") return mk("cool", "", R(20, 40), "R+");
      let len = 0;
      for (let tries = 0; tries < 12; tries++) { len = Math.round(R(40, 120)); if (Math.abs(len - (g.pairLen || 0)) >= 10) break; }
      g.pairLen = len; g.waves += 1;
      return mk("rise", pick(["const", "wave"]), len / 2 * slow, R(0.7, 1.0));
    }
    if (st === "rhythm") {
      if (last === "rhythm") return prev.tier >= 2 ? edge(15, 20) : mk("rest", "", R(30, 60), "R");
      if (last === "edge") return mk("cool", "", R(30, 45), "R");
      if (last === "tclimb") return mk("rest", "", R(30, 60), "R");
      g.round += 1;
      if (g.round % 4 === 3) return mk("tclimb", "", R(60, 90) * slow, 0.95, { fa: 0.5 });
      const rr = g.rr; g.rr += 1;
      const tier = rr < 4 ? rr : 1 + ((rr - 4) % 3);
      if (rr >= 4 && tier === 1) g.bump = Math.min(0.1, g.bump + 0.05);   // back to Medium with the level up
      const vs = tier === 0 ? ["straight", "accent", "heart", "gallop"] : tier === 3 ? ["straight", "accent"] : ["straight", "accent", "gallop"];
      return mk("rhythm", pick(vs), R(90, 150), Math.min(1, G2_TIERS[tier][3] + g.bump), { tier });
    }
    if (st === "tease") {
      if (last === "tclimb") return edge(10, 20);
      if (last === "edge") return mk("pause", "", R(20, 40), 0);
      if (last === "pause" && g.cycles >= g.coolEvery) { g.cycles = 0; g.coolEvery = pick([4, 5]); return mk("cool", "", 60, "R"); }
      g.cycles += 1;
      return mk("tclimb", "", R(40, 70) * slow, 0.95, { fa: 0.5 });
    }
    if (st === "coaster") {
      if (last === "edge") return mk("cool", "", R(20, 40), "R+");
      if (g.n > 2 && t0 - g.lastEdge >= 120 && !["cool", "pause", "lead", "warm"].includes(last) && g2Rnd(s) < 0.3) return edge(15, 25);
      const k = pick(["rhythm", "climb", "plateau", "surge", "rise", "tclimb"].filter((x) => x !== last));
      const top = R(0.5, 1.0);
      if (k === "rhythm") {
        const tier = pick([0, 1, 2, 3]);
        return mk("rhythm", pick(tier === 0 ? ["straight", "accent", "heart"] : tier === 3 ? ["straight", "accent"] : ["straight", "gallop"]),
                  R(60, 120), Math.max(top, G2_TIERS[tier][3] - 0.1), { tier });
      }
      if (k === "climb") return mk("climb", pick(["const", "wave"]), R(40, 90) * slow, top);
      if (k === "plateau") return mk("plateau", pick(["const", "wave", "rand"]), R(20, 40), top);
      if (k === "surge") { const a = prev ? prev.fb : 0.6; return mk("surge", "", 8, a, { fa: a }); }
      if (k === "rise") return mk("rise", pick(["const", "wave"]), R(30, 60) * slow, top);
      return mk("tclimb", "", R(40, 60) * slow, 0.95, { fa: 0.5 });
    }
    if (st === "endurance") {
      if (last === "edge") return mk("cool", "", R(30, 45), 0.75);
      if (last === "plateau") {
        if (t0 - g.lastEdge >= 360) return edge(15, 25);
        g.bump = Math.min(0.12, g.bump + 0.03);
        return mk("climb", "const", R(20, 40) * slow, Math.min(1, (typeof prev.fb === "number" ? prev.fb : 0.85) + 0.05));
      }
      return mk("plateau", pick(["const", "wave", "rand"]), R(120, 240), Math.min(1, 0.85 + g.bump));
    }
    // Steady climb (the 1.43 waves, improved)
    if (last === "climb") return mk("plateau", pick(["const", "wave", "rand"]), R(20, 40), prev.fb);
    if (last === "plateau") {
      if (g.climbs >= g.edgeEvery) { g.climbs = 0; g.edgeEvery = pick([2, 3]); return edge(15, 25); }
      return mk("cool", "", R(30, 45), "R+");
    }
    if (last === "edge") return mk("cool", "", R(30, 45), "R+");
    g.climbs += 1; g.tops += 1;
    return mk("climb", pick(["const", "wave"]), R(60, 120) * slow, Math.min(1, R(0.85, 0.95) + 0.02 * g.tops));
  }
  // Keep at least G2_PLAN_S planned, and the two stages after this one for
  // "coming up"; forget what the graph no longer shows.
  function g2Extend(set, s) {
    const ahead = () => s.plan.length - 1 - g2StageAt(s, s.t);
    for (let guard = 0; guard < 60 && (g2PlanEnd(s) - s.t < G2_PLAN_S || ahead() < 2); guard++) s.plan.push(g2Next(set, s));
    while (s.plan.length > 2 && s.plan[0].t0 + s.plan[0].dur < s.t - G2_PAST_S - 10) s.plan.shift();
  }
  // The baseline's strength u seconds into a stage.
  function g2StageValue(sg, u, P, R) {
    const A = g2Frac(sg.fa, P, R), B = g2Frac(sg.fb, P, R);
    const f = sg.dur > 0 ? clampN(u / sg.dur, 0, 1) : 1;
    switch (sg.k) {
      case "warm": case "cool": case "rise": case "fall": return A + (B - A) * smoothStep(f);
      case "climb": {   // one 5-point landing after another
        const n = Math.max(1, Math.ceil(Math.abs(B - A) / 5));
        return A + (B - A) * Math.min(n, Math.floor(f * n) + 1) / n;
      }
      case "tclimb": return A + (B - A) * f;
      case "surge": return u >= 2 && u < 5 ? Math.min(P, A * 1.3) : A;
      case "pause": return 0;
      default: return B;      // lead, plateau, rhythm, edge, rest
    }
  }
  // A rhythm as Manual's patterns: Straight is pulse; Accent, Heartbeat and
  // Gallop are the backend's beat shape. The buzz is 45% of a beat, at least
  // 100 ms and leaving at least 100 ms off.
  function g2RhythmPattern(tier, v) {
    const bpm = Math.min(G2_BPM_MAX, G2_TIERS[clampN(tier, 0, 3)][2]);
    const beat = 60000 / bpm;
    const on = (ms) => Math.round(clampN(0.45 * ms, 100, Math.max(100, ms - 100)));
    if (v === "accent") return { shape: "beat", bpm, div: 1, steps: "Xxxx", onMs: on(beat), beatLow: 85 };
    if (v === "heart")  return { shape: "beat", bpm, div: 4, steps: "xx..", onMs: 100 };
    if (v === "gallop") return { shape: "beat", bpm, div: 2, steps: "x.xX", onMs: on(beat / 2), beatLow: 85 };
    return { shape: "pulse", period: 60 / bpm, onMs: on(beat) };
  }
  // 1.47: every stage but Rhythm is the buzz shape on the base rhythm (rhy,
  // default Build up) at level L; the variants ("wave", "rand") are buzz
  // trains of their own (fewer and longer, or wilder), never a wave. A pause
  // is silent by its strength (0). seed: the stage's (g2SeedFor), else one
  // from its start.
  function g2StagePattern(sg, learn, rhy, L, seed) {
    const sd = seed != null ? seed : 1 + Math.round((sg.t0 || 0) * 10) % 2147483640;
    const bz = (k) => g2BuzzPattern(G2_BUZZ_SPECS[k] || G2_BUZZ_SPECS.plateau, rhy, L, sd);
    switch (sg.k) {
      case "rhythm":  return g2RhythmPattern(g2Tier(sg, learn), sg.v);
      case "climb":   return bz(sg.v === "wave" ? "climbS" : "climb");
      case "plateau": return bz(sg.v === "wave" ? "plateauS" : sg.v === "rand" ? "plateauR" : "plateau");
      case "edge":    return bz(sg.v === "pulse" ? "edgeP" : "edge");
      default:        return bz(sg.k);   // lead, warm, rise, fall, tclimb, cool, rest, surge, pause
    }
  }
  // Worst case pulses in any second for a pattern (no dropout), for the BLE
  // budget: pulse is 1/period; beat walks its steps for eight seconds.
  function g2HitsMax(p) {
    if (!p) return 0;
    p = wireShape(p);           // 1.49: Tidal is a buzz train
    if (p.shape === "pulse") return Math.ceil(1 / p.period - 1e-9);
    // 1.47: buzz starts are at least the shortest buzz plus the shortest
    // silence apart (and the backend never starts more than 4 a second)
    if (p.shape === "buzz") return Math.min(G2_MAX_HITS, Math.ceil(1000 / (Math.max(G2_BUZZ_MIN_MS, p.onFromMs) + G2_BUZZ_GAP_MS) - 1e-9));
    if (p.shape !== "beat") return 0;
    const step = 60 / p.bpm / p.div, starts = [];
    for (let k = 0; k * step < 8; k++) {
      const ch = p.steps[k % p.steps.length];
      if (ch === "x" || ch === "X") starts.push(k * step);
    }
    let worst = 0;
    for (let a = 0; a < starts.length; a++) {
      let n = 0;
      for (let b = a; b < starts.length && starts[b] - starts[a] < 1 - 1e-9; b++) n++;
      worst = Math.max(worst, n);
    }
    return worst;
  }

  // The start. L <= 3 warms up for 60-120 s; L >= 4 skips that: a lead-in
  // climbs from the strength playing now to 0.7 P at the rise rate.
  function g2Init(set, lim, now, seed, rhy) {
    const L = clampN(Math.round(set.level || 3), 1, 10);
    const limit = clampN(Number(lim && lim.limit) || 100, 1, 100);
    const lv = clampN(Number(now) || 0, 0, limit);
    const s = { t: 0, seed: (Math.abs(Math.floor(Number(seed) || 1)) % 2147483646) + 1, L, L0: L, paceT: 0, plan: [],
      gen: { n: 0, climbs: 0, tops: 0, edgeEvery: 2, round: -1, rr: 0, bump: 0, cycles: 0, coolEvery: 4, waves: 0, pairLen: 0, lastEdge: 0 },
      base: lv, out: lv, target: lv, held: false, move: null, pad: null, padAt: -1e12, learn: g2Learn0(),
      cooled: false, curT0: 0, curK: "", dropNow: false, note: "" };
    s.seed0 = s.seed;                       // 1.47: the session's own, for the buzz seeds
    s.rhy = rhy || G2_BASE_DEFAULT;          // 1.47: the base rhythm (g2BaseRhythm)
    const P = g2Peak(L, limit, null);
    if (L <= 3) s.plan.push({ k: "warm", v: "", t0: 0, dur: Math.round(g2Between(s, 60, 120)), fa: "R", fb: 0.5 });
    else s.plan.push({ k: "lead", v: "", t0: 0, dur: Math.max(4, Math.ceil(Math.abs(0.7 * P - lv) / GOON_UP_PER_S) + 2), fa: 0.7, fb: 0.7 });
    s.curK = s.plan[0].k;
    g2Extend(set, s);
    return s;
  }
  function g2Rate(cur, target, up, down) {
    return target > cur ? Math.min(target, cur + up) : Math.max(target, cur - down);
  }
  // One tick: the baseline clock runs on (only Hold stops it) under every
  // override; Pace; the baseline's strength at 4 up / 12 down (0 at once);
  // then the override on top, highest first: Edge / Cool down > a pad > the
  // baseline. s.out is what plays, never above min(Power limit, cap) (and a
  // preset pad's own Power limit).
  function g2Step(set, lim, st, dt) {
    const s = g2Copy(st);
    dt = clampN(Number(dt) || 0, 0, 5);
    s.note = "";
    if (s.held) return s;
    s.t += dt;
    const paceS = (G2_PACES.find((p) => p[0] === set.pace) || G2_PACES[1])[2] * 60;
    if (s.t - s.paceT >= paceS) {
      s.paceT = s.t;
      if (s.L < Math.min(10, s.L0 + G2_PACE_UP_MAX)) { s.L += 1; s.note = "pace"; }
    }
    g2Extend(set, s);
    const sg = s.plan[g2StageAt(s, s.t)];
    if (sg.t0 !== s.curT0) {
      // a climb that went by without a Cool down eases the learned slowness
      if (G2_CLIMBS.includes(s.curK) && !s.cooled && s.learn.slow > 1) s.learn.slow = Math.max(1, s.learn.slow * 0.9);
      s.cooled = false; s.curT0 = sg.t0; s.curK = sg.k;
    }
    const c = g2Ctx(s, lim);
    const drop = s.dropNow; s.dropNow = false;
    const bt = Math.min(c.top, g2StageValue(sg, s.t - sg.t0, c.P, c.R));
    s.base = g2Rate(s.base, bt, GOON_UP_PER_S * dt, bt <= 0 || drop ? Infinity : GOON_DOWN_PER_S * dt);
    let target = s.base, up = GOON_UP_PER_S * dt, down = GOON_DOWN_PER_S * dt, top = c.top;
    if (s.move && s.move.k === "edge") {
      s.move.t += dt;
      if (s.move.t >= G2_EDGE_MAX_S) { s.move = { k: "cool", t: 0, at: s.t, dur: Math.round(g2Between(s, 20, 40)), after: "auto" }; s.note = "edgeAuto"; }
      else target = c.P;
    } else if (s.move && s.move.k === "cool") {
      s.move.t += dt;
      if (s.move.t >= s.move.dur) { s.move = null; s.note = s.note || "coolDone"; }
    }
    if (s.move && s.move.k === "cool") { target = c.R; down = Infinity; }
    if (!s.move && s.pad) {
      const p = s.pad;
      p.t += dt;
      if (p.t >= p.len && !p.held && !p.latch) { s.pad = null; s.note = s.note || "padEnd"; }
      else {
        const ref = Math.max(s.base, c.R);
        const g = p.gain(p.len > 0 ? p.t % p.len : 0, p.len) * (s.learn.padGain[p.i] || 1);
        target = g > 0 ? ref * g : 0;
        up = GOON_PAD_UP_PER_S * dt; down = Infinity;
        top = Math.min(top, p.limit);
      }
    }
    s.target = clampN(target, 0, top);
    s.out = clampN(g2Rate(s.out, s.target, up, drop ? Infinity : down), 0, top);
    return s;
  }
  // What is sent (a ceiling, % of the Power limit's scale): off under half a
  // point, else at least the floor, never above the top. Under the floor is
  // off, never micro pulsing.
  // 1.45: the motor gets ceiling x the intensity slider (mot.m), so up to
  // 1.44 the "10%" floor was 6% at the motor with the slider at 60 and 3% at
  // 30, under a Gush 2's 5% step. The floor is now G2_FLOOR at the motor (and
  // never under the device's own step, mot.step in %): G2_FLOOR / m as a
  // ceiling. When even the top cannot reach the device's step, it is off.
  // Without mot (the tests' plain calls) m is 1 and the floor is G2_FLOOR.
  function g2Sent(out, top, mot) {
    if (!(out >= 0.5)) return 0;
    const m = mot && typeof mot.m === "number" ? clampN(mot.m, 0, 1) : 1;
    const step = mot && typeof mot.step === "number" ? clampN(mot.step, 0, 50) : 0;
    if (!(m > 0)) return 0;
    const v = Math.min(top, Math.max(Math.max(G2_FLOOR, step) / m, out));
    return v * m + 1e-9 < step ? 0 : v;
  }
  // The share of a ceiling that reaches the motor, and the device's step (%).
  // 1.46: the master is held at 100 while Goon runs (masterNow), so all of it.
  function g2Mot() {
    return { m: 1, step: clampN(scalarStep * 100, 0, 50) };
  }
  // The strength and pattern to send for a state (mot: g2Sent's).
  // 1.47: a buzz pattern's strength varies per buzz from the ceiling down
  // by varyAmp, so the ceiling sits varyAmp/2 above the level (never above
  // the top): the buzzes land around the stage's strength. Goon's own
  // patterns never dip (depth 0) and carry the floor (minLevel); a preset
  // on a pad plays as the user made it.
  function g2Finish(pattern, own, mot) {
    const pat = { ...pattern, ceiling: 100 };
    if (!own) {
      pat.depth = 0;
      if (pat.shape === "buzz") pat.minLevel = Math.round(Math.min(100, Math.max(G2_FLOOR, mot && typeof mot.step === "number" ? mot.step : 0)));
    }
    return cleanPattern(pat);
  }
  function g2Output(lim, st, mot) {
    const c = g2Ctx(st, lim);
    const rhy = st.rhy || G2_BASE_DEFAULT;
    let top = c.top, pattern, own = false;
    if (st.move) pattern = g2BuzzPattern(G2_BUZZ_SPECS[st.move.k === "edge" ? "edge" : "cool"], rhy, st.L, g2SeedFor(st, st.move.k === "edge" ? 2 : 3, st.move.at));
    else if (st.pad) {
      pattern = st.pad.pat; top = Math.min(top, st.pad.limit); own = !!st.pad.own;
      if (!own && pattern.shape === "buzz") pattern = { ...pattern, seed: g2SeedFor(st, 4, (Number(st.pad.at) || 0) / 100) };
    } else {
      const sg = st.plan[g2StageAt(st, st.t)];
      pattern = g2StagePattern(sg, st.learn, rhy, st.L, g2SeedFor(st, 1, sg.t0));
    }
    const pat = g2Finish(pattern, own, mot);
    let ceil = g2Sent(st.out, top, mot);
    if (ceil > 0 && pat.shape === "buzz") ceil = Math.min(top, ceil * (1 + pat.varyAmp / 200));
    return { ceil: Math.round(ceil * 10) / 10, pattern: pat };
  }

  // What the user asks for: edge / hold / cool (the moves), level (n),
  // forget (the learning). Wheel and level changes are never learned.
  function g2Event(set, lim, st, kind, arg) {
    const s = g2Copy(st);
    s.note = "";
    const c = g2Ctx(s, lim);
    if (kind === "hold") { s.held = !s.held; return s; }
    if (kind === "forget") { s.learn = g2Learn0(); return s; }
    if (kind === "level") {
      const L = clampN(Math.round(Number(arg) || s.L), 1, 10);
      if (L < s.L) s.dropNow = true;           // down at once, up at the rate limit
      s.L = L; s.paceT = s.t;                   // a user level change resets the Pace timer
      return s;
    }
    s.held = false;
    if (kind === "edge") {
      if (s.move && s.move.k === "edge") {
        // released by the user without a Cool down: the cap may go up
        if (s.learn.cap != null) {
          s.learn.cap = Math.min(c.limit, s.learn.cap + 3);
          s.learn.why.cap = `Peaks capped at ${Math.round(s.learn.cap)}%: up 3 after an Edge you let go of yourself.`;
        }
        s.move = { k: "cool", t: 0, at: s.t, dur: Math.round(g2Between(s, 20, 40)), after: "edge" };
        s.note = "edgeOff";
        return s;
      }
      s.pad = null;
      s.move = { k: "edge", t: 0, at: s.t };
      s.note = "edgeOn";
      return s;
    }
    if (kind === "cool") {
      if (s.move && s.move.k === "cool") { s.move.t = 0; s.note = "cool"; return s; }
      const sg = s.plan[g2StageAt(s, s.t)];
      const S = Math.round(s.out);
      const climbing = (s.move && s.move.k === "edge") || !!s.pad || G2_CLIMBS.includes(sg.k);
      if (climbing && S > c.R + 5) {
        s.learn.cap = Math.min(c.limit, Math.max(c.R + 5, S - 5));
        s.learn.why.cap = `Peaks capped at ${Math.round(s.learn.cap)}%: you cooled down at ${S}%.`;
      }
      if (sg.k === "rhythm" && !s.move && !s.pad) {
        const key = sg.tier || 0, n = (s.learn.cools[key] || 0) + 1;
        s.learn.cools[key] = n;
        if (n >= 2 && key > 0 && !s.learn.tierDown[key]) {
          s.learn.tierDown[key] = true;
          s.learn.why.tier = `${G2_TIERS[key][1]} plays as ${G2_TIERS[key - 1][1]}: you cooled down twice.`;
        }
      }
      if (s.pad && s.pad.t < 3) {
        const i = s.pad.i;
        s.learn.padGain[i] = Math.max(0.5, Math.round(((s.learn.padGain[i] || 1) - 0.1) * 100) / 100);
        s.learn.why.pad = `${s.pad.name} plays ${Math.round((1 - s.learn.padGain[i]) * 100)}% softer: you cooled down right after it.`;
      }
      s.learn.slow = Math.min(2, s.learn.slow * 1.25);
      s.cooled = true;
      s.pad = null;
      s.move = { k: "cool", t: 0, at: s.t, dur: Math.round(g2Between(s, 30, 60)) };
      s.note = "cool";
      return s;
    }
    return s;
  }
  // A pad press. info: g2PadInfo; now: wall ms. Last wins (another pad
  // replaces the playing one, the strength crossfading from where it is);
  // the same pad again restarts it, or within G2_DOUBLE_MS latches it; a
  // latched pad pressed again ends. One start per G2_PAD_GAP_MS. The pad
  // is held (keeps going past its length) until g2PadRelease.
  function g2PadPress(st, info, now) {
    const s = g2Copy(st);
    s.note = "";
    if (s.held || s.move) { s.note = s.held ? "padHeld" : "padMove"; return s; }
    const p = s.pad;
    if (p && p.i === info.i) {
      if (p.latch) { s.pad = null; s.note = "padEnd"; return s; }
      if (now - p.at < G2_DOUBLE_MS) { p.latch = true; s.note = "latch"; return s; }
    }
    if (now - s.padAt < G2_PAD_GAP_MS) { s.note = "padGap"; return s; }
    s.pad = { i: info.i, name: info.name, hue: info.hue, len: Math.max(1, info.len), gain: info.gain, pat: info.pat, own: info.kind === "preset",
              limit: clampN(Number(info.limit) || 100, 1, 100), t: 0, at: now, held: true, latch: false };
    s.padAt = now;
    s.note = "padStart";
    return s;
  }
  function g2PadRelease(st, i) {
    if (!st.pad || st.pad.i !== i || !st.pad.held) return st;
    const s = g2Copy(st);
    s.pad.held = false;
    return s;
  }
  // A new style while it plays: the stage playing now finishes, the rest of
  // the plan is the new style's.
  function g2Restyle(set, st) {
    const s = g2Copy(st);
    s.plan = s.plan.slice(0, g2StageAt(s, s.t) + 1);
    g2Extend(set, s);
    return s;
  }
  // One line, always with the reason.
  function g2LearnText(learn) {
    if (!learn) return "";
    const w = learn.why || {};
    const parts = [w.cap, w.tier, w.pad].filter(Boolean);
    if (learn.slow > 1.01) parts.push(`Climbs take ${Math.round((learn.slow - 1) * 100)}% longer after a Cool down.`);
    return parts.join(" ");
  }
  // The stage name, its countdown and what comes next. 1.45: the numbers are
  // what reaches the motor (mot: g2Sent's; without it, the ceiling as before).
  function g2Readout(lim, st, mot) {
    const c = g2Ctx(st, lim);
    const m = mot && typeof mot.m === "number" ? clampN(mot.m, 0, 1) : 1;
    const atMotor = (v) => Math.round(g2Sent(v, c.top, mot) * m);
    const i = g2StageAt(st, st.t), sg = st.plan[i];
    const nexts = st.plan.slice(i + 1, i + 3).map((x) => g2StageLabel(x, st.learn));
    let label = g2StageLabel(sg, st.learn), hue = G2_STAGE_HUE[sg.k] || "cy", left = sg.t0 + sg.dur - st.t, then = "";
    if (st.move && st.move.k === "edge") { label = "Edge"; hue = "or"; left = G2_EDGE_MAX_S - st.move.t; then = "until you press Edge again"; }
    else if (st.move) { label = "Cool-down"; hue = "bl"; left = st.move.dur - st.move.t; then = "then the build-up goes on"; }
    else if (st.pad) {
      label = st.pad.name; hue = st.pad.hue;
      left = st.pad.latch || st.pad.held && st.pad.t >= st.pad.len ? null : Math.max(0, st.pad.len - st.pad.t);
      then = st.pad.latch ? "latched: press it again to end" : `then back to the build-up, ${atMotor(st.base)}%`;
    }
    if (!then && nexts.length) then = `Coming up: ${nexts.join(", then ")}`;
    return { label, hue, left, then, level: st.L, start: st.L0, playing: atMotor(st.out), P: c.P, R: c.R,
             Pm: Math.round(c.P * m), limitM: Math.round(c.limit * m), m,
             held: !!st.held, cap: st.learn.cap, limit: c.limit,
             text: `${st.held ? "Held · " : ""}${label}${left != null ? " " + mmss(left) : ""}${then ? " · " + then : ""}` };
  }
  // The baseline's next `ahead` seconds as the autopilot has committed them,
  // at the rise and fall rates, in `step` second samples: [{ u, v }].
  function g2Preview(lim, st, ahead, step) {
    const c = g2Ctx(st, lim), out = [];
    let b = st.base;
    for (let u = 0; u <= ahead + 1e-9; u += step) {
      const t = st.t + u, sg = st.plan[g2StageAt(st, t)];
      const bt = Math.min(c.top, g2StageValue(sg, t - sg.t0, c.P, c.R));
      if (u > 0) b = g2Rate(b, bt, GOON_UP_PER_S * step, bt <= 0 ? Infinity : GOON_DOWN_PER_S * step);
      out.push({ u, v: b });
    }
    return out;
  }
  // Stage bands from `from` to `to` seconds around now (negative: past).
  function g2Bands(st, from, to) {
    return st.plan.filter((g) => g.t0 + g.dur > st.t + from && g.t0 < st.t + to).map((g) => ({
      a: Math.max(from, g.t0 - st.t), b: Math.min(to, g.t0 + g.dur - st.t), k: g.k,
      label: g2StageLabel(g, st.learn), hue: G2_STAGE_HUE[g.k] || "cy",
      beat: g.k === "rhythm" ? 60 / Math.min(G2_BPM_MAX, G2_TIERS[g2Tier(g, st.learn)][2]) : 0, t0: g.t0 - st.t }));
  }

  // The keyboard: Alt combinations only, only in Manual mode, never while
  // typing or while another plugin's overlay owns the keys (data-owns-keys).
  // Outside Goon mode Alt+1..4 are the quick slots; while it runs Alt+1..N
  // are the pads (N = the pad count) and Alt+W/A/Q the moves. A held key
  // acts once. ctx: { manualOn, goonOn, typing, owned, padCount }
  function goonKeyAction(e, ctx) {
    if (!e || !e.altKey || e.ctrlKey || e.metaKey) return "";
    if (!ctx || ctx.typing || ctx.owned || !ctx.manualOn) return "";
    const code = String(e.code || "");
    const dm = /^Digit([1-9])$/.exec(code);
    if (dm) {
      const n = +dm[1];
      if (ctx.goonOn) {
        if (n > clampN(Math.round(ctx.padCount || PAD_DEFAULT), PAD_MIN, PAD_MAX)) return "";
        return e.repeat ? "repeat" : `${e.shiftKey ? "padset" : "pad"}:${n - 1}`;
      }
      if (n > SLOT_COUNT) return "";
      return e.repeat ? "repeat" : `${e.shiftKey ? "assign" : "slot"}:${n - 1}`;
    }
    if (!ctx.goonOn || e.shiftKey) return "";
    // the letter typed, else the key's place (a Mac's Alt+W types a symbol)
    const k = /^[a-z]$/i.test(String(e.key || "")) ? e.key.toLowerCase()
            : (/^Key([A-Z])$/.exec(code) || [])[1];
    const act = k ? GOON_KEYS[k.toLowerCase()] : "";
    if (!act) return "";
    return e.repeat ? "repeat" : act;
  }
  // A digit let go while Goon runs ends that pad's hold (Alt may already be up).
  function goonKeyUp(e, ctx) {
    if (!e || !ctx || !ctx.goonOn) return "";
    const dm = /^Digit([1-9])$/.exec(String(e.code || ""));
    return dm ? `pad:${+dm[1] - 1}` : "";
  }

  // The wheel: one step per GOON_WHEEL_UNIT of travel, at most one every
  // GOON_WHEEL_MS, so a fast spin is a few steps rather than dozens. One step
  // is one level. acc: { sum, at, last }; ev: { deltaY, deltaMode }; returns
  // { acc, step: 1 | -1 | 0 }.
  function goonWheel(acc, ev, now) {
    const a = { sum: 0, at: -1e9, last: -1e9, ...(acc || {}) };
    const px = (Number(ev && ev.deltaY) || 0) * ((ev && ev.deltaMode) === 1 ? 40 : (ev && ev.deltaMode) === 2 ? 400 : 1);
    if (now - a.last > 400) a.sum = 0;               // a new gesture
    a.last = now;
    if (a.sum && Math.sign(px) !== Math.sign(a.sum)) a.sum = 0;   // turned round
    a.sum += px;
    if (Math.abs(a.sum) < GOON_WHEEL_UNIT || now - a.at < GOON_WHEEL_MS) return { acc: a, step: 0 };
    const step = a.sum < 0 ? 1 : -1;
    a.sum = 0; a.at = now;
    return { acc: a, step };
  }

  // A quick-slot ramp: down at once, up at GOON_UP_PER_S.
  function rampStep(cur, target, dt) {
    if (cur == null || cur >= target) return target;
    return Math.min(target, cur + GOON_UP_PER_S * clampN(dt, 0, 5));
  }

  // ── Runtime ──
  let goonSet         = cleanGoon2(null);
  let goonOn          = false;
  let goonSt          = null;
  let goonTicker      = null;
  let goonLastTick    = 0;
  let goonLastSent    = 0;
  let goonSentCeil    = null;
  let goonSentPat     = "";
  let goonWheelAcc    = null;
  let goonHist        = [];        // { w: wall ms, v: strength sent, b: baseline, hue: a pad's, or "" }
  let goonEcho        = [];        // { w, v }: the motor's levels from the backend (1.44 echo)
  let goonCmds        = [];        // 1.47: { w, v }: each command the backend sent (the echo's c), for the buzz bars
  let goonSim         = [];        // 1.47: { w, len, v }: the page's own model of the buzzes, until the echo's arrive
  let goonGen         = null;      // 1.47: the generator behind goonSim
  let ceilOverride    = null;      // strength allowed now, instead of the Power limit
  let patternOverride = null;      // the pattern Goon plays now
  let rampTicker      = null;
  let rampLast        = 0;
  let goonPersistT    = null;
  let goonSource      = "";        // 1.49: who started this Goon ("" by hand, "lockdown" from Lockdown's run)
  let goonApi         = null;      // 1.49: { source, prev, touched, manualWasOn } for a Goon started through the API

  function effectiveCeiling() {
    return ceilOverride != null ? ceilOverride : manualCeiling;
  }
  // Level 10 is the current pattern's Power limit.
  function goonLim() { return { limit: clampN(Math.round(manualCeiling), 1, 100) }; }

  function stopCeilRamp() {
    if (rampTicker) { rampTicker.stop(); rampTicker = null; }
  }
  function startCeilRamp() {
    stopCeilRamp();
    rampLast = Date.now();
    let sentAt = 0;
    rampTicker = startTicker(GOON_TICK_MS, () => {
      if (!manualOn || goonOn) { stopCeilRamp(); if (!goonOn) ceilOverride = null; return; }
      const now = Date.now();
      if (!outputOn) { rampLast = now; return; }     // muted: the climb waits (1.45)
      if (pauseHold) { rampLast = now; return; }     // 1.49: and while the video is paused
      ceilOverride = rampStep(ceilOverride, manualCeiling, (now - rampLast) / 1000);
      rampLast = now;
      const done = ceilOverride >= manualCeiling;
      if (done) { ceilOverride = null; stopCeilRamp(); }
      if (done || now - sentAt >= GOON_SEND_MS) { sentAt = now; sendManual(); }
    });
  }

  // Alt+1..4 or a slot button: load that slot's preset. Never a jump up:
  // when its Power limit is above what plays now, the strength climbs to it.
  // While Goon runs it only changes the Power limit Goon works under.
  function switchToSlot(i) {
    // 1.45: in a tab that does not drive this only changed the bar here while
    // the toy kept playing the driver's pattern. Say so instead.
    if (wsReady && !isOwner && !legacyBackend) {
      toast("This tab isn't driving the toy, so a slot would change nothing there. Take over first (the status button).", "warn");
      return;
    }
    const p = cardPreset(presetStore, i);
    if (!p) {
      toast(`There is no preset card ${i + 1} yet. Save one in Manual (+ Save as preset).`, "warn");
      return;
    }
    if (manualOn && !goonOn) {
      const before = effectiveCeiling();
      const target = cleanPattern(p).ceiling;
      if (target > before + GOON_MIN_CHANGE) { ceilOverride = before; startCeilRamp(); }
      else { ceilOverride = null; stopCeilRamp(); }
    }
    selectPreset(p.name);
    if (!deckIsOpen()) toast(`${i + 1}: ${p.name}`);
  }

  // Alt+Shift+N (1.46): the active preset becomes card N (the cards after it move up).
  function assignSlot(i) {
    const act = activePreset();
    if (!act) { toast("Load or save a preset first, then move it.", "warn"); return; }
    moveCard(presetStore.presets.findIndex((p) => p.name === act.name), i);
    toast(`${act.name} is now card ${i + 1} (Alt+${i + 1})`, "done");
  }
  function moveCard(from, to) {
    const next = movePreset(presetStore, from, to);
    if (next === presetStore) return;
    presetStore = next;
    persistPresets();
    updatePresetUI();
  }

  function persistGoonSoon() {
    clearTimeout(goonPersistT);
    goonPersistT = setTimeout(() => {
      // 1.49: what another plugin asked for (style, level, pace, base) is
      // for its run only; the user's own choices are kept, changes made by
      // hand during the run are saved as always
      const keep = {};
      if (goonApi) Object.keys(goonApi.prev).forEach((k) => { if (!goonApi.touched[k]) keep[k] = goonApi.prev[k]; });
      presetStore = { ...presetStore, goon2: { ...(presetStore.goon2 || {}), ...goonSet, ...keep } };
      persistPresets();
    }, 800);
  }

  // Why Goon cannot start now ("" when it can). The mode switch asks first,
  // so it never turns Manual on for a Goon that then refuses.
  function goonRefusal() {
    if (!isOwner && !legacyBackend) return "Another tab drives the toy. Take over first (the pill's button).";
    // the beat shape and a silent strength need a 1.44 backend or newer
    // 1.47: the buzz shape needs the 1.47 backend; an older one would ignore
    // it and keep the last pattern playing (continuous output)
    if (!backendAtLeast("1.47")) return "Goon mode needs the 1.47 backend: run Stop Backend, then Start Backend.";
    return "";
  }
  function goonStart() {
    if (goonOn) return;
    if (!manualOn) {
      toast("Turn Manual on first: Goon mode shapes a running pattern and never starts the toy.", "warn");
      updateGoonUI();
      return;
    }
    const why = goonRefusal();
    if (why) { toast(why, "warn"); return; }
    stopCeilRamp();
    const lim = goonLim();
    // 1.46: from what reaches the motor now (the master goes to 100 for Goon)
    goonSt = g2Init(goonSet, lim, Math.min(effectiveCeiling() * manualLevel / 100, lim.limit), Date.now(), g2BaseRhythm(goonSet, presetStore));
    goonOn = true;
    goonSentCeil = null; goonLastSent = 0; goonSentPat = ""; goonHist = []; goonEcho = []; goonCmds = []; goonSim = []; goonGen = null;
    goonLastTick = Date.now();
    goonTicker = startTicker(GOON_TICK_MS, goonTick);
    try { document.documentElement.setAttribute("data-intifacesync-keys", "goon"); } catch (_) {}
    sendMsg({ type: "echo", enabled: true });
    goonTick();
    showGoonPad(true);
    updateGoonUI();
    // 1.46: the keys are on the pad and in the cheat sheet; one short line
    if (!deckIsOpen()) toast(goonSource ? `Goon mode on, started by ${goonSourceName(goonSource)}. Stop: 0.` : "Goon mode on. Stop: 0.");
    goonEmit("start", goonApiState());       // 1.49: window.IntifaceSync.goon.on("start")
  }

  // Off: back to the pattern as it was, the strength back to its Power
  // limit (at once if that is lower, climbing if higher). Not a stop path:
  // nothing here stops output; stopping is manual off, mute or Disconnect,
  // all unchanged.
  function goonStop(note) {
    if (!goonOn) return;
    goonOn = false;
    // 1.49: every way Goon ends comes through here (End Goon, Stop, Manual
    // off, the tick's checks, an API end), so "end" fires for each
    const endedSource = goonSource;
    goonSource = "";
    if (goonApi) {
      const a = goonApi;
      goonApi = null;
      const back = {};
      Object.keys(a.prev).forEach((k) => { if (!a.touched[k]) back[k] = a.prev[k]; });
      goonSet = { ...goonSet, ...back };
    }
    if (goonTicker) { goonTicker.stop(); goonTicker = null; }
    patternOverride = null; goonSentPat = "";
    try { document.documentElement.removeAttribute("data-intifacesync-keys"); } catch (_) {}
    sendMsg({ type: "echo", enabled: false });
    // 1.46: Goon's ceiling is at the motor (master 100); Manual's motor is
    // manualLevel x the ceiling, so the hand-back starts from the same place
    // and climbs (never a jump up), or drops at once if Manual is lower.
    const m = manualLevel / 100;
    ceilOverride = ceilOverride != null && m > 0 ? ceilOverride / m : null;
    if (manualOn && ceilOverride != null && ceilOverride < manualCeiling - GOON_MIN_CHANGE) startCeilRamp();
    else ceilOverride = null;
    if (manualOn) sendManual();
    showGoonPad(false);
    updateGoonUI();
    // 1.48: an automatic pattern held under Goon is automatic again: it keeps
    // playing while the video plays on a scene without a script, and ends
    // after the usual grace otherwise (a pause, a scene with a script)
    if (manualOn && autoManualActive && isOwner) autoManualSettle();
    if (note) toast(note);
    goonEmit("end", { running: false, source: endedSource, reason: note || "" });
  }

  function goonTick() {
    if (!goonOn) return;
    if (!manualOn) { goonStop("Goon mode ended: Manual is off."); return; }
    if (!isOwner)  { goonStop("Goon mode ended: another tab drives the toy."); return; }
    const now = Date.now();
    // 1.45: muted, Goon holds: no clock, no Pace, no moves timing out,
    // nothing sent (mute sends nothing anyway). Unmuted it goes on from the
    // level it held, every rise through the normal rate limit. Up to 1.44
    // the plan ran on while muted and unmute landed on whatever it had
    // climbed to (Pace could have raised it two levels). Not a stop path.
    // 1.49: the same hold while the scene's video is paused (silent, the
    // ceiling 0 went out with refreshPauseHold); play goes on from here
    refreshPauseHold();
    if (pauseHold) { goonLastTick = now; updateGoonUI(); return; }
    if (!outputOn) { goonLastTick = now; updateGoonUI(); return; }
    const dt = (now - goonLastTick) / 1000;
    goonLastTick = now;
    const lim = goonLim();
    const rhy = g2BaseRhythm(goonSet, presetStore);
    if (JSON.stringify(rhy) !== JSON.stringify(goonSt.rhy)) goonSt = { ...goonSt, rhy };
    const before = goonSt;
    goonSt = g2Step(goonSet, lim, goonSt, dt);
    goonWatch(before, goonSt);
    goonNotes(goonSt.note);
    goonSend(lim, now);
    updateGoonUI();
  }
  // Send what the state asks for: a pattern change at once (one restart in
  // the backend), the strength at most every GOON_SEND_MS, a fall of 5
  // points or more at once.
  function goonSend(lim, now) {
    const mot = g2Mot();
    const o = g2Output(lim, goonSt, mot);
    const key = JSON.stringify(o.pattern);
    const patternChanged = key !== goonSentPat;
    if (patternChanged) { patternOverride = o.pattern; goonSentPat = key; }
    ceilOverride = o.ceil;
    const moved = goonSentCeil == null || Math.abs(ceilOverride - goonSentCeil) >= GOON_MIN_CHANGE;
    const fell = goonSentCeil != null && ceilOverride <= goonSentCeil - 5;
    if (patternChanged || (moved && (fell || now - goonLastSent >= GOON_SEND_MS))) {
      goonSentCeil = ceilOverride; goonLastSent = now;
      sendManual();
    }
    // in motor terms, like the readouts (1.45)
    goonHist.push({ w: now, v: Math.round(ceilOverride * mot.m * 10) / 10,
                    b: Math.round(g2Sent(goonSt.base, g2Ctx(goonSt, lim).top, mot) * mot.m * 10) / 10,
                    hue: goonSt.pad && !goonSt.move ? goonSt.pad.hue : "" });
    while (goonHist.length && goonHist[0].w < now - (G2_PAST_S + 5) * 1000) goonHist.shift();
    while (goonEcho.length && goonEcho[0].w < now - (G2_PAST_S + 5) * 1000) goonEcho.shift();
    // 1.47: the page's model of the buzz train (drawn as the past until the
    // backend's echo of each command arrives); a new pattern starts a new
    // train after a short silence, as the backend's does
    const nowS = now / 1000;
    if (patternChanged || !goonGen) goonGen = g2Gen(o.pattern, Math.max(nowS, goonGen ? goonGen.end + G2_BUZZ_GAP_MS / 1000 : nowS));
    const fresh = [];
    g2GenRun(goonGen, nowS, fresh);
    const fl = o.pattern.minLevel || 0;
    fresh.forEach((b) => {
      if (ceilOverride > 0) goonSim.push({ w: b.a * 1000, len: b.len * 1000, v: Math.max(Math.min(fl, ceilOverride), ceilOverride * b.v) * mot.m });
    });
    while (goonSim.length && goonSim[0].w < now - (G2_PAST_S + 5) * 1000) goonSim.shift();
    while (goonCmds.length > 1 && goonCmds[1].w < now - (G2_PAST_S + 5) * 1000) goonCmds.shift();
  }
  // Every automatic change explained in words.
  function goonNotes(note) {
    if (!note || !goonSt) return;
    if (note === "pace") toast(`Pace: level ${goonSt.L} (at most ${G2_PACE_UP_MAX} above where you started; beyond that only you).`);
    else if (note === "edgeAuto") toast(`Edge let go by itself after ${G2_EDGE_MAX_S} s: a short cool-down, then the build-up goes on.`);
  }

  function goonDo(kind, arg) {
    if (!goonOn || !goonSt) return;
    const lim = goonLim();
    const before = goonSt;
    goonSt = g2Event(goonSet, lim, goonSt, kind, arg);
    goonWatch(before, goonSt);
    if (kind === "hold") toast(goonSt.held ? "Goon: holding right here" : "Goon: going on");
    else if (kind === "edge") toast(goonSt.move && goonSt.move.k === "edge"
      ? `Edge: up to your peak and held, until ${GOON_KEY_LABEL.edge} again (by itself after ${G2_EDGE_MAX_S} s).`
      : "Edge let go: a short cool-down, then the build-up goes on.");
    else if (kind === "cool") {
      const capNow = goonSt.learn.cap, capWas = before.learn.cap;
      toast(capNow != null && capNow !== capWas ? `Cooling down. ${goonSt.learn.why.cap}` : "Cooling down, then it climbs back.");
    } else if (kind === "forget") toast("Learning forgotten for this session.");
    goonSend(lim, Date.now());
    updateGoonUI();
  }
  function goonLevel(n) {
    if (!goonOn || !goonSt) return;
    goonDo("level", n);
  }
  function goonSetStyle(id) {
    if (!G2_STYLES.some((s) => s[0] === id)) return;
    goonSet = { ...goonSet, style: id };
    if (goonApi) goonApi.touched.style = true;
    if (goonOn && goonSt) goonSt = g2Restyle(goonSet, goonSt);
    persistGoonSoon();
    updateGoonUI();
  }
  // 1.47: the preset Goon is built on (null: the default, Build up)
  function goonSetBase(name) {
    goonSet = { ...goonSet, base: typeof name === "string" && name ? name : null };
    if (goonApi) goonApi.touched.base = true;
    if (goonSt) goonSt = { ...goonSt, rhy: g2BaseRhythm(goonSet, presetStore) };
    persistGoonSoon();
    updateGoonUI();
  }
  function goonSetPace(id) {
    if (!G2_PACES.some((p) => p[0] === id)) return;
    goonSet = { ...goonSet, pace: id };
    if (goonApi) goonApi.touched.pace = true;
    persistGoonSoon();
    updateGoonUI();
  }
  function goonSetStartLevel(n) {
    goonSet = { ...goonSet, level: clampN(Math.round(n), 1, 10) };
    if (goonApi) goonApi.touched.level = true;
    persistGoonSoon();
    updateGoonUI();
  }
  function goonSetPadCount(n) {
    goonSet = { ...goonSet, padCount: clampN(Math.round(n), PAD_MIN, PAD_MAX) };
    if (goonSt && goonSt.pad && goonSt.pad.i >= goonSet.padCount) { goonSt = g2Copy(goonSt); goonSt.pad = null; }
    persistGoonSoon();
    renderGoonPads();
    updateGoonUI();
  }
  function goonAssignPad(i, entry) {
    goonSet = g2SetPad(goonSet, i, entry);
    persistGoonSoon();
    renderGoonPads();
    updateGoonUI();
  }
  // Alt+Shift+N: the active preset on pad N.
  function goonPadFromPreset(i) {
    const act = activePreset();
    if (!act) { toast("Load or save a preset first, then put it on a pad.", "warn"); return; }
    goonAssignPad(i, { preset: act.name, len: 12 });
    toast(`Pad ${i + 1} is now ${act.name}`, "done");
  }
  function goonPadDown(i) {
    if (!goonOn || !goonSt || i < 0 || i >= goonSet.padCount) return;
    goonSt = g2PadPress(goonSt, g2PadInfo(goonSet, presetStore, i), Date.now());
    if (goonSt.note === "padHeld") toast(`Holding. ${GOON_KEY_LABEL.hold} goes on.`);
    else if (goonSt.note === "padMove") toast(goonSt.move.k === "edge" ? `Edge is on: ${GOON_KEY_LABEL.edge} lets go of it first.` : "Cooling down: the pads wait until it is over.");
    else if (goonSt.note === "latch") toast(`${goonSt.pad.name} latched: press it again to end.`);
    goonSend(goonLim(), Date.now());
    updateGoonUI();
  }
  function goonPadUp(i) {
    if (goonSt) goonSt = g2PadRelease(goonSt, i);
  }
  function goonReleaseAll() {
    if (goonSt && goonSt.pad && goonSt.pad.held) goonSt = g2PadRelease(goonSt, goonSt.pad.i);
  }
  // The backend's echo of what reached the motor (batched, at most 4 Hz):
  // drawn as the past line when it arrives. Its level is motor output, so
  // the intensity slider is divided back out to read as strength.
  // 1.45: kept as motor output (the graph is in motor terms now).
  function goonOnEcho(msg) {
    if (!goonOn) return;
    const at = Date.now();
    goonEcho.push({ w: at, v: clampN((Number(msg.lv) || 0) * 100, 0, 100), n: Number(msg.n) || 0, c: Array.isArray(msg.c) });
    // 1.47: each command (ms ago, level): the real buzzes and the silence between
    if (Array.isArray(msg.c)) msg.c.forEach((x) => {
      if (Array.isArray(x)) goonCmds.push({ w: at - clampN(Number(x[0]) || 0, 0, 5000), v: clampN((Number(x[1]) || 0) * 100, 0, 100) });
    });
  }

  // ── Goon mode for other plugins (1.49): window.IntifaceSync.goon ──
  // For Lockdown's "Toy in charge" heat. available() says whether Goon could
  // start here now; start() starts it only from a click (userGesture: true,
  // and the browser's own user activation when it has one), the way the mode
  // switch does (Manual on if it was off, then Goon); end() ends only a Goon
  // the same source started: back to the pattern when Manual was already on
  // before, otherwise Stop (stopAll: halt -> _panic()), so the end of a run
  // never leaves a pattern of Lockdown's playing. on() hears start, end (every
  // way Goon ends, Stop and halt included), edge, cooldown and stage. Nothing
  // here is a stop path of its own; Stop, End Goon, mute and the backend's
  // safety work as always while it runs.
  const goonListeners = { start: new Set(), end: new Set(), edge: new Set(), cooldown: new Set(), stage: new Set() };
  const goonSourceName = (src) => (src === "lockdown" ? "Lockdown" : String(src || "another plugin").replace(/^./, (c) => c.toUpperCase()));
  const goonSrcId = (v) => String(v || "api").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "api";
  function goonEmit(type, data) {
    const set = goonListeners[type];
    if (!set || !set.size) return;
    const ev = { type, ...(data || {}) };
    Array.from(set).forEach((fn) => { try { fn(ev); } catch (e) { log(`A Goon ${type} listener failed: ${e && e.message}`, "error"); } });
  }
  // stage, edge and cooldown from a state change (the plan's stage, a move)
  function goonWatch(before, after) {
    if (!after || !after.plan) return;
    const a = after.plan[g2StageAt(after, after.t)];
    const b = before && before.plan ? before.plan[g2StageAt(before, before.t)] : null;
    if (a && (!b || a.t0 !== b.t0 || a.k !== b.k)) {
      goonEmit("stage", { stage: a.k, name: g2StageLabel(a, after.learn), level: after.L });
      if (a.k === "edge") goonEmit("edge", { by: "plan", level: after.L });
      if (a.k === "cool") goonEmit("cooldown", { by: "plan", level: after.L });
    }
    const mk = (x) => (x && x.move ? `${x.move.k}@${x.move.at}` : "");
    if (after.move && mk(after) !== mk(before)) {
      goonEmit(after.move.k === "edge" ? "edge" : "cooldown", { by: after.move.after === "auto" ? "auto" : "user", level: after.L });
    }
  }
  function goonApiState() {
    if (!goonOn || !goonSt) return { running: false, level: null, stage: "", style: goonSet.style, source: "" };
    const sg = goonSt.plan[g2StageAt(goonSt, goonSt.t)];
    const ro = g2Readout(goonLim(), goonSt, g2Mot());
    return { running: true, level: goonSt.L, stage: goonSt.move ? (goonSt.move.k === "edge" ? "edge" : "cool") : sg ? sg.k : "",
             stageName: ro.label, style: goonSet.style, pace: goonSet.pace, source: goonSource, pct: ro.playing,
             held: !!goonSt.held, muted: !outputOn, paused: pauseHold };
  }
  function goonAvailable() {
    if (pluginOff) return { ok: false, why: "Intiface Sync is turned off in this browser (its pill under the player turns it on)." };
    if (!wsReady) return { ok: false, why: "The Intiface Sync backend is not running (Start backend under the player)." };
    if (backendStatusSeen && !backendAtLeast("1.47")) return { ok: false, why: "Goon mode needs a newer Intiface Sync backend: Restart backend under the player." };
    if (!isOwner && !legacyBackend && driverInfo) return { ok: false, why: "Another tab drives the toy. Press play in this tab, or Take over under the player." };
    const sd = statusData || {};
    if (mode !== "intiface") return { ok: false, why: "Goon mode is for Intiface devices (The Handy mode is on)." };
    if (!sd.connected) return { ok: false, why: "Intiface Central is not connected (Connect under the player)." };
    if (!(sd.devices || []).length) return { ok: false, why: "No toy is connected in Intiface Central." };
    return { ok: true, why: "", running: goonOn, source: goonSource, muted: !outputOn, paused: pauseHold };
  }
  async function goonApiStart(o) {
    o = o && typeof o === "object" ? o : {};
    if (o.userGesture !== true) return { ok: false, why: "Goon mode starts only from a click (userGesture: true)." };
    try {
      if (typeof navigator !== "undefined" && navigator.userActivation && navigator.userActivation.isActive === false) {
        return { ok: false, why: "Goon mode starts only right after a click." };
      }
    } catch (_) {}
    const src = goonSrcId(o.source);
    if (goonOn) {
      if (goonSource === src) return { ok: true, why: "", already: true };
      return { ok: true, why: "Goon mode was already running; it goes on as it is (ending this run will not end it).", adopted: true };
    }
    const av = goonAvailable();
    if (!av.ok) return { ok: false, why: av.why };
    if (!isOwner && !legacyBackend) {
      // nobody drives: this click takes the toy here, as pressing play does
      tryTakeover("button");
      for (let i = 0; i < 25 && !isOwner; i++) await new Promise((r) => setTimeout(r, 100));
      if (!isOwner) return { ok: false, why: "This tab could not take the toy over. Try Take over under the player." };
    }
    const prev = { style: goonSet.style, level: goonSet.level, pace: goonSet.pace, base: goonSet.base };
    const next = { ...goonSet };
    if (G2_STYLES.some((x) => x[0] === o.style)) next.style = o.style;
    if (o.level != null && isFinite(Number(o.level))) next.level = clampN(Math.round(Number(o.level)), 1, 10);
    if (G2_PACES.some((x) => x[0] === o.pace)) next.pace = o.pace;
    if (o.base === "tidal" || o.base === G2_BASE_TIDAL) next.base = G2_BASE_TIDAL;
    else if (typeof o.base === "string" && g2BaseList(presetStore).includes(o.base)) next.base = o.base;
    goonSet = cleanGoon2(next);
    goonApi = { source: src, prev, touched: {}, manualWasOn: manualOn };
    goonSource = src;
    chooseMode("goon");                       // Manual on if it was off, then Goon (the mode switch's way)
    if (!goonOn) {
      const why = goonRefusal() || "Goon mode did not start.";
      goonSet = { ...goonSet, ...prev };
      goonApi = null; goonSource = "";
      return { ok: false, why };
    }
    updateGoonUI();
    return { ok: true, why: "" };
  }
  function goonApiEnd(o) {
    const src = goonSrcId(o && o.source);
    if (!goonOn) return { ok: true, why: "Goon mode is not running." };
    if (goonSource !== src) return { ok: false, why: `This Goon mode was not started by ${goonSourceName(src)}; it goes on.` };
    const wasOn = !!(goonApi && goonApi.manualWasOn);
    if (wasOn) goonStop(`Goon mode ended by ${goonSourceName(src)}: back to your pattern.`);
    else { stopAll(); toast(`Goon mode ended by ${goonSourceName(src)}: stopped.`); }
    return { ok: true, why: "" };
  }
  function goonApiOn(type, fn) {
    const set = goonListeners[type];
    if (!set || typeof fn !== "function") return () => {};
    set.add(fn);
    return () => { set.delete(fn); };
  }
  try {
    window.IntifaceSync = window.IntifaceSync || {};
    window.IntifaceSync.version = PLUGIN_VERSION;
    window.IntifaceSync.goon = Object.freeze({ available: goonAvailable, start: goonApiStart, end: goonApiEnd,
                                               state: goonApiState, on: goonApiOn });
  } catch (_) {}

  // ── Goon mode 2: the buzz train (1.47; pure) ──
  // The page's own picture of a pattern's buzzes: the buzz shape as the
  // backend draws it (same rules, its own seeded numbers, so the lengths and
  // gaps are alike, not the same), pulse, beat and tease one buzz per beat or
  // cycle, anything else one solid stretch (a preset of the user's own on a
  // pad). Times in seconds; v is the share of the ceiling.
  function g2Gen(pat, t0, seed) {
    const sd = Number(seed != null ? seed : pat && pat.seed) || 1;
    // a Tidal preset (on a pad, or Manual's preview) is drawn as the buzzes it sends
    const pt = pat && pat.shape === "tidal" ? tidalWire(pat, sd) : pat;
    return { pat: pt || { shape: "constant" }, rnd: mulberry32(sd | 0), next: t0, t0, taps: 0, k: 0, last: -1e9, end: t0, left: 0, vt: 0 };
  }
  // 1.49: the backend's _buzz_phrased (phrases on)
  const g2Phrased = (p) => !!p && ((p.phraseMax || 1) > 1 || (p.accent || 0) > 0 || (p.hold || 0) > 0 || (p.breathS || 0) > 0);
  function g2GenRun(g, t1, out) {
    const p = g.pat;
    for (let guard = 0; guard < 6000 && g.next < t1; guard++) {
      if (p.shape === "buzz" && g2Phrased(p)) {
        // 1.49: phrases (Tidal), the backend's _manual_phrase_buzz
        const uLen = g.rnd(), uAmp = g.rnd(), rKind = g.rnd(), uGap = g.rnd(), uK = g.rnd(), uAcc = g.rnd(), uHold = g.rnd(); g.rnd();
        const br = p.breathS > 0 ? clampN(p.breathS, 10, 180) : 0;
        const tide = br ? 0.5 - 0.5 * Math.cos(2 * Math.PI * (g.vt || 0) / br) : 0.5;
        if (!(g.left > 0)) {
          const lk = clampN(Math.round(p.phraseMin || 1), 1, 6), hk = clampN(Math.round(Math.max(lk, p.phraseMax || 1)), lk, 6);
          g.left = clampN(lk + Math.floor((hk - lk + 1) * (0.5 * uK + 0.5 * tide)), lk, hk);
        }
        const last = g.left <= 1;
        const lo = clampN(p.onFromMs, G2_BUZZ_MIN_MS, G2_BUZZ_MAX_MS) / 1000;
        const hi = clampN(Math.max(p.onFromMs, p.onMs), G2_BUZZ_MIN_MS, G2_BUZZ_MAX_MS) / 1000;
        const amp = clampN(p.varyAmp || 0, 0, 60) / 100;
        const accent = uAcc < clampN(p.accent || 0, 0, 50) / 100, hold = last && uHold < clampN(p.hold || 0, 0, 30) / 100;
        let len, v;
        if (hold) { len = (TIDAL_HOLD_MS[0] + (TIDAL_HOLD_MS[1] - TIDAL_HOLD_MS[0]) * uLen) / 1000; v = 1 - 0.5 * amp * uAmp; }
        else if (accent) { len = lo + (hi - lo) * (0.6 + 0.4 * uLen); v = 1; }
        else { len = lo + (hi - lo) * uLen; v = (1 - amp * uAmp) * (1 - 0.2 * (1 - tide)); }
        len = clampN(len, G2_BUZZ_MIN_MS / 1000, G2_BUZZ_MAX_MS / 1000);
        let gap;
        if (!last) gap = (TIDAL_INNER_MS[0] + (TIDAL_INNER_MS[1] - TIDAL_INNER_MS[0]) * uGap) / 1000;
        else {
          const base = clampN(p.gapMs || 1500, G2_BUZZ_GAP_MS, 60000) / 1000, vg = clampN(p.varyGap || 0, 0, 100) / 100;
          gap = rKind < clampN(p.longs || 0, 0, 40) / 100 ? Math.min(TIDAL_LONG_MAX_MS / 1000, base * (2.5 + 1.5 * uGap))
            : base * (1 + 0.6 * (1 - 2 * tide)) * ((1 - 0.4 * vg) + 1.9 * vg * uGap);
        }
        gap = Math.max(G2_BUZZ_GAP_MS / 1000, gap);
        g.left -= 1;
        g.vt = (g.vt || 0) + len + gap;
        out.push({ a: g.next, len, v, hold, accent });
        g.end = g.next + len;
        g.next = g.end + gap;
      } else if (p.shape === "buzz") {
        const r0 = g.rnd(), r1 = g.rnd(), r2 = g.rnd(), r3 = g.rnd(), r4 = g.rnd();
        const lo = clampN(p.onFromMs, G2_BUZZ_MIN_MS, G2_BUZZ_MAX_MS) / 1000;
        const hi = clampN(Math.max(p.onFromMs, p.onMs), G2_BUZZ_MIN_MS, G2_BUZZ_MAX_MS) / 1000;
        const len = lo + (hi - lo) * r0, v = 1 - clampN(p.varyAmp || 0, 0, 60) / 100 * r1;
        const base = clampN(p.gapMs || 1500, G2_BUZZ_GAP_MS, 60000) / 1000, vg = clampN(p.varyGap || 0, 0, 100) / 100;
        const taps = clampN(p.taps || 0, 0, 50) / 100, longs = clampN(p.longs || 0, 0, 40) / 100;
        let gap;
        if (g.taps > 0) { g.taps -= 1; gap = 0.15 + 0.09 * r3; }
        else if (r2 < taps) { g.taps = r4 < 0.3 ? 2 : 1; gap = 0.15 + 0.09 * r3; }
        else if (r2 < taps + longs) gap = base * (2.5 + 1.5 * r3);
        else gap = base * ((1 - 0.4 * vg) + 1.9 * vg * r3);
        out.push({ a: g.next, len, v });
        g.end = g.next + len;
        g.next = g.end + Math.max(G2_BUZZ_GAP_MS / 1000, gap);
      } else if (p.shape === "pulse" || p.shape === "tease") {
        const per = Math.max(0.2, p.period), len = Math.min(Math.max(0.06, p.onMs / 1000), per * 0.95);
        out.push({ a: g.next, len, v: 1 });
        g.end = g.next + len; g.next += per;
      } else if (p.shape === "beat") {
        const step = 60 / clampN(p.bpm || 120, 20, 240) / clampN(p.div || 1, 1, 4), steps = p.steps || "x";
        const a = g.t0 + g.k * step, ch = steps[g.k % steps.length];
        g.k += 1;
        g.next = g.t0 + g.k * step;
        if ((ch === "x" || ch === "X") && a - g.last >= 0.19 - 1e-9) {
          const len = Math.max(0.1, Math.min(p.onMs / 1000, step - 0.09));
          out.push({ a, len, v: ch === "X" ? 1 : clampN(p.beatLow || 80, 30, 100) / 100 });
          g.last = a; g.end = a + len;
        }
      } else {
        out.push({ a: g.next, len: Math.max(0, t1 - g.next), v: 1 });
        g.end = t1; g.next = t1;
      }
    }
    return out;
  }
  // A pattern's buzzes that start between a and b seconds.
  function g2Train(pat, a, b, seed) {
    return g2GenRun(g2Gen(pat, a, seed), b, []).filter((x) => x.a < b);
  }
  // The backend's commands as buzzes: each non-zero level until the next command.
  function g2CmdBars(cmds, now) {
    const out = [];
    for (let i = 0; i < (cmds || []).length; i++) {
      const c = cmds[i];
      if (!(c.v > 0)) continue;
      const end = i + 1 < cmds.length ? cmds[i + 1].w : now;
      out.push({ w: c.w, len: Math.max(0, end - c.w), v: c.v });
    }
    return out;
  }
  // The plan's buzzes for the next `ahead` seconds, at the motor: what plays
  // now (a move or a pad) to its end, then each stage's own pattern at the
  // baseline the preview has planned. [{ u (s from now), len (s), v (%) }]
  function g2AheadBuzzes(lim, st, ahead, mot) {
    const c = g2Ctx(st, lim), m = mot && typeof mot.m === "number" ? clampN(mot.m, 0, 1) : 1;
    const prev = g2Preview(lim, st, ahead, 1);
    const base = (u) => prev[clampN(Math.floor(u), 0, prev.length - 1)].v;
    const rhy = st.rhy || G2_BASE_DEFAULT, out = [];
    const put = (pat, a, b, ceilAt) => {
      if (!(b > a)) return;
      g2Train(pat, a, b, pat.seed).forEach((x) => {
        const peak = ceilAt(x.a);
        if (!(peak > 0)) return;
        const fl = pat.shape === "buzz" ? Math.min(peak, pat.minLevel || 0) : 0;
        out.push({ u: x.a, len: Math.min(x.len, b - x.a), v: Math.max(fl, peak * x.v) * m });
      });
    };
    const nowOut = g2Output(lim, st, mot);
    const i = g2StageAt(st, st.t), sg = st.plan[i];
    let first = 0;
    if (st.move) first = st.move.k === "cool" ? Math.max(0, st.move.dur - st.move.t) : ahead;
    else if (st.pad) first = st.pad.latch || st.pad.held ? ahead : Math.max(0, st.pad.len - st.pad.t);
    first = clampN(first, 0, ahead);
    put(nowOut.pattern, 0, first, () => nowOut.ceil);
    for (let k = i; k < st.plan.length; k++) {
      const g = st.plan[k], a = Math.max(first, g.t0 - st.t), b = Math.min(ahead, g.t0 + g.dur - st.t);
      if (b <= a) continue;
      const pat = g2Finish(g2StagePattern(g, st.learn, rhy, st.L, g2SeedFor(st, 1, g.t0)), false, mot);
      put(pat, a, b, (u) => {
        const s = g2Sent(base(u), c.top, mot);
        return s > 0 && pat.shape === "buzz" ? Math.min(c.top, s * (1 + pat.varyAmp / 200)) : s;
      });
    }
    return out;
  }

  // ── Goon mode 2: the signal view (an SVG string; pure given its data) ──
  // o: { w, h, past, ahead (s), big, now (wall ms), hist, echo, preview
  // [{u, v}], bands (g2Bands), limit, cap, out, buzzPast, buzzAhead, zoom }.
  // 1.47: the buzzes as bars, so the silence between them shows: buzzPast
  // [{ w (wall ms), len (ms), v (%) }] what reached the motor (the echo's
  // commands, else the page's model), buzzAhead [{ u, len (s), v }] the
  // plan's; the planned level as a dashed line over them. With zoom (s) and
  // room, a strip under the graph shows the last and next zoom seconds at a
  // scale where every gap is visible. Stage bands with names, bar ticks
  // under rhythms (one per 4 beats), the Power limit (red, dashed) and the
  // learned cap (yellow, dotted), pad hits as a coloured strip at the foot.
  const g2Hue = (h) => (h === "grey" ? "var(--sx-grey)" : `var(--sx-${h})`);
  function g2Graph(o) {
    const w = Math.max(60, Math.round(o.w)), h = Math.max(30, Math.round(o.h)), big = !!o.big;
    const zH = o.zoom > 0 && h >= 70 ? (big ? 36 : 24) : 0;
    const padL = big ? 26 : 0, padR = big ? 6 : 0, bandH = big ? 16 : 5, yT = bandH + (big ? 6 : 4), yB = h - (big ? 16 : 2) - zH;
    const span = o.past + o.ahead;
    const X = (sec) => padL + (clampN(sec, -o.past, o.ahead) + o.past) / span * (w - padL - padR);
    // 1.50: the scale's top is o.yMax (a little over the Power limit) when
    // given, so the bars use the height instead of a third of it under a
    // limit of 30-70%; 100 without it, as before
    const top = o.yMax > 0 ? clampN(o.yMax, 10, 100) : 100;
    const Y = (v) => yB - (yB - yT) * clampN(v / top, 0, 1);
    const f1 = (v) => (Math.round(v * 10) / 10).toString();
    const q5 = (v) => Math.round(v / 5) * 5;
    const parts = [];
    const bar = (x0, x1, y, y0, kind, style, minW) => {
      const wd = Math.max(minW, x1 - x0);
      if (!(y0 - y > 0.2)) return;
      parts.push(`<rect data-bz="${kind}" x="${f1(x0)}" y="${f1(y)}" width="${f1(wd)}" height="${f1(y0 - y)}" style="${style}"/>`);
    };
    parts.push(`<rect x="${f1(X(0))}" y="0" width="${f1(X(o.ahead) - X(0))}" height="${yB}" style="fill:var(--sx-hi);fill-opacity:.04"/>`);
    if (big) [25, 50, 75].filter((v) => v < top - 4).forEach((v) => parts.push(`<line x1="${padL}" y1="${f1(Y(v))}" x2="${w - padR}" y2="${f1(Y(v))}" style="stroke:var(--sx-ui2)"/>`));
    parts.push(`<line x1="${padL}" y1="${yB}" x2="${w - padR}" y2="${yB}" style="stroke:var(--sx-ui3)"/>`);
    (o.bands || []).forEach((b) => {
      const x0 = X(b.a), x1 = X(b.b) - 1.5;
      if (x1 - x0 < 1) return;
      parts.push(`<rect x="${f1(x0)}" y="0" width="${f1(x1 - x0)}" height="${bandH}" rx="${big ? 4 : 1.5}" style="fill:${g2Hue(b.hue)};fill-opacity:${big ? 0.35 : 0.7}"/>`);
      if (big && x1 - x0 > 34) {
        const lab = b.label.length * 5.6 > x1 - x0 - 6 ? b.label.split(" · ")[0] : b.label;
        if (lab.length * 5.6 <= x1 - x0 - 6) parts.push(`<text x="${f1(x0 + 4)}" y="${bandH - 4.5}" style="fill:var(--sx-hi);font-size:10px;font-weight:600">${escHtml(lab)}</text>`);
      }
      if (big && b.beat > 0) {
        let d = "";
        for (let t = b.t0; t < b.t0 + (b.b - b.t0) + 1e-9; t += b.beat * 4) if (t >= b.a && t <= b.b) d += `M${f1(X(t))} ${yB + 2}v5`;
        if (d) parts.push(`<path d="${d}" style="stroke:var(--sx-cy-tx);stroke-width:1;fill:none"/>`);
      }
    });
    if (o.limit != null) parts.push(`<line x1="${padL}" y1="${f1(Y(o.limit))}" x2="${w - padR}" y2="${f1(Y(o.limit))}" style="stroke:var(--sx-re-tx);stroke-width:1.2;stroke-dasharray:6 4"/>`);
    if (o.cap != null && o.cap < (o.limit != null ? o.limit : 101)) parts.push(`<line x1="${padL}" y1="${f1(Y(o.cap))}" x2="${w - padR}" y2="${f1(Y(o.cap))}" style="stroke:var(--sx-ye-tx);stroke-width:1.2;stroke-dasharray:2 4"/>`);
    // pad hits: a coloured strip along the foot, one per run of samples with the same pad colour
    const hist = (o.hist || []).filter((p) => p.w >= o.now - o.past * 1000 - 1000);
    let run = null;
    const flush = () => { if (run) parts.push(`<rect x="${f1(X(run.a))}" y="${f1(yB - 5)}" width="${f1(Math.max(1, X(run.b) - X(run.a)))}" height="5" style="fill:${g2Hue(run.hue)};fill-opacity:.5"/>`); run = null; };
    hist.forEach((p) => {
      const sec = (p.w - o.now) / 1000;
      if (p.hue) { if (run && run.hue === p.hue) { run.b = sec; } else { flush(); run = { hue: p.hue, a: sec, b: sec }; } }
      else flush();
    });
    flush();
    const pastStyle = "fill:var(--sx-cy-tx);fill-opacity:.85", aheadStyle = "fill:var(--sx-hi);fill-opacity:.3";
    const pastB = (o.buzzPast || []).filter((b) => b.w + b.len >= o.now - o.past * 1000 && b.w <= o.now);
    const aheadB = (o.buzzAhead || []).filter((b) => b.u >= 0 && b.u < o.ahead);
    if (o.buzzPast) {
      pastB.forEach((b) => bar(X((b.w - o.now) / 1000), X(Math.min(0, (b.w + b.len - o.now) / 1000)), Y(q5(b.v)), yB, "p", pastStyle, big ? 1 : 0.8));
    } else if (hist.length > 1) {
      // without the buzzes (the tests' plain calls): what was sent as a line, never a filled curve
      let d = "", prevY = null;
      hist.forEach((p, i) => {
        const x = X((p.w - o.now) / 1000), y = Y(q5(p.v));
        if (i === 0) d = `M${f1(x)} ${f1(y)}`;
        else { if (Math.abs(y - prevY) > 0.1) d += `L${f1(x)} ${f1(prevY)}`; d += `L${f1(x)} ${f1(y)}`; }
        prevY = y;
      });
      parts.push(`<path d="${d}" style="fill:none;stroke:var(--sx-cy-tx);stroke-width:${big ? 2 : 1.6}"/>`);
    }
    aheadB.forEach((b) => bar(X(b.u), X(Math.min(o.ahead, b.u + b.len)), Y(b.v), yB, "f", aheadStyle, big ? 1 : 0.8));
    // the baseline under a pad stays visible
    if (big && hist.some((p) => p.hue)) {
      const bd = hist.map((p, i) => `${i ? "L" : "M"}${f1(X((p.w - o.now) / 1000))} ${f1(Y(p.b))}`).join("");
      parts.push(`<path d="${bd}" style="fill:none;stroke:var(--sx-hi);stroke-opacity:.45;stroke-width:1"/>`);
    }
    if ((o.preview || []).length > 1) {
      const d = o.preview.map((p, i) => `${i ? "L" : "M"}${f1(X(p.u))} ${f1(Y(p.v))}`).join("");
      parts.push(`<path d="${d}" style="fill:none;stroke:var(--sx-hi);stroke-opacity:.7;stroke-width:${big ? 1.4 : 1.1};stroke-dasharray:5 4"/>`);
    }
    parts.push(`<line x1="${f1(X(0))}" y1="${bandH + 2}" x2="${f1(X(0))}" y2="${yB + (big ? 4 : 0)}" style="stroke:var(--sx-hi);stroke-width:1.3"/>`);
    if (o.out != null) parts.push(`<circle cx="${f1(X(0))}" cy="${f1(Y(o.out))}" r="${big ? 4.5 : 3}" style="fill:var(--sx-hi);stroke:var(--sx-bg);stroke-width:2"/>`);
    if (big) {
      const tl = (sec, txt) => parts.push(`<text x="${f1(X(sec))}" y="${yB + 13}" text-anchor="middle" style="fill:var(--sx-tx2);font-size:10px">${txt}</text>`);
      [-90, -60, -30].filter((s) => s >= -o.past).forEach((s) => tl(s, `${s} s`));
      [30, 60].filter((s) => s <= o.ahead).forEach((s) => tl(s, `+${s} s`));
      tl(0, "now");
      if (50 < top - 4) parts.push(`<text x="2" y="${f1(Y(50) + 3)}" style="fill:var(--sx-tx2);font-size:10px">50</text>`);
      if (o.limit != null) parts.push(`<text x="${w - padR - 2}" y="${f1(Y(o.limit) - 3)}" text-anchor="end" style="fill:var(--sx-re-tx);font-size:10px">${escHtml(o.limitLabel || "Power limit")} ${Math.round(o.limit)}%</text>`);
      if (o.cap != null && o.cap < (o.limit != null ? o.limit : 101)) parts.push(`<text x="${w - padR - 2}" y="${f1(Y(o.cap) - 3)}" text-anchor="end" style="fill:var(--sx-ye-tx);font-size:10px">peaks ${Math.round(o.cap)}%</text>`);
    }
    if (zH) {
      // the close-up: the last and the next `zoom` seconds, every buzz and every silence
      const Z = o.zoom, z0 = yB + (big ? 17 : 3), z1 = h - 1;
      const XZ = (sec) => padL + (clampN(sec, -Z, Z) + Z) / (2 * Z) * (w - padL - padR);
      const topV = Math.max(10, o.limit != null ? o.limit : 100);
      const YZ = (v) => z1 - (z1 - z0 - 2) * clampN(v / topV, 0, 1);
      parts.push(`<rect x="${padL}" y="${f1(z0)}" width="${w - padL - padR}" height="${f1(z1 - z0)}" rx="3" style="fill:var(--sx-hi);fill-opacity:.04"/>`);
      pastB.filter((b) => b.w + b.len >= o.now - Z * 1000).forEach((b) =>
        bar(XZ((b.w - o.now) / 1000), XZ(Math.min(0, (b.w + b.len - o.now) / 1000)), YZ(q5(b.v)), z1, "z", pastStyle, 1));
      aheadB.filter((b) => b.u < Z).forEach((b) => bar(XZ(b.u), XZ(Math.min(Z, b.u + b.len)), YZ(b.v), z1, "zf", aheadStyle, 1));
      parts.push(`<line x1="${f1(XZ(0))}" y1="${f1(z0)}" x2="${f1(XZ(0))}" y2="${f1(z1)}" style="stroke:var(--sx-hi);stroke-width:1"/>`);
      if (big) parts.push(`<text x="${padL + 3}" y="${f1(z0 + 10)}" style="fill:var(--sx-tx2);font-size:9px">last ${Z} s · buzzes and silence · next ${Z} s</text>`);
    }
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Strength: the last ${o.past} seconds and the next ${o.ahead} as planned, each buzz a bar">${parts.join("")}</svg>`;
  }
  // 1.45: drawn in motor terms (what the toy gets: the ceiling x the
  // intensity slider), like the readouts; the history is stored that way.
  // 1.47: the past is the backend's commands while they arrive (the echo's
  // c), else the page's model of the train; the future is the plan's buzzes.
  // 1.50: zoom (the 10 s close-up strip) only where asked (the deck; the
  // floating pad dropped it), and the scale's top just over the limit.
  function g2GraphFor(el, big, past, ahead, zoom) {
    if (!el || !goonSt) return;
    const lim = goonLim(), c = g2Ctx(goonSt, lim), mot = g2Mot(), m = mot.m;
    const w = el.clientWidth || (big ? 340 : 358), h = el.clientHeight || (big ? 150 : 72);
    const now = Date.now();
    const echoed = goonEcho.length > 0 && goonEcho[goonEcho.length - 1].c && goonEcho[goonEcho.length - 1].w > now - 3000;
    el.innerHTML = g2Graph({ w, h, past, ahead, big, now, hist: goonHist, echo: goonEcho, zoom: zoom || 0, yMax: g2YMax(c.limit * m),
      buzzPast: echoed ? g2CmdBars(goonCmds, now) : goonSim, buzzAhead: g2AheadBuzzes(lim, goonSt, ahead, mot),
      preview: g2Preview(lim, goonSt, ahead, 1).map((p) => ({ u: p.u, v: g2Sent(p.v, c.top, mot) * m })),
      bands: g2Bands(goonSt, -past, ahead), limit: c.limit * m, limitLabel: m < 0.995 ? "Max at the motor" : "Power limit",
      cap: goonSt.learn.cap != null ? goonSt.learn.cap * m : null, out: g2Sent(goonSt.out, c.top, mot) * m });
  }
  // The graph's top (pure): the limit at the motor plus a little room, on
  // a 10 grid, at least 20 and at most 100.
  function g2YMax(limit) {
    return clampN(Math.ceil((Number(limit) || 100) * 1.12 / 10) * 10, 20, 100);
  }
  // A small sketch of what a pad plays (66 x 18).
  // 1.50: anything that plays buzzes (buzz, pulse, beat, tease, a Tidal
  // preset) is drawn as bars with the silence between them, from the same
  // model the graph uses (g2Train), so the tile no longer shows a continuous
  // square wave for what is, since 1.47, short buzzes and quiet. A preset of
  // the user's own with a continuous shape (wave, steady, ramp, random)
  // still draws as its line.
  const G2_SKETCH_W = 66, G2_SKETCH_H = 18;
  function g2Sketch(info) {
    const p = wireShape(info.pat), pts = [];      // 1.49: a Tidal preset draws as its buzzes
    if (["buzz", "pulse", "beat", "tease"].includes(p.shape)) {
      const per = p.shape === "buzz" ? ((p.onMs || 300) + (p.gapMs || 300)) / 1000 : 0;
      const win = p.shape === "buzz" ? clampN(per * 4, 3, 10) : 3;
      const len = Math.max(1, Number(info.len) || win);
      const bars = g2Train(p, 0, win, 7);
      const f1 = (v) => (Math.round(v * 10) / 10).toString();
      const rects = bars.map((b) => {
        const g = info.gain ? info.gain(b.a / win * len, len) : 1;
        const v = clampN((0.35 + 0.6 * clampN(b.v, 0, 1)) * clampN(g, 0, 1.35) / 1.1, 0, 1);
        if (!(v > 0.02)) return "";
        const x = b.a / win * G2_SKETCH_W, w = Math.max(1.5, Math.min(b.len, win - b.a) / win * G2_SKETCH_W - 0.6);
        const h = Math.max(2, v * (G2_SKETCH_H - 2));
        return `<rect x="${f1(x)}" y="${f1(G2_SKETCH_H - 1 - h)}" width="${f1(w)}" height="${f1(h)}" rx="0.6"/>`;
      }).join("");
      return `<svg width="${G2_SKETCH_W}" height="${G2_SKETCH_H}" viewBox="0 0 ${G2_SKETCH_W} ${G2_SKETCH_H}" aria-hidden="true">` +
        `<path d="M0 ${G2_SKETCH_H - 0.5}H${G2_SKETCH_W}" style="stroke:${g2Hue(info.hue)};stroke-opacity:.35;stroke-width:1"/>` +
        `<g style="fill:${g2Hue(info.hue)}">${rects}</g></svg>`;
    }
    for (let i = 0; i <= 66; i++) {
      const x = i / 66;
      let v;
      if (p.shape === "pulse") { const t = x * 2; v = (t % p.period) < p.onMs / 1000 ? 0.85 : 0.1; }
      else if (p.shape === "beat") {
        const t = x * 3, step = 60 / p.bpm / p.div, k = Math.floor(t / step), ch = p.steps[k % p.steps.length];
        v = (ch === "x" || ch === "X") && t - k * step < p.onMs / 1000 ? (ch === "X" ? 0.95 : 0.75) : 0.1;
      }
      else if (p.shape === "buzz") {
        // 1.47: a few buzzes with silence between, the swell's growing
        const t = x * 3, per = (p.onMs + p.gapMs) / 1000, ph = t % per;
        v = ph < p.onMs / 1000 * (0.6 + 0.4 * ((Math.floor(t / per) % 3) / 2)) ? clampN(0.4 + 0.5 * info.gain(x * info.len, info.len) / 1.35, 0.3, 0.95) : 0.1;
      }
      else if (p.shape === "wave") v = 0.25 + 0.6 * Math.sin(Math.PI * x);
      else if (p.shape === "constant") v = clampN(info.gain(x * info.len, info.len) / 1.35, 0.05, 1);
      else if (p.shape === "tease") v = (x * 6) % 1 < 0.3 + 0.4 * x ? 0.3 + 0.6 * x : 0.1;
      else v = 0.25 + 0.55 * x;
      pts.push(`${i} ${(17 - 16 * v).toFixed(1)}`);
    }
    return `<svg width="66" height="18" viewBox="0 0 66 18" aria-hidden="true"><path d="M${pts.join(" L")}" style="fill:none;stroke:${g2Hue(info.hue)};stroke-width:1.5"/></svg>`;
  }
  const G2_STYLE_SKETCH = {
    climb: (u) => { const w = (u * 2) % 1; return 0.2 + 0.6 * (w < 0.8 ? w / 0.8 : 1 - (w - 0.8) / 0.2 * 0.8) * (0.8 + 0.2 * u); },
    waves: (u) => 0.45 + 0.35 * Math.sin(u * Math.PI * 5 - 1.5),
    rhythm: (u) => { const r = Math.floor(u * 4), p = u * 4 - r; return p < 0.8 ? 0.3 + 0.15 * r : 0.12; },
    tease: (u) => { const p = (u * 5) % 1; return p < 0.6 ? 0.2 + 0.7 * p / 0.6 : 0.08; },
    coaster: (u) => 0.4 + 0.25 * Math.sin(u * 19) + 0.2 * Math.sin(u * 7 + 1),
    endurance: (u) => 0.62 + 0.06 * Math.sin(u * 17) + (u > 0.7 && u < 0.78 ? 0.2 : 0),
  };
  function g2StyleSketch(id, on) {
    const f = G2_STYLE_SKETCH[id], pts = [];
    for (let i = 0; i <= 46; i++) pts.push(`${i} ${(15 - 14 * clampN(f(i / 46), 0, 1)).toFixed(1)}`);
    return `<svg width="46" height="16" viewBox="0 0 46 16" aria-hidden="true"><path d="M${pts.join(" L")}" style="fill:none;stroke:${on ? "var(--sx-cy-tx)" : "var(--sx-tx2)"};stroke-width:1.3"/></svg>`;
  }

  // ── Goon pad: over the player, in fullscreen too, a bottom sheet on a phone
  const PAD_POS_KEY = "IntifaceSync.padPos";    // where the pad was dragged: a display preference
  let goonPadEl = null;
  const goonUi = { mini: null, edit: false, pick: -1, padsKey: "", downPad: -1, ptr: "" };
  const goonSheet = () => (window.innerWidth || 1200) <= 640;
  function readPadPos() {
    try { const p = JSON.parse(localStorage.getItem(PAD_POS_KEY) || "null"); return p && typeof p.x === "number" && typeof p.y === "number" ? p : null; }
    catch (_) { return null; }
  }
  function writePadPos(p) {
    try { localStorage.setItem(PAD_POS_KEY, JSON.stringify(p)); } catch (_) {}
  }
  function placePad() {
    if (!goonPadEl) return;
    const host = document.fullscreenElement || document.body;
    if (goonPadEl.parentNode !== host) host.appendChild(goonPadEl);
    const mini = goonUi.mini != null ? goonUi.mini : !!document.fullscreenElement;
    goonPadEl.classList.toggle("is-mini", mini);
    goonPadEl.classList.toggle("is-sheet", goonSheet());
    if (goonSheet()) { goonPadEl.style.left = ""; goonPadEl.style.top = ""; return; }
    const p = readPadPos();
    const w = goonPadEl.offsetWidth || 384, h = goonPadEl.offsetHeight || 420;
    const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    const x = p ? clampN(p.x, 4, Math.max(4, vw - w - 4)) : Math.max(4, vw - w - 16);
    const y = p ? clampN(p.y, 4, Math.max(4, vh - h - 4)) : Math.max(4, vh - h - 90);
    goonPadEl.style.left = `${x}px`;
    goonPadEl.style.top  = `${y}px`;
  }
  function goonKeysHelp() {
    return `${GOON_KEY_LABEL.edge} Edge (again: let go) · ${GOON_KEY_LABEL.hold} Hold or go on · ${GOON_KEY_LABEL.cool} Cool down · ` +
           `Alt+1..${goonSet.padCount} pads (twice quickly: latch; held: keeps going) · Alt+Shift+N puts the active preset on pad N · ` +
           "Alt + wheel (or the wheel over this pad) level · right-click a pad (or Edit) to choose what it plays. " +
           "Stop: 0 or the Stop button (the bar, or the corner in fullscreen). E mutes.";
  }
  function buildGoonPad() {
    injectStyles();
    const pad = document.createElement("div");
    pad.id = `${PLUGIN_ID}-goonpad`;
    pad.setAttribute("role", "group");
    pad.setAttribute("aria-label", "Goon mode");
    const P = `${PLUGIN_ID}-gp`;
    // 1.50: no key chips on the keys (the user: "only on hover"); the key
    // is in the tooltip and aria-keyshortcuts, the full list behind the "?"
    const move = (act, label) => `<button type="button" class="${P}-move is-${act}" data-goon="${act}" ` +
      `title="${escHtml(G2_MOVE_TIPS[act])}" aria-keyshortcuts="${GOON_KEY_LABEL[act]}"><span>${label}</span></button>`;
    pad.innerHTML = `
      <div class="${P}-head" data-drag="1">
        <span class="${P}-grip" aria-hidden="true"></span>
        <strong>Goon</strong>
        <button type="button" class="${P}-style" data-goon="panel"></button>
        <span class="${P}-hsp"></span>
        <button type="button" class="${P}-x" data-goon="mini"></button>
        <button type="button" class="${P}-x ${P}-end" data-goon="off" title="${escHtml(GOON_END_TIP)}">End Goon</button>
      </div>
      <div class="${P}-status"></div>
      <div class="${P}-main">
        <div class="${P}-graph"></div>
        ${levelControl(`${P}-level`, "data-goon", "lvdown", "lvup")}
        <div class="${P}-padbar"><span>Launch pad</span>
          <button type="button" class="${P}-x ${P}-help" data-goon="help">${ic("help")}</button>
          <span class="${P}-count"><button type="button" data-goon="padless" aria-label="Fewer pads" title="Fewer pads">−</button><b></b><button type="button" data-goon="padmore" aria-label="More pads" title="More pads">+</button></span>
          <button type="button" class="${P}-edit" data-goon="edit" title="Then tap a pad to choose what it plays (or right-click a pad)"></button>
        </div>
        <div class="${P}-pads"></div>
        <div class="${P}-moves">${move("edge", "Edge")}${move("hold", "Hold")}${move("cool", "Cool down")}</div>
      </div>
      <div class="${P}-learn"></div>
      <div class="${P}-pick" hidden></div>`;
    const help = pad.querySelector(`.${P}-help`);
    help.title = goonKeysHelp(); help.setAttribute("aria-label", "Keys and how the pads work: " + goonKeysHelp());
    // 1.46: the pad stays up the whole time Goon runs, so it carries Stop too
    pad.querySelector(`.${P}-head`).appendChild(stopButton(""));
    // video.js and Stash act on clicks and keys that reach the player; in
    // fullscreen the pad is inside it, so nothing from here travels further.
    ["pointerdown", "mousedown", "click", "dblclick", "touchstart", "keydown"].forEach((t) =>
      pad.addEventListener(t, (ev) => ev.stopPropagation()));
    pad.addEventListener("click", (ev) => {
      const t = ev.target.closest ? ev.target : null;
      if (!t) return;
      const pk = t.closest("[data-pick]");
      if (pk) { ev.preventDefault(); goonPick(pk.dataset.pick); return; }
      const lv = t.closest("[data-lv]");
      if (lv) { ev.preventDefault(); goonLevel(+lv.dataset.lv); return; }
      const b = t.closest("[data-goon]");
      if (!b) return;
      ev.preventDefault();
      const act = b.dataset.goon;
      if (act === "off") goonStop("Goon mode off. Back to the pattern as it was.");
      else if (act === "help") toast(goonKeysHelp());
      else if (act === "mini") { goonUi.mini = !pad.classList.contains("is-mini"); placePad(); updateGoonUI(); }
      else if (act === "panel") {
        // 1.45: the panel lives on the body, behind a fullscreen player; there
        // the chip shows the whole pad instead
        if (document.fullscreenElement) { goonUi.mini = false; placePad(); updateGoonUI(); toast("Style and Pace are in the controls under the player, outside fullscreen."); }
        else { toggleDeck(true); if (deckEl && deckEl.scrollIntoView) deckEl.scrollIntoView({ block: "nearest" }); }
      }
      else if (act === "lvdown") goonLevel(goonSt.L - 1);
      else if (act === "lvup") goonLevel(goonSt.L + 1);
      else if (act === "padless") goonSetPadCount(goonSet.padCount - 1);
      else if (act === "padmore") goonSetPadCount(goonSet.padCount + 1);
      else if (act === "edit") { goonUi.edit = !goonUi.edit; goonUi.pick = -1; renderGoonPick(); updateGoonUI(); }
      else if (act === "forget") goonDo("forget");
      else goonDo(act);
    });
    // pads: down starts (or picks, in Edit), up lets go of a hold
    pad.addEventListener("pointerdown", (ev) => {
      const b = ev.target.closest ? ev.target.closest("[data-pad]") : null;
      if (!b || ev.button !== 0) return;
      ev.preventDefault();
      goonUi.ptr = ev.pointerType || "mouse";
      const i = +b.dataset.pad;
      if (goonUi.edit) { goonUi.pick = i; renderGoonPick(); return; }
      goonUi.downPad = i;
      try { b.setPointerCapture(ev.pointerId); } catch (_) {}
      goonPadDown(i);
    });
    const up = () => { if (goonUi.downPad >= 0) { goonPadUp(goonUi.downPad); goonUi.downPad = -1; } };
    pad.addEventListener("pointerup", up);
    pad.addEventListener("pointercancel", up);
    // right-click picks what a pad plays; a long touch is a hold (Edit on a phone)
    pad.addEventListener("contextmenu", (ev) => {
      const b = ev.target.closest ? ev.target.closest("[data-pad]") : null;
      if (!b) return;
      ev.preventDefault();
      if (goonUi.ptr === "touch") return;
      up();
      goonUi.pick = +b.dataset.pad;
      renderGoonPick();
    });
    pad.addEventListener("wheel", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      padWheel(ev);
    }, { passive: false });
    // 1.49: dragged from anywhere on it but its controls (up to 1.48 only by
    // the head, which the user did not find). A press on a control is that
    // control; anywhere else the pad captures the pointer (mouse, pen and
    // touch alike) and a move of PAD_DRAG_PX or more drags it, one that does
    // not stays a plain press. Kept inside the window; not as a bottom sheet.
    let drag = null, dragEndAt = 0;
    pad.addEventListener("pointerdown", (ev) => {
      if (goonSheet() || (ev.button != null && ev.button !== 0) || !padDragFrom(ev.target)) return;
      const r = pad.getBoundingClientRect();
      drag = { x0: ev.clientX, y0: ev.clientY, dx: ev.clientX - r.left, dy: ev.clientY - r.top, id: ev.pointerId, moved: false };
      // captured at once: a quick drag leaves the pad before it has moved
      // 5 px, and the moves would go to the page (seen in the harness). Only
      // non-controls get here, and none of them has a click of its own.
      try { pad.setPointerCapture(ev.pointerId); } catch (_) {}
    });
    pad.addEventListener("pointermove", (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const m = padDragMove(drag, ev.clientX, ev.clientY,
        { w: pad.offsetWidth || 384, h: pad.offsetHeight || 420, vw: window.innerWidth || 1200, vh: window.innerHeight || 800 });
      if (!m.moved) return;
      if (!drag.moved) {
        drag.moved = true;
        pad.classList.add("is-dragging");
      }
      ev.preventDefault();
      pad.style.left = `${m.left}px`;
      pad.style.top  = `${m.top}px`;
    });
    const endDrag = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const was = drag.moved;
      drag = null;
      pad.classList.remove("is-dragging");
      if (!was) return;                      // no move: it was a click
      dragEndAt = Date.now();
      writePadPos({ x: parseFloat(pad.style.left) || 0, y: parseFloat(pad.style.top) || 0 });
      placePad();
    };
    pad.addEventListener("pointerup", endDrag);
    pad.addEventListener("pointercancel", endDrag);
    // the click that ends a drag is not a click
    pad.addEventListener("click", (ev) => {
      if (Date.now() - dragEndAt < 250) { ev.stopPropagation(); ev.preventDefault(); }
    }, true);
    return pad;
  }
  // 1.49 (pure, tested): whether a press on el may drag the pad: not on a
  // control (a button, a field, a link, a pad, a level, a chip, the "?").
  const PAD_DRAG_PX = 5;
  function padDragFrom(el) {
    if (!el || !el.closest) return false;
    return !el.closest("button, input, select, textarea, a, label, summary, [data-pad], [data-lv], [data-pick], [data-goon], [tabindex], [contenteditable]");
  }
  // Where a drag puts the pad (pure, tested): nothing until the pointer has
  // moved PAD_DRAG_PX; then the pad follows it, kept 4 px inside the window.
  // d: { x0, y0, dx, dy, moved }; box: { w, h, vw, vh }
  function padDragMove(d, x, y, box) {
    if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < PAD_DRAG_PX) return { moved: false };
    return { moved: true,
             left: Math.round(clampN(x - d.dx, 4, Math.max(4, box.vw - box.w - 4))),
             top:  Math.round(clampN(y - d.dy, 4, Math.max(4, box.vh - box.h - 4))) };
  }
  // The pad grid: one row up to four pads, two rows above that.
  function renderGoonPads() {
    if (!goonPadEl) return;
    const P = `${PLUGIN_ID}-gp`;
    const grid = goonPadEl.querySelector(`.${P}-pads`);
    const n = goonSet.padCount;
    const infos = [];
    for (let i = 0; i < n; i++) infos.push(g2PadInfo(goonSet, presetStore, i));
    const key = JSON.stringify(infos.map((x) => [x.name, x.len, x.hue, x.gone || ""]));
    goonPadEl.querySelector(`.${P}-count b`).textContent = String(n);
    if (key === goonUi.padsKey && grid.childElementCount === n) return;
    goonUi.padsKey = key;
    grid.style.gridTemplateColumns = `repeat(${n <= 4 ? n : Math.ceil(n / 2)}, minmax(0, 1fr))`;
    // 1.50: no "Alt N" chip on the tile; the key is in the tooltip and aria-keyshortcuts
    grid.innerHTML = infos.map((x) => `<button type="button" class="${P}-pad" data-pad="${x.i}" style="--c:${g2Hue(x.hue)}" aria-keyshortcuts="Alt+${x.i + 1}"
        title="${escHtml(`${x.name}${x.gone ? ` (preset "${x.gone}" is gone)` : ""}: ${x.len} s (Alt+${x.i + 1}). Twice quickly latches; held keeps it going. Right-click to choose what it plays.`)}">
        <span class="${P}-pad-top">${g2Sketch(x).replace("<svg ", '<svg preserveAspectRatio="none" ')}<small>${x.len} s</small></span><b>${escHtml(x.name)}</b><em>${x.i + 1}</em><i></i></button>`).join("");
  }
  // What pad goonUi.pick plays: the built-in flavours, the user's presets, a
  // preset's length, or its default back.
  function renderGoonPick() {
    if (!goonPadEl) return;
    const P = `${PLUGIN_ID}-gp`;
    const el = goonPadEl.querySelector(`.${P}-pick`);
    const i = goonUi.pick;
    if (i < 0 || i >= goonSet.padCount) { el.hidden = true; el.innerHTML = ""; return; }
    const e = g2PadEntry(goonSet, presetStore, i);
    const chip = (val, label, on) => `<button type="button" class="${PLUGIN_ID}-chip${on ? " is-sel" : ""}" data-pick="${escHtml(val)}">${escHtml(label)}</button>`;
    const fl = G2_FLAVOUR_IDS.map((id) => chip(`f:${id}`, G2_FLAVOURS[id].name, e.kind === "flavour" && e.id === id)).join("");
    const pr = (presetStore.presets || []).map((p) => chip(`p:${p.name}`, p.name, e.kind === "preset" && e.name === p.name)).join("");
    const lens = e.kind === "preset" ? G2_PRESET_LENS.map((s) => chip(`l:${s}`, `${s} s`, e.len === s)).join("") : "";
    el.innerHTML = `<div class="${P}-pick-head"><b>Pad ${i + 1} plays</b><button type="button" class="${P}-x" data-pick="close" aria-label="Close">${ic("x")}</button></div>
      <div class="${P}-pick-row">${fl}</div>
      ${pr ? `<div class="${P}-pick-cap">Your presets</div><div class="${P}-pick-row">${pr}</div>` : ""}
      ${lens ? `<div class="${P}-pick-cap">How long a preset plays</div><div class="${P}-pick-row">${lens}</div>` : ""}
      <div class="${P}-pick-row"><button type="button" class="${PLUGIN_ID}-quiet" data-pick="default">Back to its default</button></div>`;
    el.hidden = false;
  }
  function goonPick(v) {
    const i = goonUi.pick;
    if (v === "close" || i < 0) { goonUi.pick = -1; renderGoonPick(); return; }
    if (v === "default") goonAssignPad(i, null);
    else if (v.startsWith("f:")) goonAssignPad(i, { f: v.slice(2) });
    else if (v.startsWith("p:")) { const e = g2PadEntry(goonSet, presetStore, i); goonAssignPad(i, { preset: v.slice(2), len: e.kind === "preset" ? e.len : 12 }); }
    else if (v.startsWith("l:")) { const e = g2PadEntry(goonSet, presetStore, i); if (e.kind === "preset") goonAssignPad(i, { preset: e.name, len: +v.slice(2) }); }
    renderGoonPick();
  }
  function showGoonPad(on) {
    if (on && !document.body) return;          // nothing to show it in
    if (on) {
      if (!goonPadEl) goonPadEl = buildGoonPad();
      goonUi.padsKey = ""; goonUi.pick = -1; goonUi.edit = false;
      placePad();
      goonPadEl.classList.add("is-on");
      renderGoonPads();
      renderGoonPick();
      placePad();
    } else if (goonPadEl) {
      goonPadEl.classList.remove("is-on");
      goonPadEl.remove();
    }
  }
  function padWheel(ev) {
    if (!goonOn || !goonSt) return;
    const r = goonWheel(goonWheelAcc, ev, Date.now());
    goonWheelAcc = r.acc;
    if (r.step) goonLevel(goonSt.L + r.step);
  }

  function updateGoonUI() {
    updateFsPill();
    const lim = goonLim();
    const ro = goonOn && goonSt ? g2Readout(lim, goonSt, g2Mot()) : null;
    const P = `${PLUGIN_ID}-gp`;
    const styleName = (G2_STYLES.find((s) => s[0] === goonSet.style) || G2_STYLES[0])[1];
    const paceName = (G2_PACES.find((p) => p[0] === goonSet.pace) || G2_PACES[1])[1];
    const status = (r, small) => r ? `<span class="${PLUGIN_ID}-g2-chip" style="--c:${g2Hue(r.hue)}">${escHtml(r.label)}</span>` +
      (r.left != null ? `<b class="${PLUGIN_ID}-g2-left">${mmss(r.left)}</b>` : "") +
      (r.held ? `<span class="${PLUGIN_ID}-g2-held">Held</span>` : "") +
      (!outputOn ? `<span class="${PLUGIN_ID}-g2-held" title="Muted: Goon waits (no clock, no Pace) and goes on from here when unmuted">Muted · waiting</span>` : "") +
      (outputOn && pauseHold ? `<span class="${PLUGIN_ID}-g2-held" title="The video is paused: silent, Goon waits (no clock, no Pace) and goes on from here on play">Paused · silent</span>` : "") +
      (goonSource ? `<span class="${PLUGIN_ID}-g2-src" title="Started from ${escHtml(goonSourceName(goonSource))}; ending that run ends Goon. End Goon and Stop work as always.">Started by ${escHtml(goonSourceName(goonSource))}</span>` : "") +
      `<span class="${PLUGIN_ID}-g2-then" title="${escHtml(r.then)}">${escHtml(small && r.then.startsWith("Coming up: ") ? "Next: " + r.then.slice(11) : r.then)}</span>` : "";
    if (goonPadEl && goonOn && goonSt) {
      placePadHostOnly();
      const mini = goonPadEl.classList.contains("is-mini");
      goonPadEl.classList.toggle("is-held", !!goonSt.held);
      goonPadEl.classList.toggle("is-edit", goonUi.edit);
      // 1.50: the style as its sketch and a short name (the full "Steady
      // climb · Normal" was cut to "Ste…" in the user's screenshot)
      const sb = goonPadEl.querySelector(`.${P}-style`);
      const shortName = G2_STYLE_SHORT[goonSet.style] || styleName;
      const sHtml = `<span class="${P}-sk">${g2StyleSketch(goonSet.style, true)}</span><span>${escHtml(shortName)}</span>`;
      if (sb.dataset.html !== sHtml) { sb.innerHTML = sHtml; sb.dataset.html = sHtml; }
      sb.title = `${styleName}, Pace ${paceName}. Style, Pace and what Goon is built on: the controls under the player.`;
      sb.setAttribute("aria-label", `Style ${styleName}, Pace ${paceName}: open the controls under the player`);
      const mb = goonPadEl.querySelector(`[data-goon="mini"]`);
      mb.innerHTML = ic(mini ? "up" : "down");
      mb.setAttribute("aria-label", mini ? "Show the whole pad" : "Make the pad smaller");
      mb.title = mb.getAttribute("aria-label");
      goonPadEl.querySelector(`.${P}-status`).innerHTML = status(ro, true);
      // 1.50: 30 s back and 60 ahead (the past was half an empty graph), no
      // close-up strip (the deck has it), the scale just over the limit
      g2GraphFor(goonPadEl.querySelector(`.${P}-graph`), false, mini ? 30 : 30, mini ? 90 : 60, 0);
      paintLevel(goonPadEl.querySelector(`.${PLUGIN_ID}-lvctl`), ro.level, ro.playing, goonSet.level);
      renderGoonPads();
      goonPadEl.querySelectorAll(`.${P}-pad`).forEach((b) => {
        const i = +b.dataset.pad, p = goonSt.pad && !goonSt.move && goonSt.pad.i === i ? goonSt.pad : null;
        b.classList.toggle("is-on", !!p);
        b.classList.toggle("is-latched", !!(p && p.latch));
        const bar = b.querySelector("i");
        if (bar) bar.style.width = p ? `${p.latch || p.t >= p.len ? 100 : Math.round(p.t / p.len * 100)}%` : "0";
        const sm = b.querySelector("small");
        if (sm) sm.textContent = p ? (p.latch ? "latched" : p.t >= p.len ? "held" : `${(p.len - p.t).toFixed(1)} s`) : `${g2PadInfo(goonSet, presetStore, i).len} s`;
      });
      goonPadEl.querySelector(`.${P}-edit`).textContent = goonUi.edit ? "Done" : "Edit";
      const e = goonPadEl.querySelector(`[data-goon="edge"] span`);
      if (e) e.textContent = goonSt.move && goonSt.move.k === "edge" ? "Let go" : "Edge";
      goonPadEl.querySelector(`[data-goon="edge"]`).classList.toggle("is-active", !!(goonSt.move && goonSt.move.k === "edge"));
      goonPadEl.querySelector(`[data-goon="cool"]`).classList.toggle("is-active", !!(goonSt.move && goonSt.move.k === "cool"));
      const hb = goonPadEl.querySelector(`[data-goon="hold"] span`);
      if (hb) hb.textContent = goonSt.held ? "Go on" : "Hold";
      goonPadEl.querySelector(`[data-goon="hold"]`).classList.toggle("is-active", !!goonSt.held);
      const lt = g2LearnText(goonSt.learn);
      goonPadEl.querySelector(`.${P}-learn`).innerHTML = lt
        ? `<span class="${PLUGIN_ID}-g2-learned">Learned</span> <span>${escHtml(lt)}</span> <button type="button" class="${PLUGIN_ID}-g2-link" data-goon="forget">Forget</button>` : "";
    }
    // 1.46: the deck's Goon part (the panel section is gone); the pill and
    // the deck's mode labels follow the clock
    if (deckEl && (currentMode() === "goon" || deckEl.dataset.current === "goon")) updateDeck();
    paintBar();
  }
  // in fullscreen the pad has to live inside the fullscreen element
  function placePadHostOnly() {
    const host = document.fullscreenElement || document.body;
    if (goonPadEl && (goonPadEl.parentNode !== host || !goonPadEl.isConnected || goonPadEl.classList.contains("is-sheet") !== goonSheet())) { placePad(); return; }
    // 1.49: kept inside the window (placed while its size was not known yet,
    // or the window got smaller): seen in the harness, half the pad off screen
    if (goonPadEl && !goonSheet() && !goonPadEl.classList.contains("is-dragging")) {
      const x = parseFloat(goonPadEl.style.left) || 0, y = parseFloat(goonPadEl.style.top) || 0;
      const w = goonPadEl.offsetWidth || 0, h = goonPadEl.offsetHeight || 0;
      if (w && (x + w > (window.innerWidth || 1200) - 2 || y + h > (window.innerHeight || 800) - 2)) placePad();
    }
  }

  // The suite's switch (26x15 track, 11px knob): a button holding the track
  // and its label, lit with is-on.
  function setTog(btn, on, label) {
    btn.classList.add(`${PLUGIN_ID}-tog`);
    btn.classList.toggle("is-on", !!on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.innerHTML = `<i aria-hidden="true"></i><span>${escHtml(label)}</span>`;
  }

  function updateHotkeyBtn() {
    const btn = byId(`${PLUGIN_ID}-hotkey-btn`);
    if (!btn) return;
    if (!hotkeysAllowed) {
      setTog(btn, false, "Keyboard shortcuts (off in plugin settings)");
      btn.title = "Turned off for every browser in Settings \u203a Plugins \u203a Intiface Sync " +
                  "(Turn off keyboard shortcuts), which overrides this button. " +
                  "Every control is still available here in the toolbar.";
      btn.classList.add("is-locked");
      return;
    }
    btn.classList.remove("is-locked");
    setTog(btn, hotkeysOn, "Keyboard shortcuts in this browser");
    // Two switches, one meaning: this button is per browser, the plugin
    // setting ("Turn off keyboard shortcuts") is for every browser and wins.
    btn.title = "0 Stop \u00b7 E mute \u00b7 \\ manual \u00b7 [ ] or - = strength \u00b7 Alt+1..4 the first four preset cards \u00b7 " +
                "Goon mode: Alt+W Edge, Alt+A Hold, Alt+Q Cool down, Alt+1..8 its pads, Alt + wheel level. " +
                "This switch is for this browser only; Settings \u203a Plugins \u203a Intiface Sync " +
                "can turn the shortcuts off everywhere.";
  }

  function updateManualHint() {
    // The single most useful number is whether the peak lands above or below
    // the motor's own floor, because that decides whether Micro does anything.
    const hint = byId(`${PLUGIN_ID}-manual-hint`);
    if (!hint) return;
    const peak     = (manualLevel / 100) * (manualCeiling / 100);
    const pct      = (peak * 100).toFixed(1);
    const floorPct = (scalarStep * 100).toFixed(0);
    if (peak <= 0) {
      hint.textContent = "Silent. Raise the intensity slider.";
    } else if (peak < scalarStep) {
      hint.textContent = vibeSubstep
        ? `Peak ${pct}%, below this motor's ${floorPct}% floor. Micro pulsing is producing it.`
        : `Peak ${pct}%, below this motor's ${floorPct}% floor. Turn Micro on or it will stay silent.`;
    } else {
      hint.textContent = `Peak ${pct}%. This motor's floor is ${floorPct}%, so Micro is idle.`;
    }
  }

  function updateManualUI() {
    updateFunscriptSelector();          // the pill, the deck and its Strength too (updateModeSeg)


    // Highlight the chosen card.
    if (manualPop) {
      manualPop.querySelectorAll(`.${PLUGIN_ID}-card`).forEach((c) => {
        c.classList.toggle("is-sel", c.dataset.shape === manualShape);
      });
    }

    // Only show the fields the current pattern actually reads. Anything else
    // is noise the user would reasonably expect to do something.
    const burst = manualShape === "pulse" || manualShape === "tease";
    const tidal = manualShape === "tidal";      // 1.49
    const shown = {
      period:  manualShape !== "constant",
      onms:    burst || tidal,
      depth:   manualShape === "wave" || manualShape === "ramp" || manualShape === "random",
      build:   manualShape === "tease",
      onfrom:  (manualShape === "tease" && manualBuild > 0) || tidal,
      buildamp: manualShape === "tease",
      ampfrom: manualShape === "tease" && manualBuildAmp > 0,
      ceiling: true,
      microms: vibeSubstep,
    };
    Object.keys(shown).forEach((k) => {
      const box = byId(`${PLUGIN_ID}-manual-${k}-box`);
      if (box) box.style.display = shown[k] ? "" : "none";
    });

    // Burst patterns are "one buzz every N seconds"; the rest are a cycle
    // length. Same field, different meaning, so relabel rather than explain.
    const perBox = byId(`${PLUGIN_ID}-manual-period-box`);
    if (perBox) {
      const lab  = perBox.querySelector("label");
      const help = perBox.querySelector(`.${PLUGIN_ID}-field-help`);
      if (lab)  lab.textContent  = tidal ? "A phrase every" : burst ? "Repeat every" : "Cycle length";
      if (help) help.textContent = tidal
        ? "On average, from the start of one phrase of buzzes to the next. Closer at high tide, further apart at low tide (a 40 s breath)."
        : burst
        ? "Time from the start of one buzz to the start of the next."
        : "How long one full rise and fall takes.";
    }

    // With a length build-up, "Buzz length" is where the buzzes end up.
    const onBox = byId(`${PLUGIN_ID}-manual-onms-box`);
    if (onBox) {
      const growing = manualShape === "tease" && manualBuild > 0;
      const lab  = onBox.querySelector("label");
      const help = onBox.querySelector(`.${PLUGIN_ID}-field-help`);
      if (lab)  lab.textContent  = tidal ? "Longest buzz" : growing ? "Final buzz length" : "Buzz length";
      if (help) help.textContent = tidal
        ? "The long end of the buzzes (holds at a phrase's end are 0.8-1.2 s on top)."
        : growing
        ? "How long the buzzes get once the length build-up is done."
        : "How long each buzz lasts. Short feels like a tap, long like a throb.";
    }
    // 1.49: Tidal's other end of the range uses the starting-length field
    const fromBox = byId(`${PLUGIN_ID}-manual-onfrom-box`);
    if (fromBox) {
      const lab  = fromBox.querySelector("label");
      const help = fromBox.querySelector(`.${PLUGIN_ID}-field-help`);
      if (lab)  lab.textContent  = tidal ? "Shortest buzz" : "Starting buzz length";
      if (help) help.textContent = tidal
        ? "The short end of the buzzes. 0.1 s is the shortest a buzz can be."
        : "How long the first buzz is. Each one after it grows a little until it reaches the buzz length above.";
    }

    // The timing section can end up with nothing in it (Steady).
    const timing = byId(`${PLUGIN_ID}-sec-timing`);
    if (timing) {
      const any = ["period", "onms", "depth", "build", "buildamp", "onfrom"].some(
        (k) => shown[k]
      );
      timing.style.display = any ? "" : "none";
    }

    knobs.forEach((k) => k.refresh());
    const dw = byId(`${PLUGIN_ID}-depth-warn`);
    if (dw) {
      const txt = depthWarning({ shape: manualShape, depth: manualDepth, ceiling: manualCeiling, level: manualLevel, step: scalarStep * 100 });
      dw.textContent = txt;
      dw.style.display = txt ? "" : "none";
    }
    updateManualHint();
    updatePresetUI();
    updateGoonUI();
    if (manualPop?.classList.contains("is-open")) updateFavUI();
    drawPatternPreview();
  }

  // ── GraphQL ────────────────────────────────────────────────────────────────
  // Throws on an HTTP error, a reply that is not JSON, or GraphQL errors, with
  // a sentence a person can read. It used to send no credentials and hand
  // back null for all of those, so a lapsed login looked like "no scene" or
  // "no settings" (audit A11). Every caller catches; none of them is on the
  // safety path, which lives in the backend (deadman, disconnect, _panic).
  async function gqlQuery(query, variables = {}) {
    const resp = await fetch("/graphql", {
      method:      "POST",
      credentials: "same-origin",
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify({ query, variables }),
    });
    let data;
    try { data = await resp.json(); }
    catch (_) {
      throw new Error(resp.ok ? "Stash sent a reply that is not JSON"
        : resp.status === 401 || resp.status === 403 ? `Stash returned ${resp.status}: logged out?`
        : `Stash returned ${resp.status}`);
    }
    if (data?.errors?.length) throw new Error(data.errors[0].message || "GraphQL error");
    if (!resp.ok) throw new Error(`Stash returned ${resp.status}`);
    return data?.data ?? null;
  }

  // null when the scene cannot be read; the error goes to the console and
  // the toolbar's status line instead of vanishing.
  async function getSceneDetails(sceneId) {
    const q = `
      query ($id: ID!) {
        findScene(id: $id) {
          id
          title
          interactive
          paths { funscript }
          files { path duration }
          performers { id name }
          studio { id name }
        }
      }`;
    try {
      const data = await gqlQuery(q, { id: sceneId });
      return data?.findScene ?? null;
    } catch (e) {
      log(`Could not read scene ${sceneId}: ${e.message}`, "error");
      sceneReadError = e.message;
      return null;
    }
  }

  async function loadPluginConfig() {
    const q = `query { configuration { plugins } }`;
    const data = await gqlQuery(q);
    const plugins = data?.configuration?.plugins ?? {};
    return plugins[PLUGIN_ID] ?? {};
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  // Messages any tab may send. Everything else only goes out from the driver;
  // the backend enforces the same rule, this just avoids the noise.
  const ANY_TAB = new Set(["hello", "presence", "claim", "ping", "status", "findFunscripts"]);
  const isKillSwitch = (o) => o.type === "stop" || o.type === "halt" ||
    ((o.type === "output" || o.type === "manual") && o.enabled === false);

  function sendMsg(obj) {
    if (!ws || !wsReady) return;
    if (!isOwner && !ANY_TAB.has(obj.type) && !isKillSwitch(obj)) return;
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  // Tab close. Closing the socket is enough: the backend panics when the
  // driving tab disconnects, and the deadman covers the cases where no close
  // frame ever arrives. No "stop" here any more: that also disconnected
  // Intiface, which the next tab to drive would then have to redo.
  window.addEventListener("pagehide", () => {
    if (ws) { try { ws.close(); } catch (_) {} }
  });

  // force: the Connect button. A plain connect is ignored by the backend when
  // the device link is already up, so taking over a tab does not drop it.
  function autoConnectIntiface(force = false) {
    if (pluginOff) return;
    if (mode !== "intiface" || (!force && (intifaceReady || connectingToIntiface))) return;
    // The last try found no Intiface server: an automatic retry (a tab
    // taking over) waits, Retry does not. See NOSERVER_RETRY_MS.
    if (!force && Date.now() - noServerAt() < NOSERVER_RETRY_MS) {
      log("No Intiface server a moment ago; not retrying on its own yet (Retry tries now)", "debug");
      updateToolbarStatus();
      return;
    }
    connectingToIntiface = true;
    updateToolbarStatus();
    loadPluginConfig().then((cfg) => {
      if (typeof cfg?.enableHandy === "boolean" && cfg.enableHandy !== handyEnabled) {
        handyEnabled = cfg.enableHandy;
        applyHandyVisibility();
      }
      if (typeof cfg?.disableHotkeys === "boolean") {
        hotkeysAllowed = !cfg.disableHotkeys;
        updateHotkeyBtn();
      }
      const url = cfg?.intifaceUrl || "ws://localhost:12345";
      lastIntifaceUrl = url;
      log(`Auto-connecting to Intiface: ${url}`);
      sendMsg({ type: "connect", url, force });
      if (currentScenePath) pendingFindFunscripts = { videoPath: currentScenePath };
    }).catch((e) => {
      // No settings, no connect: the Intiface URL is one of them. Nothing
      // is sent to the toy, which is the safe way to fail; say why.
      connectingToIntiface = false;
      log(`Could not read the plugin settings: ${e.message}`, "error");
      showInfoFor(`Could not read the plugin settings: ${e.message}`, 8000);
    });
  }

  // Connect button: make the backend exist first, then talk to Intiface.
  // The backend is a Stash plugin task, so if the socket is down we run the task
  // ourselves rather than making the user go to Settings and start it by hand.
  function requestIntifaceConnect() {
    intifaceReady        = false;
    connectingToIntiface = false;

    if (wsReady) {
      if (!isOwner) tryTakeover("button");     // Connect is an explicit request
      autoConnectIntiface(true);
      return;
    }

    // Explicit press, so ignore the cooldown that throttles the automatic path,
    // and the no-server wait: the connect that follows the backend start is
    // the one asked for.
    noteNoServer(0);
    pendingIntifaceConnect = true;
    backendStartCooldown   = 0;
    autoStartCount         = 0;
    backendStartGaveUp     = false;
    updateToolbarInfo("Starting backend...");
    log("Connect pressed with backend down, starting it");
    startBackendTask(true).then(() => {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectBackend, 1500);
    });
  }

  // Is a Start Backend job already waiting or running in Stash's queue?
  function startBackendQueued(jobs) {
    return (jobs || []).some((j) => j && /Start Backend$/.test(String(j.description || "")) && ["READY", "RUNNING"].includes(String(j.status || "")));
  }

  // Ask Stash to run the plugin's own "Start Backend" task.
  //
  // Guarded three ways, because a failing backend used to mean one queued task
  // every 20s forever, multiplied by every open tab:
  //   - at most MAX_AUTO_STARTS automatic attempts per page session
  //   - at most one submission per START_COOLDOWN, shared across tabs
  //   - pressing Connect resets the counter, since that is explicit intent
  async function startBackendTask(manual = false) {
    if (pluginOff || backendStartInFlight) return;
    if (!manual && backendStartGaveUp) return;
    if (!manual && autoStartCount >= MAX_AUTO_STARTS) {
      backendStartGaveUp = true;
      log(`Gave up after ${MAX_AUTO_STARTS} attempts; start the backend manually`, "error");
      updateToolbarInfo("Backend will not start - run Start Backend in Settings");
      return;
    }

    const now = Date.now();
    if (!manual && now - lastStartAt() < START_COOLDOWN) {
      log("Start Backend suppressed, another attempt was too recent", "debug");
      return;
    }

    backendStartInFlight = true;
    noteStartAt(now);
    backendStartCooldown = now + START_COOLDOWN;
    if (!manual) autoStartCount++;
    updateToolbarInfo("Starting backend...");
    log(`Running 'Start Backend' task (attempt ${autoStartCount}/${MAX_AUTO_STARTS}${manual ? ", manual" : ""})`);

    const m = `
      mutation ($plugin_id: ID!, $task_name: String!) {
        runPluginTask(plugin_id: $plugin_id, task_name: $task_name)
      }`;
    // 1.42 (user: "can't Intiface Sync start without relying on the task
    // scheduler?"): start it as a plugin operation, which Stash runs at once
    // instead of queueing behind other jobs. main() starts the daemon the
    // same way for both and returns within ~10 s. Only if that call fails
    // (an older Stash, an error) does the queued task below run.
    try {
      await gqlQuery(`mutation ($p: ID!, $a: Map) { runPluginOperation(plugin_id: $p, args: $a) }`, { p: PLUGIN_ID, a: { mode: "startBackend" } });
      log("Backend started directly (not through Stash's task queue)");
      backendStartInFlight = false;
      return;
    } catch (e) {
      log(`Direct start failed (${e}); using the Start Backend task`, "debug");
    }
    try {
      // 1.42: Stash runs one job at a time, so behind a long Generate the task
      // waits; every page load and device then queued its own (user saw eight
      // "Start Backend" jobs waiting). One already waiting or running is enough.
      try {
        const q = await gqlQuery("query { jobQueue { status description } }");
        if (startBackendQueued(q && q.jobQueue)) {
          log("Start Backend is already in Stash's queue; not adding another");
          updateToolbarInfo("Backend start is waiting in Stash's task queue");
          return;
        }
      } catch (_) { /* cannot read the queue: submit as before */ }
      await gqlQuery(m, { plugin_id: PLUGIN_ID, task_name: "Start Backend" });
      log("Start Backend task submitted");
    } catch (e) {
      log(`Could not run Start Backend task: ${e}`, "error");
    } finally {
      backendStartInFlight = false;
    }
  }

  // ── Restart, Stop and Start the backend from the player (1.49) ──
  // The user: a Restart backend in the settings and in the bar's fix-it
  // button when the backend is old or down, instead of Settings › Tasks.
  // The same operations as the tasks: runPluginOperation mode stopBackend
  // (stop_backend(): SIGTERM, whose handler sets the stop event, and the
  // backend's shutdown runs _panic("backend shutdown") before it drops the
  // Intiface link; SIGKILL only if it has not gone after 5 s) and mode
  // startBackend (1.42, startBackendTask). The stop part could leave a toy
  // running only if the process were killed before its shutdown ran, so
  // the page stops the toy first: stopAll() (Stop, halt -> _panic()), then
  // the process. Stop backend asks for a second click (3 s). Progress is in
  // the pill and the settings; the new backend's version is said when its
  // first status arrives. After a stop nothing starts it by itself in this
  // page session (the socket close handler starts a backend only when it
  // never reached one); Start, Restart or Connect do.
  const BACKEND_CTL_MS   = 25000;    // a stop or start operation at most this long
  const BACKEND_ARM_MS   = 3000;     // Stop backend's second click within this
  let backendCtlStep = "";           // "" | "stopping" | "starting" | "connecting"
  let backendCtlKind = "";
  let backendCtlArm  = 0;
  let backendCtlWant = false;        // waiting for the new backend's first status
  let backendCtlT    = null;
  function backendCtlText() {
    if (!backendCtlStep) return "";
    return { stopping: "Stopping the backend…", starting: "Starting the backend…",
             connecting: "Connecting to the new backend…" }[backendCtlStep] || "";
  }
  const withTimeout = (pr, ms, what) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms))]);
  function backendCtlPaint() { updateToolbarStatus(); paintBar(); if (settingsPop) updateSettingsUI(); }
  async function backendCtl(kind) {
    if (pluginOff || backendCtlStep || !["restart", "stop", "start"].includes(kind)) return "";
    if (kind === "stop" && Date.now() - backendCtlArm > BACKEND_ARM_MS) {
      backendCtlArm = Date.now();
      toast("Click Stop backend again to stop it. The toy stops; nothing reaches it until the backend is started again.", "warn", BACKEND_ARM_MS);
      backendCtlPaint();
      setTimeout(backendCtlPaint, BACKEND_ARM_MS + 50);
      return "armed";
    }
    backendCtlArm = 0;
    backendCtlKind = kind;
    const op = `mutation ($p: ID!, $a: Map) { runPluginOperation(plugin_id: $p, args: $a) }`;
    try {
      if (kind !== "start") {
        // the toy first (halt -> _panic), then the process (its SIGTERM panics again)
        if (wsReady) stopAll();
        backendCtlStep = "stopping";
        backendCtlPaint();
        log(`${kind === "restart" ? "Restart" : "Stop"} backend: stopping it`);
        await withTimeout(gqlQuery(op, { p: PLUGIN_ID, a: { mode: "stopBackend" } }), BACKEND_CTL_MS, "Stopping the backend");
        if (kind === "stop") {
          backendCtlStep = "";
          toast("Backend stopped. Start backend (the settings or the bar) starts it again.", "info", 6000);
          backendCtlPaint();
          return "stopped";
        }
      }
      backendCtlStep = "starting";
      backendCtlPaint();
      backendStartGaveUp = false; autoStartCount = 0;
      await withTimeout(startBackendTask(true), BACKEND_CTL_MS, "Starting the backend");
      backendCtlStep = "connecting";
      backendCtlWant = true;
      backendCtlPaint();
      clearTimeout(reconnectTimer);
      reconnectDelay = 3000;
      reconnectTimer = setTimeout(connectBackend, 800);
      clearTimeout(backendCtlT);
      backendCtlT = setTimeout(() => {
        if (backendCtlStep !== "connecting") return;
        backendCtlStep = ""; backendCtlWant = false;
        toast("The backend was started but has not answered yet. It may still be starting (or see Settings › Logs in Stash).", "warn", 8000);
        backendCtlPaint();
      }, 15000);
      return "started";
    } catch (e) {
      backendCtlStep = ""; backendCtlWant = false;
      log(`Backend ${kind} failed: ${e.message || e}`, "error");
      toast(`Could not ${kind} the backend: ${e.message || e}. Settings › Tasks › Intiface Sync has Stop Backend and Start Backend.`, "error", 9000);
      backendCtlPaint();
      return "error";
    }
  }
  // The new backend's first status: say its version (1.49).
  function backendCtlStatus(msg) {
    if (!backendCtlWant || !msg) return;
    backendCtlWant = false;
    backendCtlStep = "";
    clearTimeout(backendCtlT);
    const v = msg.version || "before 1.30";
    if (v === PLUGIN_VERSION) toast(`Backend ${backendCtlKind === "start" ? "started" : "restarted"}: ${v}.`, "done", 5000);
    else toast(`Backend ${backendCtlKind === "start" ? "started" : "restarted"}, but it is ${v} and this page is ${PLUGIN_VERSION}: ` +
               "copy the new IntifaceSync.py into Stash's plugin folder, then Restart backend.", "warn", 10000);
  }

  // The Handy path is off unless the plugin setting turns it on. When hidden the
  // mode switch and the key panel go away and Intiface is forced.
  function applyHandyVisibility() {
    const wrap  = byId(`${PLUGIN_ID}-mode-wrap`);
    const panel = byId(`${PLUGIN_ID}-handy-panel`);
    if (wrap)  wrap.style.display  = handyEnabled ? "inline-flex" : "none";
    if (panel && !handyEnabled) panel.style.display = "none";
    if (!handyEnabled && mode !== "intiface") {
      mode = "intiface";
      saveSettingsToStorage();
      sendMsg({ type: "setMode", mode: "intiface" });
      log("Handy disabled in plugin settings, forcing Intiface mode");
    }
  }

  loadPluginConfig().then((cfg) => {
    if (typeof cfg?.enableHandy === "boolean") handyEnabled = cfg.enableHandy;
    if (typeof cfg?.disableHotkeys === "boolean") {
      hotkeysAllowed = !cfg.disableHotkeys;
      if (!hotkeysAllowed) log("Keyboard shortcuts disabled in plugin settings");
      updateHotkeyBtn();
    }
    applyHandyVisibility();
  }).catch((e) => log(`Could not read the plugin settings: ${e.message}`, "error"));

  function connectBackend() {
    // "Not using it": no socket, so nothing to retry and no task to start.
    if (pluginOff) return;
    if (ws) { try { ws.close(); } catch (_) {} }
    ws = new WebSocket(BACKEND_URL);
    const sock = ws;

    ws.addEventListener("open", () => {
      if (ws !== sock) { try { sock.close(); } catch (_) {} return; }
      wsReady             = true;
      backendEverConnected = true;
      backendStartCooldown = 0;
      autoStartCount       = 0;
      backendStartGaveUp   = false;
      reconnectDelay       = 3000;
      clearTimeout(reconnectTimer);
      log(`Connected to backend (${BACKEND_URL})`);
      isOwner = false;                  // the backend says who drives
      sendMsg({ type: "hello", ...presence() });
      if (pendingIntifaceConnect) {
        pendingIntifaceConnect = false;
        log("Backend up, resuming the requested Intiface connection");
      }
      if (pendingFindFunscripts !== null) {
        askFunscripts(pendingFindFunscripts.videoPath);
        pendingFindFunscripts = null;
      }
      // Ask to drive. Granted when nobody else is playing; otherwise this tab
      // waits as a spectator until play or Take over.
      tryTakeover("open");

      // Heartbeat feeds the backend deadman, which only listens to the
      // driver. While the video plays it also carries currentTime, so the
      // backend can correct clock drift instead of free-running.
      if (statusPollInterval) statusPollInterval.stop();
      statusPollInterval = startTicker(2000, () => {
        if (!wsReady || !isOwner) return;
        refreshPauseHold();       // 1.49: a missed video event cannot leave it stale
        if (!intifaceReady) { sendMsg({ type: "status" }); return; }
        if (videoEl && !videoEl.paused && !videoEl.ended) {
          sendMsg({ type: "sync", time: videoEl.currentTime * 1000, rate: videoEl.playbackRate });
        } else {
          sendMsg({ type: "ping" });
        }
      });
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleBackendMessage(msg);
    });

    ws.addEventListener("close", () => {
      // A replaced socket (goOff() clears ws before closing it) must not
      // reset the live one's state or schedule a reconnect.
      if (ws !== sock) return;
      wsReady       = false;
      intifaceReady = false;
      isOwner       = false;
      findAsked = null; loadAsked = null;     // their answers will not come on a closed socket
      if (statusPollInterval) { statusPollInterval.stop(); statusPollInterval = null; }
      updateToolbarStatus();
      if (pluginOff) return;

      // Never reached the backend: it is probably not running. Start it.
      if ((!backendEverConnected || pendingIntifaceConnect) && !backendStartGaveUp) {
        startBackendTask();
        reconnectTimer = setTimeout(connectBackend, 4000);
        return;
      }

      // Given up on auto-start: keep a slow socket retry so a manually started
      // backend is still picked up, but submit no further tasks.
      if (backendStartGaveUp) {
        pendingIntifaceConnect = false;
        reconnectTimer = setTimeout(connectBackend, 15000);
        return;
      }

      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        connectBackend();
      }, reconnectDelay);
    });

    ws.addEventListener("error", () => { if (ws === sock) wsReady = false; });
  }

  // ── Backend messages ───────────────────────────────────────────────────────
  function handleBackendMessage(msg) {


    if (msg.type === "info") {
      log(`Backend: ${msg.message}`, "debug");
      updateToolbarInfo(msg.message);
      return;
    }

    if (msg.type === "event") {
      log(msg.message, msg.level);
      // The suite's toast as well as the status line: a safety stop is
      // exactly the message nobody should miss because the bar was folded.
      toast(msg.message, msg.safety || msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "info",
            msg.safety ? 15000 : undefined);
      updateToolbarInfo(msg.message);
      eventInfoActive = true;
      clearTimeout(eventInfoTimer);
      if (msg.safety) autoManualActive = false;
      eventInfoTimer = setTimeout(() => {
        eventInfoActive = false;
        updateToolbarStatus();
      }, msg.safety ? 15000 : 4000);

      if (msg.uploaded && videoEl && !videoEl.paused && !videoEl.ended && !haltHeld) {
        const t = videoEl.currentTime * 1000;
        sendMsg({ type: "play", time: t });
        log(`Resume device at ${t.toFixed(0)}ms after upload`, "debug");
      }
      return;
    }


    if (msg.type === "overview") {
      flowOverview = Array.isArray(msg.levels) ? msg : null;
      if (typeof drawOverview === "function") drawOverview();
      return;
    }

    if (msg.type === "echo") {     // 1.44: what reached the motor, for Goon's graph
      goonOnEcho(msg);
      return;
    }

    if (msg.type === "preview") {
      if (!previewOn || !Array.isArray(msg.samples)) return;
      if (msg.script) previewScript = msg.script;
      const now = msg.samples.length ? msg.samples[msg.samples.length - 1].t : 0;
      previewSamples.push(...msg.samples);
      // trim to the visible window, plus a little slack
      const cutoff = now - PREVIEW_WINDOW_MS - 500;
      if (previewSamples.length > 4000 || (previewSamples[0] && previewSamples[0].t < cutoff)) {
        previewSamples = previewSamples.filter((p) => p.t >= cutoff);
      }
      return;
    }

    if (msg.type === "status") {
      statusData = msg;
      backendStatusSeen = true;
      backendCtlStatus(msg);          // 1.49: after Restart / Start backend, say its version
      applyDriver(msg);
      if (typeof msg.outputEnabled === "boolean" && msg.outputEnabled !== outputOn) {
        outputOn = msg.outputEnabled;
        updateOutputUI();
      }
      if (typeof msg.manual === "boolean" && msg.manual !== manualOn) {
        manualOn = msg.manual;
        // Deliberately not clearing autoManualActive here: a status sent just
        // before our own manual message says "off", and trusting it made the
        // plugin forget it had turned manual on, so pause left it running.
        updateManualUI();
        if (manualOn) { pauseZeroSent = false; refreshPauseHold(); }   // 1.49: held while paused
      }
      // The device tells us its real resolution, so the panel can say how far
      // under the floor the current settings actually sit.
      if (typeof msg.scalarStep === "number" && msg.scalarStep > 0 &&
          msg.scalarStep !== scalarStep) {
        scalarStep = msg.scalarStep;
        updateManualUI();
        updateMicroButtons();
      }
      updateToolbarStatus();
      updateScriptUI();
      updateFunscriptSelector();
      if (msg.error) log(`Backend error: ${msg.error}`, "error");
      if (mode === "intiface" && isOwner) {
        if (msg.error && /^Failed to connect/.test(msg.error)) {
          noteNoServer(Date.now());
          connectingToIntiface = false;
        } else if (msg.connected && noServerAt()) {
          noteNoServer(0);
        }
      }

      if (mode === "intiface" && isOwner) {
        if (msg.connected && !intifaceReady) {
          intifaceReady        = true;
          connectingToIntiface = false;
          // a reconnect gives us a fresh player with no script, so always re-ask
          const path = pendingFindFunscripts?.videoPath ?? currentScenePath;
          pendingFindFunscripts = null;
          if (path) {
            funscriptLoaded = false;
            askFunscripts(path);
          }
        }
      } else if (isOwner) {
        if (msg.connected && !intifaceReady) {
          intifaceReady = true;
          if (pendingFindFunscripts !== null) {
            askFunscripts(pendingFindFunscripts.videoPath);
            pendingFindFunscripts = null;
          }
        }
        if (msg.tunnelUrl) updateTunnelUrlDisplay(msg.tunnelUrl);
      }

      if (!msg.error && funscriptLoaded === "pending") {
        funscriptLoaded = true;
        loadAsked = null;
        updateFunscriptSelector();
        // The video kept going while the script loaded: start from where it
        // is now, not from where it was when play was pressed. And start even
        // with no play queued: a queued next scene can keep one element
        // playing across the change, so no play event ever arrives for it.
        // Not after Stop (haltHeld): only the user's own play starts it again.
        const v = liveVideo();
        if (haltHeld) {
          // nothing
        } else if (v && !v.paused && !v.ended) {
          sendMsg({ type: "play", time: v.currentTime * 1000, rate: v.playbackRate });
        } else if (pendingPlay !== null) {
          sendMsg({ type: "play", time: pendingPlay.time, rate: pendingPlay.rate ?? 1 });
        }
        pendingPlay = null;
      }
      return;
    }

    if (msg.type === "funscripts") {
      findAsked = null;
      funscripts = msg.files ?? [];
      const defaultScript = msg.default ?? null;
      log(`Funscripts received: ${funscripts.length} file(s)`);
      sceneScriptPending = false;

      if (funscripts.length === 0) {
        pendingPlay = null;
        sceneHasNoScript = true;
        applyScriptSettingsFor(null);
        updateFunscriptSelector();
        // the previous scene's script must not play against this video
        if (isOwner) sendMsg({ type: "unloadScript" });
        autoManualCheck();
        autoManualSettle();     // a pattern carried over from the last scene keeps going only if playing
      } else {
        // This scene has a script, so a pattern carried over from a scriptless
        // one ends now, before the script starts.
        autoManualStop();
        sceneHasNoScript = false;
        selectedFunscript = defaultScript || funscripts[0];
        // this script's remembered tuning, before the script itself loads
        applyScriptSettingsFor(selectedFunscript);
        updateFunscriptSelector();
        // A spectator knows its script (the label shows it) but only loads it
        // once it drives; becomeOwner() does that.
        if (isOwner) loadFunscript(selectedFunscript);
      }
      return;
    }
  }


  // ── Funscript ──────────────────────────────────────────────────────────────
  // 1.45: opening a scene asked for its funscripts three times (the socket's
  // open, becomeOwner, the first "connected" status), so the backend read and
  // loaded the script three times (about 120 ms of Flow rendering per hour of
  // tracker script each, and the script position reset). One question per
  // path while its answer is on the way, one load per path while it loads;
  // a later re-ask (a real reconnect, a new driver) still goes out.
  const ASK_WAIT_MS = 8000;
  let findAsked = null;      // { path, at } of the lookup on the way
  let loadAsked = null;      // { path, at } of the load on the way
  function askInFlight(asked, path, now) {
    return !!(asked && path && asked.path === path && now - asked.at < ASK_WAIT_MS);
  }
  function askFunscripts(path) {
    if (!path || !ws || !wsReady) return;
    const now = Date.now();
    if (askInFlight(findAsked, path, now)) { log(`Funscript lookup for ${path} already on the way`, "debug"); return; }
    findAsked = { path, at: now };
    sendMsg({ type: "findFunscripts", videoPath: path });
  }
  function loadFunscript(path) {
    if (funscriptLoaded === "pending" && askInFlight(loadAsked, path, Date.now())) {
      log(`Funscript ${path} is already loading`, "debug");
      return;
    }
    loadAsked = { path, at: Date.now() };
    log(`Loading funscript: ${path} (invert=${invert})`);
    funscriptLoaded   = "pending";
    selectedFunscript = path;
    sendMsg({ type: "loadFile", path, invert });
    updateFunscriptSelector();
  }

  // ── Manual on scenes without a script ─────────────────────────────────────
  // Only while the video plays, only in the driving tab, never over a manual
  // session the user started, and not again this scene if they turned it off.
  // It ends on pause, end or leaving the scene. Turning manual off is always
  // safe; the deadman still covers a tab that dies mid-scene.
  function autoManualCheck() {
    if (pluginOff || !autoManual || !isOwner || !sceneHasNoScript || autoManualVeto) return;
    if (manualOn || !videoIsPlaying()) return;
    autoManualInternal = true;
    try { setManual(true); } finally { autoManualInternal = false; }
    autoManualActive = true;
    showInfoFor("No funscript for this scene: playing your manual pattern", 5000);
    log("No script: manual pattern on while the video plays");
  }

  // 1.48: while Goon runs the automatic pattern under it is held. Goon is a
  // session the user chose (on a scene without a script it starts over the
  // automatic pattern, so autoManualActive was still set), and up to 1.47 the
  // next scene ended it: this turned Manual off (goonStop, the pad gone), and
  // the next play turned the automatic pattern back on, so the user was in
  // Manual. Goon ends only on its own ways (End Goon, Stop, Manual off, the
  // mode switch, another tab driving, disconnect / deadman), never on a
  // pause, a scene change, a scene with a script or leaving the scene pages.
  // evenGoon: turning the plugin off, which stops everything anyway.
  function autoManualStop(evenGoon) {
    if (autoManualTimer) { clearTimeout(autoManualTimer); autoManualTimer = null; }
    autoManualDeadline = 0;
    if (!autoManualActive) return;
    if (goonOn && !evenGoon) return;
    autoManualActive = false;
    autoManualInternal = true;
    try { setManual(false); } finally { autoManualInternal = false; }
  }

  // A click on the timeline is a pause and a play 100 ms apart, a drag holds
  // the video paused, and a queued scene ends just before the next one starts.
  // Up to 1.31 each of those stopped the pattern and the play started it
  // again, from the top, opening buzz included: a buzz on every seek and every
  // next video. So a stop only counts once it has lasted
  // AUTO_MANUAL_GRACE_MS, a drag or a scene whose script is still being looked
  // up holds it (up to AUTO_MANUAL_HOLD_MAX_MS), and a pattern that is still
  // wanted afterwards just keeps running.
  const AUTO_MANUAL_GRACE_MS    = 700;
  const AUTO_MANUAL_HOLD_MAX_MS = 8000;
  let autoManualTimer    = null;
  let autoManualDeadline = 0;
  let sceneScriptPending = false;

  function liveVideo() {
    if (videoEl && videoEl.isConnected) return videoEl;
    return document.querySelector("video");
  }

  function videoScrubbing(v) {
    const player = v && v.closest ? v.closest(".video-js") : null;
    return !!(player && player.classList.contains("vjs-scrubbing"));
  }

  function autoManualSettle() {
    if (!autoManualActive || goonOn) return;      // 1.48: held under Goon (autoManualStop)
    if (autoManualTimer) clearTimeout(autoManualTimer);
    if (!autoManualDeadline) autoManualDeadline = Date.now() + AUTO_MANUAL_HOLD_MAX_MS;
    autoManualTimer = setTimeout(() => {
      autoManualTimer = null;
      if (!autoManualActive || goonOn) { autoManualDeadline = 0; return; }
      const v       = liveVideo();
      const playing = !!(v && !v.paused && !v.ended);
      if (playing && sceneHasNoScript && isOwner && autoManual && !autoManualVeto) {
        autoManualDeadline = 0;                // still wanted: never interrupted
        return;
      }
      if ((videoScrubbing(v) || sceneScriptPending) && Date.now() < autoManualDeadline) {
        autoManualSettle();
        return;
      }
      autoManualStop();
    }, AUTO_MANUAL_GRACE_MS);
  }

  // ── Stop-Helper ────────────────────────────────────────────────────────────
  function stopPlayback(reason) {
    pendingPlay = null;
    sendMsg({ type: "pause" });
  }

  // ── Video events ───────────────────────────────────────────────────────────
  // Stash keeps one <video> across scenes. Changing scene clears videoEl, so
  // the same element came back here and got a second set of listeners, then a
  // third: every pause went out N times, each one a stop command over BLE.
  const hookedVideos = new WeakSet();

  function attachVideoEvents(video) {
    if (videoEl === video) return;
    videoEl = video;
    setTimeout(refreshPauseHold, 0);      // 1.49: a player arrived; held if it is paused
    if (hookedVideos.has(video)) return;
    hookedVideos.add(video);

    video.addEventListener("play", () => {
      haltHeld = false;                   // the user pressed play: Stop is over
      bufferingSince = 0;
      refreshPauseHold();                 // 1.49: playing again, the real strength goes out
      deckTouched();                      // the fold's 4 s start (when it is on)
      setTimeout(autoManualCheck, 0);
      const t = video.currentTime * 1000;
      log(`Video play @ ${t.toFixed(0)}ms`, "debug");
      sendPresence();
      if (!isOwner) { tryTakeover("play"); return; }   // becomeOwner() queues the play
      if (!funscriptLoaded) pendingPlay = { time: t, rate: video.playbackRate };
      else                  sendMsg({ type: "play", time: t, rate: video.playbackRate });
    });

    // Buffering stalls the video but the backend keeps counting. Treat a stall
    // as a pause and resume from the real position when playback resumes.
    video.addEventListener("waiting", () => {
      log("Video stalled (buffering)", "debug");
      sendMsg({ type: "pause" });
      // 1.49: a long stall is a pause for the toy too (a short one is not:
      // a seek or a hiccup would chop every pattern)
      if (!bufferingSince) bufferingSince = Date.now();
      clearTimeout(bufferTimer);
      bufferTimer = setTimeout(refreshPauseHold, PAUSE_BUFFER_MS + 50);
    });
    video.addEventListener("playing", () => {
      bufferingSince = 0;
      clearTimeout(bufferTimer);
      refreshPauseHold();
      if (!videoEl || haltHeld) return;   // back from buffering after Stop: stays stopped
      sendMsg({ type: "play", time: videoEl.currentTime * 1000, rate: videoEl.playbackRate });
    });
    video.addEventListener("ratechange", () => {
      log(`Playback rate ${video.playbackRate}`, "debug");
      sendMsg({ type: "sync", time: video.currentTime * 1000, rate: video.playbackRate });
    });

    video.addEventListener("pause", () => {
      log("Video pause", "debug");
      refreshPauseHold();                 // 1.49: silent until play (the setting)
      autoManualSettle();                 // a seek looks like a pause; see autoManualSettle
      pendingPlay = null;
      sendPresence();                     // let other tabs see we are idle right away
      sendMsg({ type: "pause" });
    });

    // A seek while playing: silence the script until the new position is
    // known, instead of running on from the old one for as long as the seek
    // takes (seconds on a transcoded stream). The backend's pause leaves a
    // manual pattern running. Not while paused: a timeline drag seeks on every
    // mouse move, and each pause would be another stop command over BLE.
    video.addEventListener("seeking", () => {
      if (video.paused) return;
      sendMsg({ type: "pause" });
    });

    video.addEventListener("seeked", () => {
      const t = video.currentTime * 1000;
      log(`Video seek @ ${t.toFixed(0)}ms`, "debug");
      sendMsg({ type: "seek", time: t });
      if (!video.paused && !haltHeld) {
        if (!funscriptLoaded) pendingPlay = { time: t, rate: video.playbackRate };
        else                  sendMsg({ type: "play", time: t, rate: video.playbackRate });
      }
    });

    video.addEventListener("ended", () => {
      log("Video ended", "debug");
      refreshPauseHold();
      autoManualSettle();                 // a queue may start the next scene right away
      pendingPlay = null;
      sendMsg({ type: "pause" });
    });

    video.addEventListener("emptied", () => {
      log("Video emptied", "debug");
      refreshPauseHold();
      pendingPlay = null;
      sendMsg({ type: "pause" });
    });
  }


  // ── Page-Lifecycle ─────────────────────────────────────────────────────────
  // Tab close is handled once, in the pagehide handler next to sendMsg.
  // No stop on visibilitychange: switching tabs must not kill playback.

  // ── Identify a change in the SPA route ─────────────────────────────────────────────
  let lastPath = location.pathname;
  function routeTick() {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (!/^\/scenes\/\d+/.test(lastPath)) {
        // Left the scene pages. The backend's pause keeps manual running, so an
        // automatic pattern has to be ended here or it outlives the scene
        // (1.48: not under Goon, which goes on across pages; see autoManualStop).
        autoManualStop();
        stopPlayback("route-change");
        videoEl = null;
        refreshPauseHold();               // 1.49: no player on this page: nothing is held (as before 1.49)
        funscriptLoaded = false;
      }
    }
  }
  setInterval(routeTick, 500);


  // ═══ Theme tokens (suiteTheme) ═════════════════════════════════════════════
  // The suite's colours, taken from whatever theme Stash shows (docs/THEME.md
  // "Theme tokens", MAINTENANCE §4.25). With the Flexoki theme plugin on, the
  // tokens are Flexoki's exact values, so nothing changes for its users.
  // Without it they are worked out from the page: its background, a card,
  // the text, muted text and the primary button, so panels sit in Stash's
  // own dark look, a light theme or custom CSS. Colours that mean something
  // (green done, red delete, yellow warning, blue O's and links, the codec
  // and resolution tints) keep their Flexoki hue and are made lighter or
  // darker until they read there: 3:1 for shapes, 4.5:1 for text.
  // Copied identically into every plugin (scripts/check_shared.py); its
  // state is all in the closure.
  //   T = suiteTheme({ id, scope, extra })  scope: the plugin's root selectors
  //   T.start()   writes `scope { --sx-*: ... }` once and again when the theme changes
  //   T.t         the tokens now, as "#RRGGBB" (k and the shadows are not colours)
  //   T.mode      "flexoki", "dark" or "light"
  //   T.on(fn)    fn(T) after a change, for a canvas or a colour set from JS
  //   extra(T)    more CSS the plugin works out from the tokens, rewritten with them
  //   T.parse / hex / lum / contrast / mix / fit / derive / tokensCss: the pure parts
  function suiteTheme(o) {
    o = o || {};
    // Flexoki dark as the plugins have always used it (docs/THEME.md); the
    // plugins' muted text is #878580, not the theme plugin's #9F9D96 (grey)
    const FLEX = {
      bg: "#100F0F", bg2: "#1C1B1A", ui: "#282726", ui2: "#343331", ui3: "#403E3C", raise: "#2D2C2A", edge: "#48463F",
      line: "#0D0C0C", line2: "#0B0A0A", deep: "#000000", slab: "#232120",
      tx3: "#575653", tx2b: "#6F6E69", tx2: "#878580", tx1b: "#B7B5AC", tx: "#CECDC3", hi: "#E6E4D9", grey: "#9F9D96",
      paper: "#FFFCF0", on: "#100F0F", acc: "#DA702C", "acc-tx": "#100F0F",
    };
    // each hue: [base 400, pressed 600, text 300, tint 200, deep 700]
    const HUES = {
      re: ["#D14D41", "#AF3029", "#E8705F", "#F89A8A", "#942822"], or: ["#DA702C", "#BC5215", "#EC8B49", "#F9AE77", "#9D4310"],
      ye: ["#D0A215", "#AD8301", "#DFB431", "#ECCB60", "#8E6B01"], gr: ["#879A39", "#66800B", "#A9BA5A", "#BEC97E", "#536907"],
      cy: ["#3AA99F", "#24837B", "#5ABDAC", "#87D3C3", "#1C6C66"], bl: ["#4385BE", "#205EA6", "#66A0C8", "#92BFDB", "#1A4F8C"],
      pu: ["#8B7EC8", "#5E409D", "#A699D0", "#C4B9E0", "#4F3685"], ma: ["#CE5D97", "#A02F6F", "#E47DA8", "#F4A4C2", "#87285E"],
    };
    Object.keys(HUES).forEach((h) => { const v = HUES[h]; FLEX[h] = v[0]; FLEX[h + "-d"] = v[1]; FLEX[h + "-tx"] = v[2]; FLEX[h + "-l"] = v[3]; });
    // Stash's own dark look, for when nothing can be read
    const STASH = { bg: "#202B33", surface: "#30404D", text: "#F5F8FA", muted: "#BFCCD6", primary: "#137CBD" };
    const SHADOW = (k) => {
      const a = (x) => "rgba(0,0,0," + +(x * k).toFixed(3) + ")";
      return { sh: "0 1px 0 " + a(0.7) + ", 0 12px 24px -10px " + a(0.65), float: "0 1px 0 " + a(0.7) + ", 0 20px 50px -12px " + a(0.75),
               well: "inset 0 2px 5px " + a(0.5) };
    };

    // "#abc", "#aabbcc(dd)", rgb()/rgba() in either syntax, color(srgb ...),
    // "transparent": [r, g, b, a] with r g b 0..255, or null
    function parse(s) {
      if (Array.isArray(s)) return s;
      s = String(s || "").trim().toLowerCase();
      if (s === "transparent") return [0, 0, 0, 0];
      let m = /^#([0-9a-f]{3,8})$/.exec(s);
      if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
        if (h.length !== 6 && h.length !== 8) return null;
        const n = (i) => parseInt(h.slice(i, i + 2), 16);
        return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
      }
      m = /^rgba?\(([^)]*)\)$/.exec(s);
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean);
        if (p.length < 3) return null;
        const ch = (v) => (/%$/.test(v) ? parseFloat(v) * 2.55 : parseFloat(v));
        const al = p[3] === undefined ? 1 : /%$/.test(p[3]) ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
        const out = [ch(p[0]), ch(p[1]), ch(p[2]), al];
        return out.some((x) => isNaN(x)) ? null : out;
      }
      m = /^color\(srgb\s+([^)]*)\)$/.exec(s);
      if (m) {
        const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
        return p.length >= 3 && !p.some(isNaN) ? [p[0] * 255, p[1] * 255, p[2] * 255, p[3] === undefined ? 1 : p[3]] : null;
      }
      return null;
    }
    const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
    const hex = (c) => { c = parse(c); return c ? "#" + c.slice(0, 3).map((x) => clamp(x).toString(16).padStart(2, "0")).join("").toUpperCase() : null; };
    // c with alpha laid over an opaque base
    const over = (c, base) => { c = parse(c); base = parse(base); const a = c[3]; return [0, 1, 2].map((i) => c[i] * a + base[i] * (1 - a)).concat(1); };
    // a weight w of b mixed into a (w 0 is a), as color-mix in srgb
    const mix = (a, b, w) => { a = parse(a); b = parse(b); return hex([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * w)); };
    function lum(c) {
      c = parse(c);
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    }
    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    // c moved toward white (on a dark page) or black (on a light one) in 4%
    // steps until it reaches `ratio` against every colour in `against`
    function fit(c, against, ratio, dark) {
      const to = dark ? "#FFFFFF" : "#000000", worst = (x) => Math.min.apply(null, against.map((b) => contrast(x, b)));
      let out = hex(c);
      for (let i = 1; i <= 25 && worst(out) < ratio; i++) out = mix(c, to, i * 0.04);
      return out;
    }

    // tokens from samples of the page ({ bg, surface, text, muted, border,
    // primary }, any CSS colour; missing ones fall back to Stash's dark look)
    function derive(s) {
      s = s || {};
      const pick = (v, d) => { const c = parse(v); return c && c[3] > 0 ? c : parse(d); };
      const bg = hex(over(pick(s.bg, STASH.bg), "#000000"));
      let tx = hex(over(pick(s.text, STASH.text), bg));
      const dark = lum(bg) < lum(tx) || (lum(bg) < 0.18 && contrast(bg, tx) < 3);
      if (contrast(tx, bg) < 4.5) tx = dark ? "#F5F8FA" : "#1C2127";
      let ui = hex(over(pick(s.surface, parse(s.bg) ? bg : STASH.surface), bg));
      // a card no different from the page (or wildly different) still needs a raised step
      if (contrast(ui, bg) < 1.04 || contrast(ui, bg) > 3 || (dark ? lum(ui) < lum(bg) : false)) ui = mix(bg, tx, dark ? 0.07 : 0.035);
      if (!dark && contrast(ui, bg) < 1.04) ui = bg;
      const t = { bg, ui, tx };
      t.bg2 = dark ? mix(bg, ui, 0.5) : mix(ui, tx, 0.04);
      t.ui2 = mix(ui, tx, dark ? 0.075 : 0.06);
      t.ui3 = mix(ui, tx, dark ? 0.145 : 0.13);
      const bd = parse(s.border);
      if (bd && bd[3] > 0) { const b = hex(over(bd, ui)), r = contrast(b, ui); if (r > 1.1 && r < 3) t.ui3 = b; }
      t.raise = dark ? mix(ui, tx, 0.03) : mix(ui, "#FFFFFF", 0.5);
      t.edge = dark ? mix(ui, tx, 0.19) : mix(ui, "#FFFFFF", 0.7);
      t.line = dark ? mix(bg, "#000000", 0.19) : mix(ui, tx, 0.2);
      t.line2 = dark ? mix(bg, "#000000", 0.31) : mix(ui, tx, 0.22);
      t.deep = dark ? "#000000" : mix(ui, tx, 0.25);
      t.slab = dark ? mix(bg, tx, 0.07) : mix(bg, tx, 0.1);
      t.hi = mix(tx, dark ? "#FFFFFF" : "#000000", 0.45);
      t.tx1b = mix(tx, ui, 0.14);
      const mu = parse(s.muted);
      let tx2 = mix(tx, ui, 0.43);
      if (mu && mu[3] > 0) { const m = hex(over(mu, ui)); if (contrast(m, ui) < contrast(tx, ui) * 0.92) tx2 = m; }
      t.tx2 = fit(tx2, [ui, bg], 4.5, dark);
      t.tx2b = mix(tx, ui, 0.57);
      t.tx3 = mix(tx, ui, 0.66);
      t.grey = fit(mix(tx, ui, 0.3), [ui, bg], 4.5, dark);
      t.paper = FLEX.paper;
      // text on a filled meaning colour: dark ink on Flexoki's 400s, white on the darker light-theme ones
      t.on = dark ? mix(bg, "#000000", 0.4) : "#FFFFFF";
      Object.keys(HUES).forEach((h) => {
        const v = HUES[h];
        t[h] = fit(dark ? v[0] : v[1], [ui, bg], 3, dark);
        t[h + "-d"] = dark ? v[1] : mix(t[h], "#000000", 0.2);
        t[h + "-tx"] = fit(dark ? v[2] : v[1], [ui, bg], 4.5, dark);
        t[h + "-l"] = fit(dark ? v[3] : v[4], [ui, bg], 4.5, dark);
      });
      const pr = parse(s.primary);
      t.acc = pr && pr[3] > 0 ? fit(hex(over(pr, ui)), [ui], 3, dark) : t.or;
      t["acc-tx"] = contrast(t.acc, "#FFFFFF") >= contrast(t.acc, t.on) ? "#FFFFFF" : t.on;
      return t;
    }

    // the CSS for a token set: scope { --sx-name: value; ... }
    function tokensCss(t, mode, scope) {
      const k = mode === "light" ? 0.3 : 1, sh = SHADOW(k);
      const lines = Object.keys(t).map((n) => "--sx-" + n + ": " + t[n] + ";");
      lines.push("--sx-k: " + k + ";", "--sx-sh: " + sh.sh + ";", "--sx-float: " + sh.float + ";", "--sx-well: " + sh.well + ";",
                 "--sx-scheme: " + (mode === "light" ? "light" : "dark") + ";");
      return (scope || ":root") + " {\n  " + lines.join("\n  ") + "\n}";
    }

    const T = { t: Object.assign({}, FLEX), mode: "flexoki", FLEX, HUES, STASH, parse, hex, over, mix, lum, contrast, fit, derive, tokensCss };
    const subs = [];
    let el = null, timer = 0, started = false, css = "";
    T.on = (fn) => { subs.push(fn); return T; };

    // Flexoki's stylesheet defines --fx-bg on <html>; its accent setting is --fx-acc
    function flexokiOn() {
      try { return !!getComputedStyle(document.documentElement).getPropertyValue("--fx-bg").trim(); } catch (_) { return false; }
    }
    // what the page looks like: probes with Stash's (Bootstrap's) classes, so
    // a theme that styles them is read even where no card is on screen
    function sample() {
      const out = {};
      const cs = (e) => getComputedStyle(e);
      const b = document.body, h = document.documentElement;
      const hb = parse(cs(h).backgroundColor), bb = b ? parse(cs(b).backgroundColor) : null;
      let page = hb && hb[3] > 0 ? over(hb, STASH.bg) : null;
      if (bb && bb[3] > 0) page = over(bb, page || STASH.bg);
      if (page) out.bg = page;
      if (b) out.text = cs(b).color;
      if (!b) return out;
      const box = document.createElement("div");
      box.setAttribute("aria-hidden", "true");
      box.style.cssText = "position:absolute;left:-9999px;top:0;width:10px;height:10px;visibility:hidden;pointer-events:none";
      box.innerHTML = '<div class="card"><span class="text-muted">x</span><button type="button" class="btn btn-primary">x</button></div>';
      b.appendChild(box);
      try {
        const card = box.firstChild, c = cs(card);
        out.surface = c.backgroundColor;
        if (parseFloat(c.borderTopWidth) > 0) out.border = c.borderTopColor;
        out.muted = cs(card.firstChild).color;
        out.primary = cs(card.lastChild).backgroundColor;
        if (c.color) out.text = c.color;
      } finally { box.remove(); }
      return out;
    }
    function compute() {
      if (flexokiOn()) {
        const t = Object.assign({}, FLEX);
        // the accent follows the theme plugin's setting (plugins keep their own colours)
        try {
          const a = parse(getComputedStyle(document.documentElement).getPropertyValue("--fx-acc").trim());
          if (a) t.acc = hex(a);
        } catch (_) {}
        return { t, mode: "flexoki" };
      }
      const t = derive(sample());
      return { t, mode: lum(t.bg) < lum(t.tx) ? "dark" : "light" };
    }
    function apply() {
      timer = 0;
      let r;
      try { r = compute(); } catch (e) { return; }
      const next = tokensCss(r.t, r.mode, o.scope) + (o.extra ? "\n" + o.extra({ t: r.t, mode: r.mode, mix, fit, contrast }) : "");
      T.t = r.t; T.mode = r.mode;
      if (next === css && el && el.isConnected) return;
      css = next;
      if (!el || !el.isConnected) {
        el = document.getElementById((o.id || "suite") + "-sx") || document.createElement("style");
        el.id = (o.id || "suite") + "-sx";
        document.head.appendChild(el);
      }
      el.textContent = css;
      subs.forEach((fn) => { try { fn(T); } catch (_) {} });
    }
    const soon = () => { if (!timer) timer = setTimeout(apply, 120); };
    T.refresh = apply;
    T.start = () => {
      if (started) return T;
      started = true;
      apply();
      try {
        // a theme arrives as a stylesheet (Stash adds plugin CSS as <link>s,
        // so also wait for each one to load), a class or style on <html> or
        // <body>, or the system's light/dark switch
        const watchLink = (n) => { if (n && n.tagName === "LINK") n.addEventListener("load", soon, { once: true }); };
        const mo = new MutationObserver((list) => {
          for (const m of list) {
            if (m.target === el || (el && el.contains(m.target))) continue;
            if (m.addedNodes) m.addedNodes.forEach(watchLink);
            soon();
          }
        });
        mo.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "media", "href", "rel"] });
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-bs-theme", "data-fx-accent"] });
        if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-bs-theme"] });
        document.querySelectorAll('link[rel~="stylesheet"]').forEach((n) => { if (!n.sheet) watchLink(n); });
        const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
        if (mq && mq.addEventListener) mq.addEventListener("change", soon);
      } catch (_) {}
      return T;
    };
    return T;
  }
  // IntifaceSync draws into the bar under the player, the deck under it
  // and the two sheets (.pop: the deck, the editor, the settings with the
  // script's tuning and the Handy panel in it), their veil, the toast, the
  // "off" pill, the Goon pad, the fullscreen pill and the
  // scenes-without-a-funscript dialog. Everything mounted outside these
  // would lose its colours.
  const THEME_SCOPE = `#${PLUGIN_ID}-toolbar, .${PLUGIN_ID}-pop, #${PLUGIN_ID}-toast, #${PLUGIN_ID}-pill, #${PLUGIN_ID}-veil, #${PLUGIN_ID}-nofs, #${PLUGIN_ID}-goonpad, #${PLUGIN_ID}-fspill`;
  // The bar is a dark strip in the player chrome, the deck continues it, the
  // script's tuning keeps its dark scope, and the pills and the pad sit on
  // the player: they stay dark
  // whatever the theme. On a light theme they keep Flexoki's dark tokens.
  const THEME_DARK = `#${PLUGIN_ID}-toolbar, #${PLUGIN_ID}-deck, #${PLUGIN_ID}-dock, #${PLUGIN_ID}-pill, #${PLUGIN_ID}-goonpad, #${PLUGIN_ID}-fspill`;
  // Translucent tints are rgba(var(--is-NAME-rgb), a): the token as "r,g,b",
  // so Chrome computes exactly the rgba() it did before with Flexoki on.
  const THEME_RGB = ["bg", "bg2", "edge", "tx", "re", "ye", "gr", "ma"];
  const rgbVars = (t) => THEME_RGB.map((k) => `--is-${k}-rgb: ${THEME.parse(t[k]).slice(0, 3).join(",")};`).join(" ");
  const THEME = suiteTheme({ id: "intifacesync", scope: THEME_SCOPE, extra: (X) =>
    `${THEME_SCOPE} { ${rgbVars(X.t)} }` +
    (X.mode === "light" ? `
${THEME.tokensCss(THEME.FLEX, "dark", THEME_DARK)}
${THEME_DARK} { ${rgbVars(THEME.FLEX)} }` : "") });
  // Canvases cannot read var(): they take the tokens at draw time. The ones
  // in the player (heat strip, dock's scope and overview) use the dark set.
  const vidTokens = () => (THEME.mode === "light" ? THEME.FLEX : THEME.t);
  const cRgba = (hex, a) => `rgba(${THEME.parse(hex).slice(0, 3).join(",")},${a})`;
  // a theme change repaints the canvases that are not redrawn every frame;
  // later, not inside start(), which runs while injectStyles has not yet
  // added its stylesheet
  THEME.on(() => setTimeout(() => { drawPatternPreview(); drawOverview(); }, 0));

  // ── Styles ──────────────────────────────────────────────────────────────────
function injectStyles() {
  if (byId(`${PLUGIN_ID}-style`)) return;
  THEME.start();
  const st = document.createElement("style");
  st.id = `${PLUGIN_ID}-style`;
  st.textContent = `
    /* Flexoki dark (1.34). Magenta is the brand accent; green, red and yellow
       keep their meaning (live/connected, stop/muted/error, warning). The bar
       sits in Stash's player chrome, so it stays a translucent strip rather
       than a raised card; the popover and dock get the panel depth. */

    /* ── Toolbar Container ──────────────────────────────────── */
    #${PLUGIN_ID}-toolbar {
      background: linear-gradient(180deg, rgba(var(--is-bg2-rgb),0.92), rgba(var(--is-bg-rgb),0.95)) !important;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-top: 1px solid rgba(var(--is-edge-rgb),0.7) !important;
      box-shadow: 0 -4px 20px rgba(0,0,0,calc(0.4*var(--sx-k)));
      color: var(--sx-tx) !important;
      font-size: 12px !important;
      padding: 8px 14px !important;
      gap: 12px !important;
    }
    .${PLUGIN_ID}-ic {
      display: inline-block; width: 14px; height: 14px; flex: none;
      vertical-align: -2.5px;
    }
    .${PLUGIN_ID}-ic.is-lead { margin-right: 6px; }
    .${PLUGIN_ID}-ic.is-trail { margin-left: 5px; opacity: .75; }
    #${PLUGIN_ID}-sp-close .${PLUGIN_ID}-ic { display: block; }
    #${PLUGIN_ID}-toolbar span,
    #${PLUGIN_ID}-toolbar label {
      color: var(--sx-tx1b);
      font-weight: 500;
      letter-spacing: 0.2px;
    }

    /* ── Buttons ────────────────────────────────────────────── */
    #${PLUGIN_ID}-toolbar button {
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui));
      color: var(--sx-tx);
      border: 1px solid var(--sx-line2);
      border-top-color: var(--sx-ui3);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    #${PLUGIN_ID}-toolbar button:hover {
      background: linear-gradient(180deg, var(--sx-ui3), var(--sx-ui2));
      border-top-color: var(--sx-tx3);
      color: var(--sx-hi);
    }
    #${PLUGIN_ID}-toolbar button:active {
      transform: translateY(1px);
    }

    /* ── Number / Text Inputs ──────────────────────────────── */
    #${PLUGIN_ID}-toolbar input[type=number],
    #${PLUGIN_ID}-toolbar input[type=text] {
      background: var(--sx-bg2);
      color: var(--sx-hi);
      border: 1px solid var(--sx-deep);
      border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
      border-radius: 8px;
      padding: 5px 8px;
      font-size: 12px;
      font-family: inherit;
      text-align: center;
      transition: border-color 0.15s, box-shadow 0.15s;
      outline: none;
    }
    #${PLUGIN_ID}-toolbar input[type=number]:focus,
    #${PLUGIN_ID}-toolbar input[type=text]:focus {
      border-color: var(--sx-ma);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k))), 0 0 0 2px rgba(var(--is-ma-rgb),0.25);
    }
    #${PLUGIN_ID}-toolbar input[type=number]::-webkit-inner-spin-button,
    #${PLUGIN_ID}-toolbar input[type=number]::-webkit-outer-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    #${PLUGIN_ID}-toolbar input[type=number] { -moz-appearance: textfield; }

    /* ── Range Sliders ─────────────────────────────────────── */
    #${PLUGIN_ID}-toolbar input[type=range] {
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      pointer-events: none;
      height: 18px;
      padding: 0;
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-webkit-slider-runnable-track {
      height: 4px; background: transparent; border-radius: 2px;
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-moz-range-track {
      height: 4px; background: transparent; border-radius: 2px;
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px; height: 14px; border-radius: 50%;
      background: var(--sx-hi);
      border: 2px solid var(--sx-ma);
      box-shadow: 0 2px 6px rgba(0,0,0,calc(0.4*var(--sx-k)));
      cursor: pointer;
      pointer-events: all;
      margin-top: -5px;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-webkit-slider-thumb:hover {
      transform: scale(1.15);
      box-shadow: 0 2px 10px rgba(var(--is-ma-rgb),0.5);
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-moz-range-thumb {
      width: 14px; height: 14px; border-radius: 50%;
      background: var(--sx-hi);
      border: 2px solid var(--sx-ma);
      box-shadow: 0 2px 6px rgba(0,0,0,calc(0.4*var(--sx-k)));
      cursor: pointer;
      pointer-events: all;
    }

    /* ── Handy Panel ───────────────────────────────────────── */
    #${PLUGIN_ID}-handy-panel {
      display: flex; align-items: center; gap: 8px;
      flex-wrap: wrap; width: 100%;
      padding: 8px 0 4px 0;
      border-top: 1px solid rgba(255,255,255,0.06);
      margin-top: 4px;
    }
    #${PLUGIN_ID}-handy-key {
      background: var(--sx-bg2);
      color: var(--sx-hi);
      border: 1px solid var(--sx-deep);
      border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 12px;
      font-family: "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 1.5px;
      width: 160px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #${PLUGIN_ID}-handy-key:focus {
      border-color: var(--sx-ma);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k))), 0 0 0 2px rgba(var(--is-ma-rgb),0.25);
    }
    #${PLUGIN_ID}-tunnel-url {
      font-size: 11.5px;
      color: var(--sx-bl-tx);
      opacity: 0.85;
      font-family: "SF Mono", Menlo, Consolas, monospace;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Mode Buttons (Tab-Style) ──────────────────────────── */
    .${PLUGIN_ID}-mode-btn {
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui));
      color: var(--sx-tx2);
      border: 1px solid var(--sx-line2);
      border-top-color: var(--sx-ui3);
      border-radius: 8px;
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .${PLUGIN_ID}-mode-btn:hover {
      border-top-color: var(--sx-tx3);
      color: var(--sx-hi);
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-mode-btn.active {
      background: var(--sx-ui2) !important;
      background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2)) !important;
      color: var(--sx-hi) !important;
      border: 1px solid rgba(var(--is-ma-rgb),0.55) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 0 12px rgba(var(--is-ma-rgb),0.2) !important;
    }

    /* Stop (1.45; 1.46 also the deck, the sheets and the Goon pad): red means
       stop, but it is a quiet outline the size of the other controls, solid
       red only on hover and keyboard focus. The ::before makes the hit area
       34 px high for a mouse and 46 px on touch without making it bigger. */
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-stopbtn, #${PLUGIN_ID}-fspill .${PLUGIN_ID}-stopbtn,
    #${PLUGIN_ID}-deck .${PLUGIN_ID}-stopbtn, .${PLUGIN_ID}-modal .${PLUGIN_ID}-stopbtn, #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-stopbtn {
      position: relative; display: inline-flex; align-items: center; gap: 5px; flex: none;
      background: rgba(var(--is-re-rgb),0.10) !important;
      border: 1px solid rgba(var(--is-re-rgb),0.6) !important;
      color: var(--sx-re-tx) !important;
      box-shadow: none !important;
      padding: 4px 10px; font-size: 12px; font-weight: 600; line-height: 15px; border-radius: 8px; cursor: pointer;
      font-family: inherit;
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-stopbtn::before, #${PLUGIN_ID}-fspill .${PLUGIN_ID}-stopbtn::before,
    #${PLUGIN_ID}-deck .${PLUGIN_ID}-stopbtn::before, .${PLUGIN_ID}-modal .${PLUGIN_ID}-stopbtn::before, #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-stopbtn::before {
      content: ""; position: absolute; inset: -4px -3px;
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-stopbtn svg, #${PLUGIN_ID}-fspill .${PLUGIN_ID}-stopbtn svg,
    #${PLUGIN_ID}-deck .${PLUGIN_ID}-stopbtn svg, .${PLUGIN_ID}-modal .${PLUGIN_ID}-stopbtn svg, #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-stopbtn svg { width: 13px; height: 13px; flex: none; }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-stopbtn .${PLUGIN_ID}-stopword, #${PLUGIN_ID}-fspill .${PLUGIN_ID}-stopword,
    #${PLUGIN_ID}-deck .${PLUGIN_ID}-stopword, .${PLUGIN_ID}-modal .${PLUGIN_ID}-stopword, #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-stopword { color: inherit !important; font-weight: 600; }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-stopbtn:hover, #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-stopbtn:focus-visible,
    #${PLUGIN_ID}-fspill .${PLUGIN_ID}-stopbtn:hover, #${PLUGIN_ID}-fspill .${PLUGIN_ID}-stopbtn:focus-visible,
    #${PLUGIN_ID}-deck .${PLUGIN_ID}-stopbtn:hover, .${PLUGIN_ID}-modal .${PLUGIN_ID}-stopbtn:hover, #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-stopbtn:hover,
    #${PLUGIN_ID}-deck .${PLUGIN_ID}-stopbtn:focus-visible, .${PLUGIN_ID}-modal .${PLUGIN_ID}-stopbtn:focus-visible, #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-stopbtn:focus-visible {
      background: var(--sx-re) !important; border-color: var(--sx-re) !important; color: var(--sx-on) !important;
      outline: none;
    }
    @media (pointer: coarse) {
      #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-stopbtn::before, #${PLUGIN_ID}-fspill .${PLUGIN_ID}-stopbtn::before,
      #${PLUGIN_ID}-deck .${PLUGIN_ID}-stopbtn::before, .${PLUGIN_ID}-modal .${PLUGIN_ID}-stopbtn::before, #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-stopbtn::before { inset: -9px -4px; }
    }
    /* 1.45: no backend, nothing here can reach a toy: the controls look it.
       Stop and the pill's action (Start, Retry) stay as they are. 1.46: the
       deck's controls (the bar has only the pill, the gear and Stop). */
    #${PLUGIN_ID}-deck.is-offline .${PLUGIN_ID}-dk-seg,
    #${PLUGIN_ID}-deck.is-offline .${PLUGIN_ID}-dk-str,
    #${PLUGIN_ID}-deck.is-offline .${PLUGIN_ID}-dk-body,
    #${PLUGIN_ID}-deck.is-offline #${PLUGIN_ID}-fav-offer,
    #${PLUGIN_ID}-deck.is-offline #${PLUGIN_ID}-output-btn { opacity: 0.4; filter: grayscale(1); }

    /* Fullscreen pill (1.45): inside the fullscreen player, top right. Dimmed
       while video.js hides its controls, never hidden: Stop stays on screen. */
    #${PLUGIN_ID}-fspill {
      position: absolute; top: 12px; right: 12px; z-index: 10060;
      display: inline-flex; align-items: center; gap: 8px; max-width: calc(100% - 24px);
      padding: 4px 4px 4px 10px; border-radius: 10px; box-sizing: border-box;
      background: rgba(var(--is-bg-rgb),0.82); border: 1px solid var(--sx-line); border-top-color: var(--sx-edge);
      box-shadow: 0 8px 24px -8px rgba(0,0,0,calc(.7*var(--sx-k)));
      color: var(--sx-tx); font-size: 12px; line-height: 16px; font-family: inherit;
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      transition: opacity .25s ease;
    }
    .video-js.vjs-user-inactive.vjs-playing > #${PLUGIN_ID}-fspill:not(:hover):not(:focus-within) { opacity: 0.55; }
    #${PLUGIN_ID}-fspill .${PLUGIN_ID}-fs-txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; color: var(--sx-tx1b); }
    #${PLUGIN_ID}-fspill .${PLUGIN_ID}-fs-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--sx-tx3); }
    #${PLUGIN_ID}-fspill[data-tone="good"] .${PLUGIN_ID}-fs-dot { background: var(--sx-gr); }
    #${PLUGIN_ID}-fspill[data-tone="warn"] .${PLUGIN_ID}-fs-dot { background: var(--sx-ye); }
    #${PLUGIN_ID}-fspill[data-tone="danger"] .${PLUGIN_ID}-fs-dot { background: var(--sx-re); }
    #${PLUGIN_ID}-fspill[data-tone="info"] .${PLUGIN_ID}-fs-dot { background: var(--sx-bl); }

    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-connect-btn,
    #${PLUGIN_ID}-handy-panel #${PLUGIN_ID}-connect-handy-btn {
      background: linear-gradient(180deg, rgba(var(--is-gr-rgb),0.24), rgba(var(--is-gr-rgb),0.12)), var(--sx-ui) !important;
      border: 1px solid rgba(var(--is-gr-rgb),0.5) !important;
      color: var(--sx-gr-tx) !important;
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-connect-btn:hover,
    #${PLUGIN_ID}-handy-panel #${PLUGIN_ID}-connect-handy-btn:hover {
      background: linear-gradient(180deg, rgba(var(--is-gr-rgb),0.38), rgba(var(--is-gr-rgb),0.22)), var(--sx-ui) !important;
      border-color: rgba(var(--is-gr-rgb),0.8) !important;
      color: var(--sx-hi) !important;
    }

    #${PLUGIN_ID}-handy-panel #${PLUGIN_ID}-reupload-btn {
      background: linear-gradient(180deg, rgba(var(--is-ye-rgb),0.22), rgba(var(--is-ye-rgb),0.10)), var(--sx-ui) !important;
      border: 1px solid rgba(var(--is-ye-rgb),0.45) !important;
      color: var(--sx-ye) !important;
    }
    #${PLUGIN_ID}-handy-panel #${PLUGIN_ID}-reupload-btn:hover {
      background: linear-gradient(180deg, rgba(var(--is-ye-rgb),0.34), rgba(var(--is-ye-rgb),0.20)), var(--sx-ui) !important;
      border-color: rgba(var(--is-ye-rgb),0.75) !important;
      color: var(--sx-hi) !important;
    }

    #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider {
      -webkit-appearance: none; appearance: none;
      height: 4px; padding: 0; margin: 0; border: 0;
      border-radius: 2px; background: var(--sx-ui3); cursor: pointer;
      box-shadow: inset 0 1px 1px rgba(0,0,0,calc(0.6*var(--sx-k)));
    }
    #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 13px; height: 13px; border-radius: 50%;
      background: var(--sx-ma); border: 2px solid var(--sx-hi); cursor: pointer;
    }
    #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider::-moz-range-thumb {
      width: 13px; height: 13px; border-radius: 50%;
      background: var(--sx-ma); border: 2px solid var(--sx-hi); cursor: pointer;
    }
    #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider::-moz-range-track {
      height: 4px; border-radius: 2px; background: var(--sx-ui3);
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-invert.active {
      background: var(--sx-ui2) !important;
      background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2)) !important;
      color: var(--sx-hi) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 0 12px rgba(var(--is-ma-rgb),0.2) !important;
    }


    /* ── Mobile ────────────────────────────────────────────── */
    @media (max-width: 768px) {
      #${PLUGIN_ID}-toolbar {
        font-size: 13px !important;
        padding: 6px 10px !important;
        gap: 8px !important;
      }
      /* Stash caps the phone player at the screen height (max-height:
         calc(100vh - 4rem), a flex column). With the toolbar unfolded and the
         dock open they were squeezed into that box: the video shrank to a
         strip and the dock became a screen-filling scroll area, so a swipe
         scrolled the dock and never the page. On phones the player grows
         with its contents, the video keeps its size, the dock scrolls with
         the page. */
      .VideoPlayer:has(#${PLUGIN_ID}-toolbar) { max-height: none !important; }
      .VideoPlayer:has(#${PLUGIN_ID}-toolbar) > .video-wrapper { flex-shrink: 0 !important; }
      #${PLUGIN_ID}-dock.${PLUGIN_ID}-pop { max-height: none !important; overflow: visible !important; }
      /* the generic mobile button padding left the icon buttons a few px for their icon */
      #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-icon-btn { padding: 6px 9px !important; min-width: 36px; display: inline-flex; align-items: center; justify-content: center; }
      #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-icon-btn svg { width: 17px !important; height: 17px !important; flex: none; }
      #${PLUGIN_ID}-toolbar input[type=range] { height: 26px !important; }
      #${PLUGIN_ID}-toolbar input[type=range]::-webkit-slider-thumb {
        width: 20px !important; height: 20px !important; margin-top: -12px !important;
      }
      #${PLUGIN_ID}-toolbar input[type=range]::-moz-range-thumb {
        width: 20px !important; height: 20px !important;
      }
      #${PLUGIN_ID}-toolbar input[type=number] {
        width: 80px !important; font-size: 13px !important; padding: 7px 8px !important;
      }
      #${PLUGIN_ID}-toolbar button,
      .${PLUGIN_ID}-mode-btn {
        padding: 7px 14px !important; font-size: 12px !important;
      }
        #${PLUGIN_ID}-toolbar select {
        font-size: 14px !important;
        padding: 6px 10px !important;
        height: 32px !important;
      }
    }

    /* ── Grouping ───────────────────────────────────────────── */
    .${PLUGIN_ID}-group {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 3px 4px 3px 10px;
      border-left: 1px solid rgba(255,255,255,0.08);
    }
    .${PLUGIN_ID}-num {
      min-width: 40px; text-align: right;
      font-variant-numeric: tabular-nums; opacity: 0.85;
    }
    /* muted: what would drive the toy fades; the status, Unmute and the
       device switch stay at full strength */
    #${PLUGIN_ID}-toolbar.is-muted .${PLUGIN_ID}-seg,
    #${PLUGIN_ID}-toolbar.is-muted .${PLUGIN_ID}-level,
    #${PLUGIN_ID}-toolbar.is-muted #${PLUGIN_ID}-tune { opacity: 0.55; }

    /* ── Stateful buttons ───────────────────────────────────── */
    #${PLUGIN_ID}-toolbar button.${PLUGIN_ID}-primary { font-weight: 600; }
    #${PLUGIN_ID}-toolbar button.is-live {
      background: linear-gradient(180deg, rgba(var(--is-gr-rgb),0.26), rgba(var(--is-gr-rgb),0.14)), var(--sx-ui);
      border-color: rgba(var(--is-gr-rgb),0.55);
      color: var(--sx-gr-tx);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
    }
    /* muted is a state, not the stop control */
    #${PLUGIN_ID}-toolbar button.is-muted {
      background: linear-gradient(180deg, rgba(var(--is-re-rgb),0.22), rgba(var(--is-re-rgb),0.12)), var(--sx-ui);
      border-color: rgba(var(--is-re-rgb),0.5);
      color: var(--sx-re-tx);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
    }
    #${PLUGIN_ID}-toolbar button.is-on {
      background: var(--sx-ui2);
      background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2));
      border-color: rgba(var(--is-ma-rgb),0.5);
      color: var(--sx-hi);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
    }
    #${PLUGIN_ID}-toolbar button.is-locked {
      opacity: 0.45; cursor: not-allowed;
    }

    /* ── Pattern popover ────────────────────────────────────── */
    .${PLUGIN_ID}-pop {
      position: fixed; left: 0; top: 0; z-index: 10050;
      width: 360px; max-height: 70vh; overflow-y: auto;
      background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
      border: 1px solid var(--sx-line);
      border-top-color: var(--sx-edge);
      border-radius: 12px;
      box-shadow: 0 1px 0 rgba(0,0,0,calc(0.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(0.75*var(--sx-k)));
      scrollbar-width: thin; scrollbar-color: var(--sx-ui3) transparent;
      padding: 14px 16px 12px;
      color: var(--sx-tx);
      font-family: inherit;
      font-size: 12px;
      opacity: 0; pointer-events: none; transform: translateY(4px);
      transition: opacity .12s ease, transform .12s ease;
    }
    .${PLUGIN_ID}-pop.is-open {
      opacity: 1; pointer-events: auto; transform: translateY(0);
    }
    .${PLUGIN_ID}-pop-head { margin-bottom: 10px; }
    .${PLUGIN_ID}-pop-head strong { font-size: 13px; display: block; color: var(--sx-hi); }
    .${PLUGIN_ID}-pop-sub {
      display: block; margin-top: 2px; font-size: 12px;
      color: var(--sx-tx2); line-height: 1.4;
    }
    .${PLUGIN_ID}-cards {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-card {
      display: flex; flex-direction: column; gap: 2px;
      text-align: left; padding: 8px 10px;
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-raise));
      border: 1px solid var(--sx-line2);
      border-top-color: var(--sx-ui3);
      box-shadow: 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
      border-radius: 8px; cursor: pointer; color: inherit;
      font-family: inherit; transition: all .12s ease;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-card:hover {
      background: linear-gradient(180deg, var(--sx-ui3), var(--sx-ui2));
      border-top-color: var(--sx-tx3);
      color: var(--sx-hi);
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-card.is-sel {
      background: var(--sx-ui2);
      background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2));
      border-color: rgba(var(--is-ma-rgb),0.5);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
      color: var(--sx-hi);
    }
    .${PLUGIN_ID}-card-name { font-size: 12px; font-weight: 600; }
    .${PLUGIN_ID}-card-blurb {
      font-size: 12px; color: var(--sx-tx2); line-height: 1.35;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-card.is-sel .${PLUGIN_ID}-card-blurb { color: var(--sx-tx1b); }

    .${PLUGIN_ID}-section {
      margin-top: 14px; padding-top: 10px;
      border-top: 1px solid var(--sx-ui2);
    }
    .${PLUGIN_ID}-sec-title {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--sx-tx2b); margin-bottom: 8px;
    }
    .${PLUGIN_ID}-field { margin-bottom: 10px; }
    .${PLUGIN_ID}-field:last-child { margin-bottom: 0; }
    .${PLUGIN_ID}-field-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
    }
    .${PLUGIN_ID}-field-head label { font-size: 12px; color: var(--sx-tx); }
    .${PLUGIN_ID}-field-ctl { display: inline-flex; align-items: center; gap: 5px; }
    .${PLUGIN_ID}-pop input[type=number] {
      width: 66px; background: var(--sx-bg2); color: var(--sx-hi);
      border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); border-radius: 8px;
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
      padding: 4px 6px; font-size: 12px; font-family: inherit;
      text-align: right; outline: none;
    }
    .${PLUGIN_ID}-pop input[type=number]:focus {
      border-color: rgba(var(--is-ma-rgb),0.6);
    }
    .${PLUGIN_ID}-unit { font-size: 12px; color: var(--sx-tx2b); min-width: 34px; }
    .${PLUGIN_ID}-field-help.${PLUGIN_ID}-field-warn { color: var(--sx-ye-tx); }
    .${PLUGIN_ID}-field-help {
      margin-top: 3px; font-size: 12px; color: var(--sx-tx2); line-height: 1.4;
    }
    .${PLUGIN_ID}-pop-foot {
      margin-top: 14px; padding-top: 10px;
      border-top: 1px solid var(--sx-ui2);
      font-size: 12px; color: var(--sx-tx2); line-height: 1.45;
    }

    /* ── Pattern popover: pictures, knobs, presets ───────────── */
    .${PLUGIN_ID}-pop { width: 380px; max-height: 80vh; }
    .${PLUGIN_ID}-icon { flex: none; opacity: .85; }
    .${PLUGIN_ID}-card-top {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-card .${PLUGIN_ID}-icon { color: var(--sx-tx2); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-card.is-sel .${PLUGIN_ID}-icon { color: var(--sx-ma); }

    .${PLUGIN_ID}-pattern-view {
      margin-top: 10px; padding: 8px 8px 6px;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
      border-radius: 8px;
    }
    #${PLUGIN_ID}-pattern-canvas { display: block; width: 100%; height: 96px; }
    .${PLUGIN_ID}-summary {
      margin-top: 6px; font-size: 12px; line-height: 1.45; color: var(--sx-tx);
    }

    .${PLUGIN_ID}-pop input[type=range].${PLUGIN_ID}-knob {
      -webkit-appearance: none; appearance: none;
      display: block; width: 100%; height: 18px; margin: 4px 0 0; padding: 0;
      background: transparent; cursor: pointer;
    }
    .${PLUGIN_ID}-pop input[type=range].${PLUGIN_ID}-knob::-webkit-slider-runnable-track {
      height: 4px; border-radius: 2px;
      background: linear-gradient(90deg, var(--sx-ma) var(--fill, 0%), var(--sx-ui3) var(--fill, 0%));
      box-shadow: inset 0 1px 1px rgba(0,0,0,calc(0.5*var(--sx-k)));
    }
    .${PLUGIN_ID}-pop input[type=range].${PLUGIN_ID}-knob::-moz-range-track {
      height: 4px; border-radius: 2px; background: var(--sx-ui3);
    }
    .${PLUGIN_ID}-pop input[type=range].${PLUGIN_ID}-knob::-moz-range-progress {
      height: 4px; border-radius: 2px; background: var(--sx-ma);
    }
    .${PLUGIN_ID}-pop input[type=range].${PLUGIN_ID}-knob::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; margin-top: -5px; border-radius: 50%;
      background: var(--sx-hi); border: 2px solid var(--sx-ma); box-shadow: 0 1px 4px rgba(0,0,0,calc(.5*var(--sx-k)));
    }
    .${PLUGIN_ID}-pop input[type=range].${PLUGIN_ID}-knob::-moz-range-thumb {
      width: 12px; height: 12px; border-radius: 50%;
      background: var(--sx-hi); border: 2px solid var(--sx-ma);
    }
    .${PLUGIN_ID}-pop input[type=range].${PLUGIN_ID}-knob:focus-visible { outline: none; }
    .${PLUGIN_ID}-pop input[type=range].${PLUGIN_ID}-knob:focus-visible::-webkit-slider-thumb {
      box-shadow: 0 0 0 3px rgba(var(--is-ma-rgb),.35);
    }

    .${PLUGIN_ID}-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-chip {
      display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
      padding: 5px 10px; border-radius: 8px; cursor: pointer;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      color: var(--sx-tx); font: inherit; font-size: 12px;
      transition: background .12s ease, border-color .12s ease;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-chip:hover {
      color: var(--sx-hi); border-color: rgba(var(--is-ma-rgb),0.4);
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-chip.is-sel {
      background: var(--sx-ui2);
      background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2));
      border-color: rgba(var(--is-ma-rgb),0.5); color: var(--sx-hi);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-chip .${PLUGIN_ID}-icon { color: var(--sx-ma); }
    .${PLUGIN_ID}-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
    .${PLUGIN_ID}-chip-dot {
      width: 6px; height: 6px; border-radius: 50%; background: var(--sx-ye); flex: none;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-chip-add {
      border-style: dashed; border-color: var(--sx-ui3); color: var(--sx-tx2); background: transparent;
    }
    .${PLUGIN_ID}-preset-edit { display: none; gap: 6px; margin-top: 8px; align-items: center; }
    .${PLUGIN_ID}-preset-edit input[type=text] {
      flex: 1 1 auto; min-width: 0; background: var(--sx-bg2); color: var(--sx-hi);
      border: 1px solid rgba(var(--is-ma-rgb),0.55); border-radius: 8px;
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
      padding: 5px 8px; font: inherit; font-size: 12px; outline: none;
    }
    .${PLUGIN_ID}-preset-bar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px;
    }
    .${PLUGIN_ID}-preset-bar:empty { display: none; }
    .${PLUGIN_ID}-preset-state { font-size: 12px; color: var(--sx-tx2); margin-right: auto; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-preset-edit button,
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-preset-bar button {
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx);
      border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); border-radius: 8px;
      box-shadow: 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
      padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-preset-bar button.${PLUGIN_ID}-quiet {
      background: transparent; border-color: transparent; box-shadow: none; color: var(--sx-tx2); padding: 4px 6px;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-preset-bar button.${PLUGIN_ID}-quiet:hover { color: var(--sx-hi); }
    /* Update and Save are the primary actions here: filled accent */
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-preset-bar button.is-on,
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-preset-edit button[data-act=save] {
      background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,calc(0.08*var(--sx-k)))), var(--sx-ma);
      border-color: var(--sx-line2); border-top-color: var(--sx-ma); color: var(--sx-on);
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-preset-bar button.is-danger {
      background: linear-gradient(180deg, rgba(var(--is-re-rgb),0.26), rgba(var(--is-re-rgb),0.14)), var(--sx-ui);
      border-color: rgba(var(--is-re-rgb),0.6); color: var(--sx-re-tx);
    }
    .${PLUGIN_ID}-field-help.is-warn { color: var(--sx-ye); }

    /* ── Advanced row: every control has a visible name ─────── */
    .${PLUGIN_ID}-adv {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 0 2px 10px; border-left: 1px solid rgba(255,255,255,0.08);
    }
    .${PLUGIN_ID}-adv-label { color: var(--sx-tx2) !important; font-weight: 500; }
    .${PLUGIN_ID}-adv-read {
      color: var(--sx-tx) !important; font-variant-numeric: tabular-nums; min-width: 0;
      font-size: 12px; white-space: nowrap;
    }
    .${PLUGIN_ID}-adv-note {
      color: var(--sx-tx2) !important; font-size: 12px; max-width: 260px; line-height: 1.3;
    }

    /* ── Script dock (under the toolbar, not floating) ────────── */
    /* It continues the toolbar inside the player, so it stays as dark as the
       bar; the inset shadow makes it read as hanging under it. */
    #${PLUGIN_ID}-dock.${PLUGIN_ID}-pop {
      position: relative; left: auto; top: auto; z-index: auto;
      width: auto; max-height: 55vh; overflow-y: auto;
      opacity: 1; pointer-events: auto; transform: none; transition: none;
      margin: 0; border-radius: 0 0 8px 8px; box-shadow: inset 0 8px 10px -8px rgba(0,0,0,calc(0.6*var(--sx-k)));
      border-top: 0; padding: 10px 14px 12px;
      background: linear-gradient(180deg, rgba(var(--is-bg-rgb),0.96), rgba(var(--is-bg2-rgb),0.96));
    }
    .${PLUGIN_ID}-dock-head {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px;
    }
    .${PLUGIN_ID}-dock-head strong { font-size: 12.5px; white-space: nowrap; color: var(--sx-hi); }
    .${PLUGIN_ID}-dock-head .${PLUGIN_ID}-memory {
      flex: 1 1 auto; margin: 0; padding: 4px 8px; flex-wrap: nowrap;
    }
    .${PLUGIN_ID}-dock-head .${PLUGIN_ID}-memory span { flex: 1 1 auto; }
    .${PLUGIN_ID}-dock-head > button {
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx);
      border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); border-radius: 8px;
      box-shadow: 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
      padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    .${PLUGIN_ID}-dock-head > button.is-on {
      background: var(--sx-ui2);
      background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2));
      border-color: rgba(var(--is-ma-rgb),0.5); color: var(--sx-hi);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .${PLUGIN_ID}-dock-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 4px 24px; margin-top: 8px;
    }
    .${PLUGIN_ID}-dock-col .${PLUGIN_ID}-sec-title { margin-top: 4px; }
    .${PLUGIN_ID}-dock .${PLUGIN_ID}-modes .${PLUGIN_ID}-card { padding: 6px 8px; }
    .${PLUGIN_ID}-dock .${PLUGIN_ID}-modes .${PLUGIN_ID}-card-blurb { font-size: 12px; }
    #${PLUGIN_ID}-sp-track { margin-bottom: 8px; }
    #${PLUGIN_ID}-sp-signal { margin-top: 10px; }
    #${PLUGIN_ID}-dock #${PLUGIN_ID}-preview { height: 130px !important; }
    /* the script button lights like "Manual on" while the script drives the toy */
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 5px 8px; min-width: 30px;
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-icon-btn svg { width: 15px; height: 15px; display: block; }

    /* ── Script panel ─────────────────────────────────────────── */
    .${PLUGIN_ID}-memory {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      margin-bottom: 10px; padding: 7px 9px; border-radius: 8px;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
      font-size: 12px; color: var(--sx-tx2); line-height: 1.4;
    }
    .${PLUGIN_ID}-memory span { flex: 1 1 100%; }
    .${PLUGIN_ID}-memory.is-tuned { border-color: rgba(var(--is-ma-rgb),0.45); color: var(--sx-tx); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-memory button,
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-field-head > button {
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx);
      border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); border-radius: 8px;
      box-shadow: 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
      padding: 3px 9px; font: inherit; font-size: 12px; cursor: pointer;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-field-head > button.is-on {
      background: var(--sx-ui2);
      background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2));
      border-color: rgba(var(--is-ma-rgb),0.5); color: var(--sx-hi);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .${PLUGIN_ID}-sp-pick { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .${PLUGIN_ID}-sp-pick label { font-size: 12px; color: var(--sx-tx); }
    .${PLUGIN_ID}-pop select {
      background: var(--sx-bg2); color: var(--sx-hi); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
      border-radius: 8px; padding: 3px 6px; font: inherit; font-size: 12px; max-width: 230px;
    }
    .${PLUGIN_ID}-overview { margin-bottom: 4px; }
    #${PLUGIN_ID}-overview-canvas {
      display: block; width: 100%; height: 44px; cursor: pointer;
      background: var(--sx-bg2); border-radius: 8px;
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
    }
    .${PLUGIN_ID}-field-words { font-size: 12px; color: var(--sx-ma); margin-right: auto; margin-left: 8px; }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-script-name {
      max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-script-name.is-tuned { border-color: rgba(var(--is-ma-rgb),0.45); }
    .${PLUGIN_ID}-micro-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-micro-row button {
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx);
      border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3);
      box-shadow: 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
      border-radius: 8px; padding: 3px 9px; font: inherit; font-size: 12px; cursor: pointer;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-micro-row button.is-on {
      background: var(--sx-ui2);
      background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2));
      border-color: rgba(var(--is-ma-rgb),0.5); color: var(--sx-hi);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    }

    /* ── 1.38: one compact bar ──────────────────────────────────
       Status, Script|Manual, level and pattern on the left; settings, the
       device switch, Disconnect and "Not using it" on the right. It sits
       in Stash's player, so it stays a quiet strip (THEME rules: no big
       slabs over Stash's page); the panels it opens get the full depth. */
    #${PLUGIN_ID}-toolbar {
      background: linear-gradient(180deg, var(--sx-bg2), var(--sx-bg)) !important;
      backdrop-filter: none; -webkit-backdrop-filter: none;
      border-top: 1px solid var(--sx-ui) !important;
      box-shadow: none;
      padding: 6px 10px !important; gap: 6px !important;
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-row {
      display: flex; align-items: center; gap: 8px; width: 100%; flex-wrap: wrap; min-width: 0;
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-grp { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-right { margin-left: auto; gap: 4px; }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-level { gap: 8px; }

    /* status: a sunk well with a dot in the state's colour; the one action
       for that state sits right of it as a small button */
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status {
      --c: var(--sx-tx2b);
      display: inline-flex; align-items: center; gap: 7px; min-width: 0; max-width: 300px;
      padding: 4px 10px 4px 9px; border-radius: 8px;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
      color: var(--sx-tx); font-weight: 500; white-space: nowrap; overflow: hidden;
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status[data-tone=good]   { --c: var(--sx-gr); }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status[data-tone=warn]   { --c: var(--sx-ye); }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status[data-tone=danger] { --c: var(--sx-re); }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status[data-tone=info]   { --c: var(--sx-bl); }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status[data-tone=note]   { --c: var(--sx-ye); color: var(--sx-ye-l); }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-dot {
      width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--c);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 22%, transparent);
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status.is-playing .${PLUGIN_ID}-dot { animation: ${PLUGIN_ID}-beat 1.6s ease-in-out infinite; }
    @keyframes ${PLUGIN_ID}-beat { 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--c) 10%, transparent); } }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-txt {
      overflow: hidden; text-overflow: ellipsis; min-width: 0; color: inherit; font-weight: 500;
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status-act {
      padding: 4px 10px; white-space: nowrap;
      background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,calc(0.08*var(--sx-k)))), var(--sx-ma);
      border-color: var(--sx-line2); border-top-color: var(--sx-ma-tx); color: var(--sx-on); font-weight: 600;
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status-act:hover { color: var(--sx-on); filter: brightness(1.08); }

    /* Script | Manual: a segmented control in a sunk well */
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-seg {
      display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-seg button {
      background: transparent !important; border: 1px solid transparent !important;
      box-shadow: none !important; color: var(--sx-tx2); padding: 3px 10px !important; border-radius: 6px;
      display: inline-flex; align-items: center; gap: 0; max-width: 220px;
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-seg button:hover { color: var(--sx-hi); }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-seg button.is-sel {
      background: var(--sx-ui2) !important;
      background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2)) !important;
      border-color: rgba(var(--is-ma-rgb),0.5) !important; color: var(--sx-hi);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08) !important;
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-seg button.is-dim { opacity: 0.75; }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-live {
      width: 6px; height: 6px; border-radius: 50%; background: var(--sx-gr); margin-left: 6px; flex: none;
      box-shadow: 0 0 0 2px rgba(var(--is-gr-rgb),0.25);
    }

    /* quiet icon buttons: no slab until hovered */
    #${PLUGIN_ID}-toolbar button.${PLUGIN_ID}-quiet {
      background: transparent; border-color: transparent; box-shadow: none; color: var(--sx-tx2);
    }
    #${PLUGIN_ID}-toolbar button.${PLUGIN_ID}-quiet:hover {
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); border-color: var(--sx-line2); border-top-color: var(--sx-ui3); color: var(--sx-hi);
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-output-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-output-btn .${PLUGIN_ID}-ic { width: 14px; height: 14px; }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-output-btn .${PLUGIN_ID}-word { color: inherit; font-weight: 600; }

    /* the favourite pattern of someone in this scene, offered, never applied by itself */
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-fav-offer {
      display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 340px;
      padding: 2px 4px 2px 9px; border-radius: 8px;
      background: var(--sx-ui2); background: color-mix(in srgb, var(--sx-ma) 12%, var(--sx-ui));
      border: 1px solid rgba(var(--is-ma-rgb),0.35); color: var(--sx-tx);
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-fav-offer .${PLUGIN_ID}-ic { color: var(--sx-ma); }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-fav-offer .${PLUGIN_ID}-txt {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: var(--sx-tx); font-weight: 500;
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-fav-offer button { padding: 2px 9px; font-size: 12px; }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-fav-offer button.${PLUGIN_ID}-quiet { padding: 2px 4px; min-width: 0; }

    /* off: one small pill where the bar was */
    #${PLUGIN_ID}-pill { display: flex; align-items: center; padding: 6px 10px; position: relative; z-index: 1; }
    #${PLUGIN_ID}-pill button {
      display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
      padding: 3px 11px 3px 9px; border-radius: 6px; font: inherit; font-size: 12px; font-weight: 500;
      background: var(--sx-bg2); color: var(--sx-tx2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k))); transition: color .12s ease, border-color .12s ease;
    }
    #${PLUGIN_ID}-pill button:hover { color: var(--sx-hi); border-color: rgba(var(--is-ma-rgb),0.45); }
    #${PLUGIN_ID}-pill .${PLUGIN_ID}-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--sx-tx3); flex: none; }

    /* the suite's switch: 26x15 track, 11px knob */
    .${PLUGIN_ID}-pop button.${PLUGIN_ID}-tog,
    #${PLUGIN_ID}-toolbar button.${PLUGIN_ID}-tog {
      display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
      background: transparent; border: 0; box-shadow: none; padding: 5px 0; border-radius: 0;
      color: var(--sx-tx); font: inherit; font-size: 12px; cursor: pointer;
    }
    .${PLUGIN_ID}-pop button.${PLUGIN_ID}-tog:hover { color: var(--sx-hi); }
    .${PLUGIN_ID}-tog i {
      width: 26px; height: 15px; border-radius: 8px; background: var(--sx-ui3); position: relative; flex: none;
      box-shadow: inset 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
    }
    .${PLUGIN_ID}-tog i::after {
      content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px;
      border-radius: 50%; background: var(--sx-tx2); transition: left .15s;
    }
    .${PLUGIN_ID}-pop button.${PLUGIN_ID}-tog.is-on { background: transparent; border: 0; box-shadow: none; color: var(--sx-hi); }
    .${PLUGIN_ID}-tog.is-on i { background: var(--sx-ma); }
    .${PLUGIN_ID}-tog.is-on i::after { left: 13px; background: var(--sx-paper); }
    .${PLUGIN_ID}-pop button.${PLUGIN_ID}-tog.is-locked { opacity: 0.5; cursor: not-allowed; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-micro-row button.${PLUGIN_ID}-tog { width: auto; padding: 0; }

    /* settings panel */
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx);
      border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); border-radius: 8px;
      box-shadow: 0 1px 2px rgba(0,0,0,calc(0.5*var(--sx-k)));
      padding: 5px 11px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn:hover { color: var(--sx-hi); border-top-color: var(--sx-tx3); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn.is-danger { color: var(--sx-re-tx); border-color: rgba(var(--is-re-rgb),0.6);
      background: linear-gradient(180deg, rgba(var(--is-re-rgb),0.22), rgba(var(--is-re-rgb),0.12)), var(--sx-ui); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn.is-on {
      background: var(--sx-ui2); background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2));
      border-color: rgba(var(--is-ma-rgb),0.5); color: var(--sx-hi);
    }
    .${PLUGIN_ID}-btns { display: flex; flex-wrap: wrap; gap: 6px; }
    .${PLUGIN_ID}-pop kbd {
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3);
      border-radius: 6px; padding: 0 5px; font: inherit; font-size: 11px; color: var(--sx-hi);
    }
    .${PLUGIN_ID}-keys { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--sx-tx2); }
    #${PLUGIN_ID}-settings-pop .${PLUGIN_ID}-section:first-of-type { margin-top: 10px; }
    #${PLUGIN_ID}-settings-pop .${PLUGIN_ID}-btns { margin-top: 6px; }
    .${PLUGIN_ID}-fav-row {
      display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 6px 0; border-top: 1px solid var(--sx-ui);
    }
    .${PLUGIN_ID}-fav-row:first-child { border-top: 0; }
    .${PLUGIN_ID}-fav-name { flex: 1 1 140px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sx-hi); }
    .${PLUGIN_ID}-fav-what { display: block; font-size: 12px; color: var(--sx-tx2); }

    /* toast: the suite's one design (raised, 12px, a 3px edge in the kind's colour) */
    #${PLUGIN_ID}-toast {
      --c: var(--sx-bl);
      position: fixed; left: 50%; bottom: 72px; z-index: 10070; pointer-events: none;
      max-width: min(420px, calc(100vw - 32px)); box-sizing: border-box; width: max-content;
      padding: 9px 14px 9px 12px; border-radius: 12px;
      background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
      border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-left: 3px solid var(--c);
      color: var(--sx-tx); font-size: 13px; line-height: 1.4;
      box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k)));
      opacity: 0; transform: translateX(-50%) translateY(6px);
      transition: opacity .16s ease, transform .16s ease;
    }
    #${PLUGIN_ID}-toast.is-on { opacity: 1; transform: translateX(-50%); }
    #${PLUGIN_ID}-toast.is-done  { --c: var(--sx-gr); }
    #${PLUGIN_ID}-toast.is-warn  { --c: var(--sx-ye); }
    #${PLUGIN_ID}-toast.is-error { --c: var(--sx-re); }

    /* quick slots (1.43) */
    .${PLUGIN_ID}-slots { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
    .${PLUGIN_ID}-slots-title { font-size: 11px; color: var(--sx-tx2); width: 100%; }
    .${PLUGIN_ID}-slot { display: inline-flex; align-items: stretch; gap: 2px; max-width: 100%; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-slot .${PLUGIN_ID}-chip { border-top-right-radius: 0; border-bottom-right-radius: 0; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-slot .${PLUGIN_ID}-chip:disabled { opacity: .55; cursor: default; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-slot .${PLUGIN_ID}-chip-name { max-width: 120px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-slot-pin {
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      border-radius: 0 8px 8px 0; color: var(--sx-tx2); font: inherit; font-size: 12px; padding: 0 7px; cursor: pointer;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-slot-pin:hover:not(:disabled) { color: var(--sx-hi); border-color: rgba(var(--is-ma-rgb),0.4); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-slot-pin:disabled { opacity: .45; cursor: default; }
    /* Goon mode 2 (1.44): the pad over the player (a strip in fullscreen, a
       bottom sheet on a phone) and the panel section. Raised panel, meaning
       colours per THEME: orange Edge, blue Cool down, cyan the build-up. */
    #${PLUGIN_ID}-goonpad {
      position: fixed; z-index: 10060; width: 384px; max-width: calc(100vw - 8px); box-sizing: border-box;
      padding: 10px 12px 12px; border-radius: 12px; touch-action: none; user-select: none;
      background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
      border: 1px solid var(--sx-line); border-top-color: var(--sx-edge);
      box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k)));
      color: var(--sx-tx); font-size: 12px; display: none;
    }
    #${PLUGIN_ID}-goonpad.is-on { display: flex; flex-direction: column; gap: 9px; }
    #${PLUGIN_ID}-goonpad button { font: inherit; cursor: pointer; }
    .${PLUGIN_ID}-slot kbd, .${PLUGIN_ID}-g2-keys kbd {
      background: rgba(0,0,0,calc(.28*var(--sx-k))); border: 1px solid rgba(255,255,255,.12); border-radius: 4px;
      padding: 1px 4px; font: 600 9.5px/1.2 ui-monospace, Consolas, monospace; color: var(--sx-tx1b); white-space: nowrap;
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-head { display: flex; align-items: center; gap: 6px; cursor: move; min-height: 28px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-hsp { flex: 1 1 auto; min-width: 0; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-grip { width: 8px; height: 14px; flex: none; opacity: .6;
      background: radial-gradient(circle, var(--sx-tx3) 1.2px, transparent 1.4px) 0 0 / 4px 4.6px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-head strong { color: var(--sx-hi); font-size: 13.5px; white-space: nowrap; }
    /* 1.50: the style as its sketch and a word, never cut short */
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-style {
      display: inline-flex; align-items: center; gap: 6px; flex: none; height: 24px; padding: 0 8px 0 6px; font-size: 12px; white-space: nowrap;
      color: var(--sx-tx1b); background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); border-radius: 8px;
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-style:hover { color: var(--sx-hi); border-color: color-mix(in srgb, var(--sx-cy) 45%, transparent); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-style .${PLUGIN_ID}-sk svg { display: block; width: 28px; height: 11px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-help { min-width: 24px; min-height: 24px; padding: 2px; cursor: help; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-x .${PLUGIN_ID}-ic { width: 15px; height: 15px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-x {
      background: transparent; border: 0; color: var(--sx-tx2); padding: 4px; min-width: 28px; min-height: 28px; flex: none;
      display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-x:hover { color: var(--sx-hi); background: var(--sx-ui2); }
    /* 1.45: Goon off is a labelled button (an x on a floating panel read as "close") */
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-end { min-height: 26px; padding: 0 9px; font-size: 12px; font-weight: 600; white-space: nowrap;
      border: 1px solid var(--sx-line2); border-radius: 8px; color: var(--sx-tx1b); }
    .${PLUGIN_ID}-g2-chip { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 8px; color: var(--sx-hi); font-weight: 600;
      background: color-mix(in srgb, var(--c) 26%, var(--sx-ui2)); border: 1px solid color-mix(in srgb, var(--c) 58%, transparent); white-space: nowrap; }
    .${PLUGIN_ID}-g2-left { color: var(--sx-hi); font-variant-numeric: tabular-nums; }
    .${PLUGIN_ID}-g2-held { color: var(--sx-ye-tx); font-weight: 600; white-space: nowrap; }
    /* 1.49: a Goon started from another plugin (Lockdown) says so */
    .${PLUGIN_ID}-g2-src { color: var(--sx-cy-tx); font-weight: 600; white-space: nowrap; }
    .${PLUGIN_ID}-g2-then { color: var(--sx-tx2); font-size: 12px; margin-left: auto; text-align: right; min-width: 0; }
    .${PLUGIN_ID}-g2-learned { color: var(--sx-gr-tx); font-weight: 700; }
    .${PLUGIN_ID}-g2-link { background: none; border: 0; padding: 0; color: var(--sx-bl-tx); text-decoration: underline; font: inherit; cursor: pointer; }
    /* 1.50: one line; what comes next is cut with an ellipsis, whole on hover */
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-status { display: flex; align-items: center; gap: 8px; font-size: 13px; min-height: 24px; flex-wrap: nowrap; min-width: 0; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-status .${PLUGIN_ID}-g2-then { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-main { display: flex; flex-direction: column; gap: 8px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-graph {
      height: 72px; border-radius: 8px; overflow: hidden; background: var(--sx-bg2);
      border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-graph svg { display: block; }
    /* 1.50: one level control on the pad and in the deck: a stepper
       around ten small dots, the number and the % at the motor */
    .${PLUGIN_ID}-lvctl { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .${PLUGIN_ID}-lvstep {
      width: 32px; height: 32px; flex: none; border-radius: 8px; padding: 0; font-size: 17px; line-height: 1; color: var(--sx-hi); cursor: pointer;
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3);
      box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k)));
    }
    .${PLUGIN_ID}-lvstep:hover { border-top-color: var(--sx-tx3); }
    .${PLUGIN_ID}-lvdots { display: flex; align-items: center; justify-content: space-between; flex: 1 1 auto; min-width: 0; }
    .${PLUGIN_ID}-lvdots button {
      flex: 1 1 0; min-width: 0; max-width: 24px; height: 28px; padding: 0; margin: 0; border: 0; background: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; font: inherit;
    }
    .${PLUGIN_ID}-lvdots button i {
      display: block; width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box;
      background: var(--sx-bg2); border: 1px solid var(--sx-tx2b); transition: transform .12s;
    }
    .${PLUGIN_ID}-lvdots button:hover i { border-color: var(--sx-tx1b); transform: scale(1.2); }
    .${PLUGIN_ID}-lvdots button:focus-visible { outline: 2px solid var(--sx-cy-tx); outline-offset: -2px; border-radius: 6px; }
    .${PLUGIN_ID}-lvdots button.is-below i { background: color-mix(in srgb, var(--sx-cy) 55%, var(--sx-bg2)); border-color: color-mix(in srgb, var(--sx-cy) 70%, transparent); }
    .${PLUGIN_ID}-lvdots button.is-on i { width: 14px; height: 14px; background: var(--sx-cy); border-color: var(--sx-cy-tx); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sx-cy) 28%, transparent); }
    .${PLUGIN_ID}-lvdots button.is-start i { border-color: var(--sx-hi); }
    .${PLUGIN_ID}-lvnum { display: flex; flex-direction: column; align-items: flex-end; min-width: 40px; flex: none; line-height: 1.05; }
    .${PLUGIN_ID}-lvnum b { font-size: 22px; color: var(--sx-hi); font-variant-numeric: tabular-nums; }
    .${PLUGIN_ID}-lvnum small { font-size: 11px; color: var(--sx-tx2); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .${PLUGIN_ID}-g2-lvs button.is-start { color: var(--sx-hi); box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--sx-cy) 55%, transparent); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-padbar { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--sx-tx2);
      text-transform: uppercase; letter-spacing: .05em; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-count { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; text-transform: none; letter-spacing: 0; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-count b { min-width: 16px; text-align: center; color: var(--sx-hi); font-size: 12px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-count button, #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-edit {
      min-width: 26px; height: 24px; padding: 0 7px; border-radius: 6px; color: var(--sx-tx1b); font-size: 12px; text-transform: none; letter-spacing: 0;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
    }
    #${PLUGIN_ID}-goonpad.is-edit .${PLUGIN_ID}-gp-edit { color: var(--sx-on); background: var(--sx-cy); border-color: var(--sx-cy); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pads { display: grid; gap: 8px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pad {
      position: relative; overflow: hidden; height: 64px; min-width: 0; border-radius: 10px; color: var(--sx-hi); text-align: left;
      display: flex; flex-direction: column; align-items: stretch; justify-content: space-between; gap: 4px; padding: 8px 8px 7px; box-sizing: border-box;
      background: linear-gradient(180deg, color-mix(in srgb, var(--c) 26%, var(--sx-ui2)), color-mix(in srgb, var(--c) 14%, var(--sx-ui)));
      border: 1px solid color-mix(in srgb, var(--c) 50%, transparent); box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k)));
      touch-action: none;
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pad b { font-size: 12px; font-weight: 600; line-height: 1.15; max-width: 100%; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pad-top { display: flex; width: 100%; align-items: flex-end; gap: 6px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pad-top svg { flex: 1 1 0; width: 0; min-width: 0; height: 18px; display: block; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pad small { font-size: 10px; color: var(--sx-tx1b); white-space: nowrap; font-variant-numeric: tabular-nums; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pad em { display: none; font: 600 11px/1 ui-monospace, Consolas, monospace; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pad i { position: absolute; left: 0; bottom: 0; height: 3px; width: 0; background: var(--sx-hi); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pad.is-on {
      background: linear-gradient(180deg, color-mix(in srgb, var(--c) 52%, var(--sx-ui2)), color-mix(in srgb, var(--c) 36%, var(--sx-ui)));
      border-color: color-mix(in srgb, var(--c) 90%, transparent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 45%, transparent), 0 6px 16px rgba(0,0,0,calc(.5*var(--sx-k)));
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pad.is-latched i { background: var(--sx-ye-tx); }
    #${PLUGIN_ID}-goonpad.is-edit .${PLUGIN_ID}-gp-pad { outline: 1px dashed var(--sx-tx2); outline-offset: -4px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-moves { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-move {
      min-height: 40px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--sx-hi); white-space: nowrap; padding: 0 6px;
      display: inline-flex; align-items: center; justify-content: center; gap: 5px; box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k)));
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3);
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-move.is-edge, .${PLUGIN_ID}-g2-moves .is-edge { --c: var(--sx-or); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-move.is-cool, .${PLUGIN_ID}-g2-moves .is-cool { --c: var(--sx-bl); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-move.is-edge, #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-move.is-cool,
    .${PLUGIN_ID}-g2-moves .is-edge, .${PLUGIN_ID}-g2-moves .is-cool {
      background: linear-gradient(180deg, color-mix(in srgb, var(--c) 38%, var(--sx-ui2)), color-mix(in srgb, var(--c) 22%, var(--sx-ui)));
      border: 1px solid color-mix(in srgb, var(--c) 60%, transparent);
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-move.is-hold.is-active { --c: var(--sx-ye); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-move.is-active { box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 55%, transparent); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-learn { font-size: 11.5px; color: var(--sx-tx1b); line-height: 1.4; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-learn:empty { display: none; }
    #${PLUGIN_ID}-goonpad.is-held .${PLUGIN_ID}-gp-graph { border-color: color-mix(in srgb, var(--sx-ye) 60%, transparent); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pick {
      position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 2; padding: 10px; border-radius: 10px;
      background: var(--sx-ui); border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); max-height: 70%; overflow: auto;
      box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k)));
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pick[hidden] { display: none; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pick-head { display: flex; align-items: center; justify-content: space-between; color: var(--sx-hi); margin-bottom: 6px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pick-cap { font-size: 11px; color: var(--sx-tx2); margin: 8px 0 4px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pick-row { display: flex; flex-wrap: wrap; gap: 5px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-gp-pick-row + .${PLUGIN_ID}-gp-pick-row { margin-top: 8px; }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-chip {
      padding: 4px 9px; border-radius: 8px; font-size: 12px; color: var(--sx-tx1b); min-height: 28px;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
    }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-chip.is-sel { color: var(--sx-hi); background: color-mix(in srgb, var(--sx-cy) 24%, var(--sx-ui2)); border-color: color-mix(in srgb, var(--sx-cy) 55%, transparent); }
    #${PLUGIN_ID}-goonpad .${PLUGIN_ID}-quiet { background: none; border: 0; color: var(--sx-tx2); text-decoration: underline; padding: 2px 0; }
    /* the strip: fullscreen (or made small): status, a 40 px graph, the
       level, pad numbers and the moves */
    #${PLUGIN_ID}-goonpad.is-mini { width: auto; padding: 8px 10px; gap: 6px; background: rgba(var(--is-bg2-rgb),.92); }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-head strong, #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-style,
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-lvdots, #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-padbar,
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-learn, #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-pad svg,
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-pad b, #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-pad-top,
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-help { display: none; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-main { flex-direction: row; align-items: center; gap: 10px; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-graph { width: 170px; height: 40px; flex: none; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-lvctl { gap: 4px; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-lvnum { align-items: center; min-width: 40px; order: 1; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-lvctl > .${PLUGIN_ID}-lvstep:nth-child(3) { order: 2; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-lvstep { width: 28px; height: 28px; font-size: 15px; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-pads { display: flex; flex-wrap: wrap; gap: 4px; width: 148px; flex: none; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-pad em { display: block; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-pad { width: 34px; height: 24px; padding: 0; justify-content: center; align-items: center; border-radius: 6px; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-moves { grid-template-columns: repeat(3, auto); gap: 6px; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-move { min-height: 40px; font-size: 11.5px; padding: 0 8px; }
    #${PLUGIN_ID}-goonpad.is-mini .${PLUGIN_ID}-gp-status { font-size: 12px; min-height: 0; }
    /* a phone: a bottom sheet, every target at least 44 px */
    #${PLUGIN_ID}-goonpad.is-sheet {
      left: 0 !important; right: 0; top: auto !important; bottom: 0; width: 100%; max-width: none; border-radius: 14px 14px 0 0;
      padding: 14px 16px 16px; max-height: 78vh; overflow: auto; border-bottom: 0;
    }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-head { cursor: default; }
    /* 1.49: dragged from anywhere but its controls; the sheet scrolls instead */
    #${PLUGIN_ID}-goonpad:not(.is-sheet) { cursor: move; }
    #${PLUGIN_ID}-goonpad.is-dragging { opacity: .92; }
    /* 1.50: Show pad (in the deck) makes it blink once so it can be found */
    #${PLUGIN_ID}-goonpad.is-flash { outline: 2px solid var(--sx-cy-tx); outline-offset: 2px; }
    /* 1.50: muted text on these dark panels at #9F9D96 (5.5:1 on --ui), not
       #878580 (4.0:1, under the 4.5 the user asked for) */
    html #${PLUGIN_ID}-goonpad, html #${PLUGIN_ID}-deck, html #${PLUGIN_ID}-toolbar { --sx-tx2: var(--sx-grey); }
    #${PLUGIN_ID}-goonpad.is-sheet { touch-action: pan-y; }
    #${PLUGIN_ID}-goonpad.is-sheet::before {
      content: ""; position: absolute; left: 50%; top: 5px; width: 40px; height: 4px; margin-left: -20px; border-radius: 2px; background: var(--sx-ui3);
    }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-grip, #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-help, #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-hsp { display: none; }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-x, #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-style { min-width: 44px; min-height: 44px; }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-style { margin-left: auto; }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-graph { height: 64px; }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-lvstep { width: 44px; height: 44px; }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-lvdots button { height: 44px; max-width: none; }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-count button, #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-edit { min-width: 44px; height: 44px; }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-pad { height: 64px; }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-gp-move { min-height: 48px; font-size: 14px; }
    #${PLUGIN_ID}-goonpad.is-sheet .${PLUGIN_ID}-chip { min-height: 44px; }
    #${PLUGIN_ID}-goonpad.is-sheet.is-mini .${PLUGIN_ID}-gp-main { flex-direction: column; align-items: stretch; }
    #${PLUGIN_ID}-goonpad.is-sheet.is-mini .${PLUGIN_ID}-gp-graph { width: auto; }
    #${PLUGIN_ID}-goonpad.is-sheet.is-mini .${PLUGIN_ID}-gp-pads { width: auto; display: grid; }
    #${PLUGIN_ID}-goonpad.is-sheet.is-mini .${PLUGIN_ID}-gp-pad { width: auto; height: 44px; }
    #${PLUGIN_ID}-goonpad.is-sheet.is-mini .${PLUGIN_ID}-gp-moves { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    /* the panel's Goon section */
    .${PLUGIN_ID}-g2-cap { font-size: 11px; color: var(--sx-tx2); text-transform: uppercase; letter-spacing: .06em; margin: 12px 0 6px; }
    .${PLUGIN_ID}-g2-cap span { text-transform: none; letter-spacing: 0; margin-left: 6px; }
    .${PLUGIN_ID}-g2-styles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
    .${PLUGIN_ID}-g2-sty {
      display: flex; flex-direction: column; gap: 3px; padding: 8px 9px; border-radius: 10px; text-align: left; min-width: 0; cursor: pointer; font: inherit;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); color: var(--sx-tx);
    }
    .${PLUGIN_ID}-g2-sty.is-on { background: color-mix(in srgb, var(--sx-cy) 22%, var(--sx-ui2)); border-color: color-mix(in srgb, var(--sx-cy) 55%, transparent); }
    .${PLUGIN_ID}-g2-sty-top { display: flex; align-items: center; gap: 6px; }
    .${PLUGIN_ID}-g2-sty-top b { color: var(--sx-hi); font-size: 13px; }
    .${PLUGIN_ID}-g2-sk { margin-left: auto; flex: none; line-height: 0; }
    .${PLUGIN_ID}-g2-sty > span:last-child { font-size: 11px; color: var(--sx-tx2); line-height: 1.35; }
    .${PLUGIN_ID}-g2-lvs { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 4px; }
    .${PLUGIN_ID}-g2-lvs button { height: 36px; font-size: 14px; cursor: pointer; }
    .${PLUGIN_ID}-g2-seg { display: flex; gap: 4px; padding: 4px; border-radius: 11px; background: var(--sx-bg2);
      border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); box-shadow: inset 0 2px 4px rgba(0,0,0,calc(.5*var(--sx-k))); }
    .${PLUGIN_ID}-g2-seg button { flex: 1; height: 32px; border-radius: 8px; font: inherit; font-size: 13px; cursor: pointer; color: var(--sx-tx1b);
      background: none; border: 1px solid transparent; }
    .${PLUGIN_ID}-g2-seg button.is-on { color: var(--sx-hi); background: color-mix(in srgb, var(--sx-cy) 24%, var(--sx-ui)); border-color: color-mix(in srgb, var(--sx-cy) 55%, transparent);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 2px 6px rgba(0,0,0,calc(.4*var(--sx-k))); }
    .${PLUGIN_ID}-g2-now { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; }
    .${PLUGIN_ID}-g2-now .${PLUGIN_ID}-g2-then { margin-left: 0; text-align: left; }
    .${PLUGIN_ID}-g2-nums { margin-left: auto; color: var(--sx-tx2); font-size: 12px; }
    .${PLUGIN_ID}-g2-nums b { color: var(--sx-hi); font-size: 16px; margin: 0 2px; }
    .${PLUGIN_ID}-g2-graph { height: 170px; margin-top: 8px; border-radius: 10px; overflow: hidden;
      background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px); border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); }
    .${PLUGIN_ID}-g2-graph svg { display: block; }
    .${PLUGIN_ID}-g2-moves { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
    .${PLUGIN_ID}-g2-moves button {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 56px; padding: 4px;
      border-radius: 10px; font: inherit; cursor: pointer; color: var(--sx-hi);
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3);
    }
    .${PLUGIN_ID}-g2-moves b { font-size: 14px; }
    .${PLUGIN_ID}-g2-moves span { font-size: 10.5px; color: var(--sx-tx1b); text-align: center; line-height: 1.25; }
    .${PLUGIN_ID}-g2-learn { margin-top: 8px; font-size: 12px; color: var(--sx-tx1b); line-height: 1.45; }
    .${PLUGIN_ID}-g2-keys { margin-top: 10px; padding: 8px 9px; border-radius: 9px; background: var(--sx-bg2); font-size: 11.5px; color: var(--sx-tx2); line-height: 1.8; }


    /* scenes without a funscript: a raised panel over a dimmed page */
    #${PLUGIN_ID}-nofs {
      position: fixed; inset: 0; z-index: 10060; background: rgba(var(--is-bg-rgb),0.62);
      display: flex; align-items: flex-start; justify-content: center; padding: 56px 16px 24px;
      overflow-y: auto; overscroll-behavior: contain;
    }
    #${PLUGIN_ID}-nofs .${PLUGIN_ID}-sheet {
      width: 100%; max-width: 900px; box-sizing: border-box; padding: 18px 20px 16px;
      background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
      border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-radius: 12px;
      box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k)));
      color: var(--sx-tx); font-size: 13px;
    }
    .${PLUGIN_ID}-nf-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .${PLUGIN_ID}-nf-badge {
      width: 30px; height: 30px; border-radius: 8px; flex: none; display: grid; place-items: center;
      color: var(--sx-ma); background: color-mix(in srgb, var(--sx-ma) 17%, var(--sx-ui));
      border: 1px solid color-mix(in srgb, var(--sx-ma) 30%, transparent);
    }
    .${PLUGIN_ID}-nf-badge svg { width: 16px; height: 16px; }
    .${PLUGIN_ID}-nf-title { font-size: 20px; font-weight: 700; color: var(--sx-hi); line-height: 1.2; }
    .${PLUGIN_ID}-nf-sub { font-size: 12.5px; color: var(--sx-tx2); }
    .${PLUGIN_ID}-nf-head .${PLUGIN_ID}-nf-close {
      margin-left: auto; background: transparent; border: 1px solid transparent; color: var(--sx-tx2);
      border-radius: 8px; padding: 5px; cursor: pointer; display: grid; place-items: center;
    }
    .${PLUGIN_ID}-nf-head .${PLUGIN_ID}-nf-close:hover { color: var(--sx-hi); border-color: var(--sx-ui3); }
    .${PLUGIN_ID}-nf-close svg { width: 16px; height: 16px; display: block; }
    .${PLUGIN_ID}-nf-scopes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .${PLUGIN_ID}-nf-chip {
      display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
      padding: 5px 11px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12.5px;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); color: var(--sx-tx);
    }
    .${PLUGIN_ID}-nf-chip:hover { color: var(--sx-hi); border-color: rgba(var(--is-ma-rgb),0.4); }
    .${PLUGIN_ID}-nf-chip.is-sel {
      background: var(--sx-ui2); background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui2));
      border-color: rgba(var(--is-ma-rgb),0.5); color: var(--sx-hi); box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .${PLUGIN_ID}-nf-chip small { color: var(--sx-tx2); font-size: 11.5px; }
    .${PLUGIN_ID}-nf-sum {
      display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 12px;
      padding: 10px 12px; border-radius: 10px;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
    }
    .${PLUGIN_ID}-nf-big { font-size: 22px; font-weight: 700; color: var(--sx-hi); font-variant-numeric: tabular-nums; }
    .${PLUGIN_ID}-nf-bar { flex: 1 1 160px; height: 6px; border-radius: 6px; background: var(--sx-ui); overflow: hidden; align-self: center; }
    .${PLUGIN_ID}-nf-bar i { display: block; height: 100%; background: var(--sx-ma); box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
    .${PLUGIN_ID}-nf-sum a { color: var(--sx-bl); text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
    .${PLUGIN_ID}-nf-sum a:hover { color: var(--sx-bl-tx); }
    .${PLUGIN_ID}-nf-sum a svg { width: 13px; height: 13px; }
    .${PLUGIN_ID}-nf-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.6fr); gap: 14px; }
    .${PLUGIN_ID}-nf-col h4 {
      margin: 0 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--sx-tx2b);
      display: flex; align-items: center; gap: 8px;
    }
    .${PLUGIN_ID}-nf-col h4 select {
      margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400;
    }
    .${PLUGIN_ID}-nf-row {
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
      padding: 5px 8px; border-radius: 8px; border: 1px solid transparent; background: transparent;
      color: var(--sx-tx); font: inherit; font-size: 12.5px; cursor: pointer; text-decoration: none;
    }
    .${PLUGIN_ID}-nf-row:hover { background: var(--sx-ui2); color: var(--sx-hi); text-decoration: none !important; }
    #${PLUGIN_ID}-nofs a:hover { text-decoration: none; }
    .${PLUGIN_ID}-nf-row .${PLUGIN_ID}-nf-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${PLUGIN_ID}-nf-row .${PLUGIN_ID}-nf-n { color: var(--sx-tx2); font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12px; }
    .${PLUGIN_ID}-nf-row .${PLUGIN_ID}-nf-meta { display: block; color: var(--sx-tx2); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${PLUGIN_ID}-nf-empty { padding: 10px 8px; color: var(--sx-tx2); font-size: 12.5px; }
    .${PLUGIN_ID}-nf-load { height: 3px; border-radius: 3px; background: var(--sx-ui); overflow: hidden; margin: 2px 0 12px; }
    .${PLUGIN_ID}-nf-load i { display: block; height: 100%; width: 30%; background: var(--sx-ma); animation: ${PLUGIN_ID}-slide 1.1s ease-in-out infinite; }
    @keyframes ${PLUGIN_ID}-slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
    .${PLUGIN_ID}-nf-err { color: var(--sx-re-tx); font-size: 12.5px; margin-bottom: 10px; }
    #${PLUGIN_ID}-nofs select {
      background: var(--sx-bg2); color: var(--sx-hi); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k))); border-radius: 8px; padding: 2px 6px; font: inherit; font-size: 12px;
    }

    @media (max-width: 768px) {
      #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-output-btn .${PLUGIN_ID}-word { display: none; }
      #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status { max-width: 46vw; }
      #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status-act { padding: 6px 10px !important; }
      #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-seg button { padding: 5px 10px !important; }
      /* the sliders icon and the level share a line */
      #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-level { flex: 1 1 0; min-width: 240px; }
      #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-level input[type=range] { flex: 1 1 auto; width: auto !important; min-width: 0; }
      /* the phone rule makes ranges 26px tall for the thumb; keep the track a 4px line */
      #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider {
        background: linear-gradient(var(--sx-ui3), var(--sx-ui3)) center / 100% 4px no-repeat !important;
        box-shadow: none !important; border-radius: 0 !important;
      }
      #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider::-webkit-slider-thumb { margin-top: -8px !important; }
      #${PLUGIN_ID}-nofs { padding: 0; align-items: stretch; }
      #${PLUGIN_ID}-nofs .${PLUGIN_ID}-sheet { border-radius: 0; padding: 14px 12px; min-height: 100%; }
      .${PLUGIN_ID}-nf-grid { grid-template-columns: minmax(0, 1fr); }
      .${PLUGIN_ID}-nf-title { font-size: 18px; }
    }

    /* ── 1.46: the quiet bar, the deck, the sheets ───────────────────────
       docs/intiface-ux-2026-10-21.md §5. The bar is one line: the pill, its
       action, a key hint, the gear, Stop. The deck continues the bar under
       the player (it pushes the page down); the editor and the settings are
       raised sheets over a dimmed page; on a phone both are bottom sheets. */
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-row { flex-wrap: nowrap; }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-sp, .${PLUGIN_ID}-pop .${PLUGIN_ID}-sp { flex: 1 1 auto; min-width: 0; }
    #${PLUGIN_ID}-toolbar button#${PLUGIN_ID}-status {
      display: inline-flex; align-items: center; gap: 8px; flex: 0 1 auto; min-width: 0; max-width: min(560px, 100%);
      height: 30px; padding: 0 10px 0 9px !important; border-radius: 8px; cursor: pointer; overflow: hidden;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k))); color: var(--sx-tx); font-size: 12.5px; white-space: nowrap;
    }
    #${PLUGIN_ID}-toolbar button#${PLUGIN_ID}-status:hover { color: var(--sx-hi); border-color: rgba(var(--is-ma-rgb),0.45); }
    #${PLUGIN_ID}-toolbar button#${PLUGIN_ID}-status:focus-visible { outline: 2px solid var(--sx-ma); outline-offset: 1px; }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-mode { color: var(--sx-hi); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-sep { color: var(--sx-tx3); flex: none; }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-q { color: var(--sx-tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-meter {
      width: 56px; height: 6px; flex: none; border-radius: 3px; background: var(--sx-ui); overflow: hidden;
      box-shadow: inset 0 1px 2px rgba(0,0,0,calc(0.6*var(--sx-k)));
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-meter i { display: block; height: 100%; background: var(--sx-ma); box-shadow: inset 0 1px 0 rgba(255,255,255,0.2); }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-pct { color: var(--sx-hi); font-variant-numeric: tabular-nums; min-width: 30px; flex: none; }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-ic.is-trail { flex: none; }

    #${PLUGIN_ID}-deck.${PLUGIN_ID}-pop {
      position: relative; left: auto; top: auto; z-index: auto; width: auto; max-height: none; overflow: visible;
      opacity: 1; pointer-events: auto; transform: none; transition: none; margin: 0;
      display: flex; flex-direction: column; gap: 12px; padding: 12px 14px 14px; font-size: 12.5px;
      border-radius: 0 0 12px 12px; border: 1px solid var(--sx-line); border-top-color: var(--sx-edge);
      background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
      box-shadow: 0 1px 0 rgba(0,0,0,calc(0.7*var(--sx-k))), 0 12px 24px -10px rgba(0,0,0,calc(0.65*var(--sx-k)));
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-muted { color: var(--sx-tx2); font-size: 12px; line-height: 1.4; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-note { color: var(--sx-tx1b); font-size: 13px; line-height: 1.45; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-cap { color: var(--sx-tx2); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .${PLUGIN_ID}-pg-hide { display: none !important; }
    #${PLUGIN_ID}-deck:not(.is-phone) .${PLUGIN_ID}-phone-only { display: none !important; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-desk-only { display: none !important; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg {
      display: inline-flex; gap: 3px; padding: 3px; border-radius: 11px;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
      box-shadow: inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg button {
      --tc: var(--sx-ma);
      display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 13px; border-radius: 8px; cursor: pointer;
      border: 1px solid transparent; background: none; color: var(--sx-tx1b); font: inherit; font-size: 13.5px; white-space: nowrap;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg button[data-mode=script] { --tc: var(--sx-bl); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg button[data-mode=goon] { --tc: var(--sx-cy); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg button:hover { color: var(--sx-hi); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg button.is-sel {
      color: var(--sx-hi); background: var(--sx-ui2); background: color-mix(in srgb, var(--tc) 24%, var(--sx-ui));
      border-color: color-mix(in srgb, var(--tc) 55%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 2px 6px rgba(0,0,0,calc(.4*var(--sx-k)));
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg button .${PLUGIN_ID}-sub { color: var(--sx-tx2); font-size: 12px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg button.is-sel .${PLUGIN_ID}-sub { color: var(--sx-tx1b); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg.${PLUGIN_ID}-sm button { height: 26px; padding: 0 10px; font-size: 12.5px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-seg.${PLUGIN_ID}-sm button.is-sel { --tc: var(--sx-cy); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-ibtn {
      width: 30px; height: 30px; flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 0;
      border-radius: 8px; border: 1px solid transparent; background: none; color: var(--sx-tx2); cursor: pointer;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-ibtn:hover, .${PLUGIN_ID}-pop .${PLUGIN_ID}-ibtn.is-on { color: var(--sx-hi); background: var(--sx-ui2); }
    #${PLUGIN_ID}-deck #${PLUGIN_ID}-output-btn {
      display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3);
    }
    #${PLUGIN_ID}-deck #${PLUGIN_ID}-output-btn.is-live { color: var(--sx-gr-tx); border-color: rgba(var(--is-gr-rgb),0.45); }
    #${PLUGIN_ID}-deck #${PLUGIN_ID}-output-btn.is-muted { color: var(--sx-re-tx); border-color: rgba(var(--is-re-rgb),0.5);
      background: linear-gradient(180deg, rgba(var(--is-re-rgb),0.2), rgba(var(--is-re-rgb),0.1)), var(--sx-ui); }
    #${PLUGIN_ID}-deck #${PLUGIN_ID}-output-btn .${PLUGIN_ID}-ic { width: 13px; height: 13px; }

    /* Strength: one track, the number at the motor, the Max mark on it */
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-str { display: flex; align-items: center; gap: 10px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-str .${PLUGIN_ID}-lab { color: var(--sx-hi); font-weight: 600; font-size: 13px; width: 62px; flex: none; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-step {
      width: 30px; height: 30px; flex: none; border-radius: 8px; padding: 0; cursor: pointer; font: inherit; font-size: 17px; line-height: 1; color: var(--sx-hi);
      background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3);
      box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k)));
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-trk { position: relative; flex: 1 1 auto; min-width: 100px; height: 30px; display: flex; align-items: center; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-trk input[type=range].${PLUGIN_ID}-knob { margin: 0; }
    #${PLUGIN_ID}-dk-trk input[type=range].${PLUGIN_ID}-knob::-webkit-slider-runnable-track {
      height: 6px; border-radius: 3px;
      background: linear-gradient(90deg, var(--sx-ma) var(--fill, 0%), var(--sx-ui3) var(--fill, 0%) var(--max, 100%), rgba(var(--is-re-rgb),0.16) var(--max, 100%));
    }
    #${PLUGIN_ID}-dk-trk input[type=range].${PLUGIN_ID}-knob::-webkit-slider-thumb { width: 16px; height: 16px; margin-top: -5px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-maxmark { position: absolute; top: 7px; bottom: 7px; width: 2px; margin-left: -1px; background: var(--sx-re-tx); border-radius: 1px; pointer-events: none; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-maxlab { position: absolute; top: -9px; transform: translateX(-50%); font-size: 10.5px; color: var(--sx-re-tx); white-space: nowrap; pointer-events: none; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-maxlab.is-right { transform: translateX(-100%); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-str .${PLUGIN_ID}-val { color: var(--sx-hi); font-size: 18px; font-weight: 700; min-width: 58px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-str .${PLUGIN_ID}-val small { font-size: 12px; color: var(--sx-tx2); font-weight: 400; }
    /* 1.50: Goon's Level is the pad's control (stepper, ten dots, the
       number), not ten wide boxes across the deck */
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-lvs { flex: 0 1 240px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-str.is-level .${PLUGIN_ID}-val { text-align: left; margin-right: auto; }

    /* preset cards with a mini waveform; the first four carry Alt+1..4 */
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 8px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc {
      display: flex; flex-direction: column; gap: 5px; min-width: 0; padding: 8px 9px 7px; border-radius: 10px; cursor: pointer; text-align: left;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); color: var(--sx-tx1b); font: inherit;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc:hover { color: var(--sx-hi); border-color: rgba(var(--is-ma-rgb),0.4); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc:focus-visible { outline: 2px solid var(--sx-ma); outline-offset: 1px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc svg { display: block; width: 100%; height: 24px; color: var(--sx-tx2); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc.is-on {
      color: var(--sx-hi); background: var(--sx-ui2); background: color-mix(in srgb, var(--sx-ma) 20%, var(--sx-ui2));
      border-color: color-mix(in srgb, var(--sx-ma) 55%, transparent);
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc.is-on svg { color: var(--sx-ma-tx); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc-nm { display: flex; align-items: center; gap: 6px; font-size: 13px; min-width: 0; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc-nm kbd { margin-left: auto; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc-meta { font-size: 11px; color: var(--sx-tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-pc-add { align-items: center; justify-content: center; border-style: dashed; color: var(--sx-tx2); min-height: 70px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-fav { padding: 6px 10px; border-radius: 9px; background: var(--sx-bg2); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-fav > .${PLUGIN_ID}-ic { color: var(--sx-ye); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn.${PLUGIN_ID}-ghost { background: transparent; border-color: transparent; box-shadow: none; color: var(--sx-tx1b); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn.${PLUGIN_ID}-ghost:hover, .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn.is-on.${PLUGIN_ID}-ghost { color: var(--sx-hi); background: var(--sx-ui2); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn.${PLUGIN_ID}-pri {
      background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,calc(0.08*var(--sx-k)))), var(--sx-ma);
      border-color: var(--sx-line2); border-top-color: var(--sx-ma-tx); color: var(--sx-on); font-weight: 600;
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn:disabled { opacity: .5; cursor: default; }

    /* Fine-tune: three macros, each moving its detailed values together */
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-fine { display: flex; flex-direction: column; gap: 10px; padding-top: 10px; border-top: 1px solid var(--sx-ui2); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macros { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macro {
      display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px; min-width: 0;
      background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macro.is-off { opacity: .6; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macro-hd { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macro-hd b { color: var(--sx-hi); font-size: 13.5px; font-weight: 600; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macro-wd { color: var(--sx-ma-tx); font-size: 12px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macro-ends { display: flex; justify-content: space-between; font-size: 11px; color: var(--sx-tx2); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macro-det { font-size: 12px; color: var(--sx-tx2); line-height: 1.5; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macro-det b { color: var(--sx-tx1b); font-weight: 500; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-macro-det .${PLUGIN_ID}-chips { margin-bottom: 6px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-foot .${PLUGIN_ID}-micro-btn { width: auto; }

    /* Goon in the deck */
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-styles { gap: 6px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-styles .${PLUGIN_ID}-chip.is-sel { background: color-mix(in srgb, var(--sx-cy) 22%, var(--sx-ui2)); border-color: color-mix(in srgb, var(--sx-cy) 50%, transparent); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-styles .${PLUGIN_ID}-sk svg { display: block; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-ggrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 280px); gap: 16px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gleft, .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gright { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gright { gap: 16px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gstat { flex-wrap: nowrap; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gstat .${PLUGIN_ID}-g2-then { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-graph {
      height: 150px; border-radius: 8px; overflow: hidden; background: var(--sx-bg2);
      border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-graph svg { display: block; }
    /* 1.50: the moves as one small segment (the big pad has the big keys) */
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gmoves button { --tc: var(--sx-cy); font-weight: 600; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gmoves button.is-edge { --tc: var(--sx-or); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gmoves button.is-cool { --tc: var(--sx-bl); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gmoves button.is-hold { --tc: var(--sx-ye); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gmoves button::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--tc); flex: none; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gmoves button b { font-weight: 600; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gmoves button.is-active {
      color: var(--sx-hi); background: var(--sx-ui2); background: color-mix(in srgb, var(--tc) 24%, var(--sx-ui));
      border-color: color-mix(in srgb, var(--tc) 55%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-gact { flex-wrap: wrap; row-gap: 8px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-padsum { white-space: nowrap; }
    /* the right column: a heading over each control, one line under it */
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-sec { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-sec > .${PLUGIN_ID}-oneline { align-self: stretch; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-oneline { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-oneline.is-warn { color: var(--sx-ye-tx); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-glearn { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; min-width: 0; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-glearn .${PLUGIN_ID}-oneline-t { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-dk-sec .${PLUGIN_ID}-select { max-width: 100%; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-stepper { display: inline-flex; align-items: center; gap: 8px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-stepper b { min-width: 18px; text-align: center; color: var(--sx-hi); font-size: 15px; font-variant-numeric: tabular-nums; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-info { display: inline-flex; align-items: center; color: var(--sx-tx2); cursor: help; border-radius: 6px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-info:hover, .${PLUGIN_ID}-pop .${PLUGIN_ID}-info:focus-visible { color: var(--sx-hi); }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-info .${PLUGIN_ID}-ic { width: 14px; height: 14px; }

    /* a phone: the deck is a bottom sheet with pages, every target 44 px */
    #${PLUGIN_ID}-deck.${PLUGIN_ID}-pop.is-phone {
      position: fixed; left: 8px; right: 8px; bottom: calc(60px + env(safe-area-inset-bottom, 0px)); z-index: 10061;
      max-height: 62vh; overflow-y: auto; overscroll-behavior: contain; border-radius: 14px; padding: 10px 12px 12px; gap: 10px;
      box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k)));
    }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-phead { display: flex; align-items: center; gap: 8px; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-phead b { color: var(--sx-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-ibtn { width: 44px; height: 44px; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-seg { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); flex: 1 1 auto; min-width: 0; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-seg button { justify-content: center; height: 40px; padding: 0 6px; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-seg button .${PLUGIN_ID}-sub,
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-seg button .${PLUGIN_ID}-ic,
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-note,
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-str .${PLUGIN_ID}-lab { display: none; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-top { gap: 8px; flex-wrap: nowrap; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-top .${PLUGIN_ID}-sp { display: none; }
    #${PLUGIN_ID}-deck.is-phone #${PLUGIN_ID}-output-btn { height: 46px; flex: none; }
    #${PLUGIN_ID}-deck.is-phone #${PLUGIN_ID}-output-btn .${PLUGIN_ID}-word { display: none; }
    /* Stop stays in view at the sheet's foot, whatever the page shows */
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-wstop {
      position: sticky; bottom: -12px; z-index: 2; margin: 0 -12px -12px; padding: 8px 12px 12px;
      background: var(--sx-ui); border-top: 1px solid var(--sx-ui2);
    }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-step { width: 44px; height: 44px; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-lvs { flex: 1 1 auto; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-lvdots button { height: 44px; max-width: none; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-gmoves { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); flex: 1 1 100%; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-gmoves button { height: 44px; justify-content: center; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    #${PLUGIN_ID}-deck.is-phone[data-page=main] .${PLUGIN_ID}-pc:nth-child(n+5) { display: none; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-pc { min-height: 64px; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-macros { grid-template-columns: minmax(0, 1fr); gap: 8px; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-macro { padding: 8px 10px; gap: 4px; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-fine { border-top: 0; padding-top: 0; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-ggrid { grid-template-columns: minmax(0, 1fr); }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-graph { height: 110px; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-sent.is-plain { display: none; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-sent .${PLUGIN_ID}-note,
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-sent .${PLUGIN_ID}-muted { display: none; }
    #${PLUGIN_ID}-deck.is-phone .${PLUGIN_ID}-dk-sent .${PLUGIN_ID}-btn { flex: 1 1 0; justify-content: center; height: 40px; }
    .${PLUGIN_ID}-pop .${PLUGIN_ID}-btn.${PLUGIN_ID}-wide { flex: 1 1 0; justify-content: center; height: 44px; }
    #${PLUGIN_ID}-deck .${PLUGIN_ID}-stopbtn.${PLUGIN_ID}-stop-wide { width: 100%; justify-content: center; height: 44px; font-size: 14px; }
    .${PLUGIN_ID}-dot[data-tone] { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--sx-tx3); }
    .${PLUGIN_ID}-dot[data-tone=good] { background: var(--sx-gr); }
    .${PLUGIN_ID}-dot[data-tone=warn], .${PLUGIN_ID}-dot[data-tone=note] { background: var(--sx-ye); }
    .${PLUGIN_ID}-dot[data-tone=danger] { background: var(--sx-re); }
    .${PLUGIN_ID}-dot[data-tone=info] { background: var(--sx-bl); }

    /* the sheets: the editor and the settings */
    .${PLUGIN_ID}-pop.${PLUGIN_ID}-modal {
      position: fixed; left: 50%; top: 5vh; z-index: 10066; width: min(560px, calc(100vw - 32px)); max-height: 90vh; overflow-y: auto;
      transform: translate(-50%, 6px); padding: 0 18px 16px; font-size: 12.5px; border-radius: 14px; overscroll-behavior: contain;
    }
    .${PLUGIN_ID}-pop.${PLUGIN_ID}-modal.is-open { transform: translate(-50%, 0); }
    #${PLUGIN_ID}-editor.${PLUGIN_ID}-modal { width: min(700px, calc(100vw - 32px)); }
    .${PLUGIN_ID}-pop.${PLUGIN_ID}-modal.is-side { left: auto; right: 12px; top: 12px; transform: none; width: min(560px, 46vw); max-height: calc(100vh - 24px); }
    #${PLUGIN_ID}-veil { position: fixed; inset: 0; z-index: 10065; background: rgba(var(--is-bg-rgb),0.62); }
    #${PLUGIN_ID}-veil.is-clear { background: transparent; pointer-events: none; }
    .${PLUGIN_ID}-modal-head {
      position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; margin: 0 -18px; padding: 12px 18px 10px;
      background: var(--sx-raise); border-bottom: 1px solid var(--sx-ui2); border-radius: 14px 14px 0 0;
    }
    .${PLUGIN_ID}-modal-head strong { color: var(--sx-hi); font-size: 16px; white-space: nowrap; }
    .${PLUGIN_ID}-modal-sub { color: var(--sx-tx2); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .${PLUGIN_ID}-modal-head .${PLUGIN_ID}-sp { flex: 1 1 auto; }
    .${PLUGIN_ID}-modal-x {
      width: 30px; height: 30px; flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer;
      border-radius: 8px; border: 1px solid transparent; background: none; color: var(--sx-tx2);
    }
    .${PLUGIN_ID}-modal-x:hover { color: var(--sx-hi); background: var(--sx-ui2); }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-section.${PLUGIN_ID}-first { margin-top: 10px; border-top: 0; padding-top: 0; }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-cards3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-knobgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 20px; }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-knobgrid > .${PLUGIN_ID}-sec-title, .${PLUGIN_ID}-modal .${PLUGIN_ID}-knobgrid > .${PLUGIN_ID}-micro-row { grid-column: 1 / -1; }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-knobgrid .${PLUGIN_ID}-field { margin-bottom: 8px; }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-stat {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 7px 10px; margin-bottom: 6px; border-radius: 9px;
      background: var(--sx-bg2); font-size: 13px;
    }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-stat b { color: var(--sx-hi); font-weight: 600; }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-stat .${PLUGIN_ID}-r { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-btns { align-items: center; }
    .${PLUGIN_ID}-modal .${PLUGIN_ID}-keygrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; font-size: 12.5px; color: var(--sx-tx1b); }
    .${PLUGIN_ID}-modal details.${PLUGIN_ID}-tune summary { cursor: pointer; color: var(--sx-tx); padding: 6px 0; font-size: 12.5px; }
    .${PLUGIN_ID}-modal details.${PLUGIN_ID}-tune summary:hover { color: var(--sx-hi); }
    .${PLUGIN_ID}-modal #${PLUGIN_ID}-dock.${PLUGIN_ID}-pop { max-height: none; border-radius: 9px; margin-top: 6px; box-shadow: none; border: 1px solid var(--sx-ui2); }
    .${PLUGIN_ID}-modal #${PLUGIN_ID}-handy-panel { border-top: 0; margin-top: 6px; }
    @media (max-width: 640px) {
      #${PLUGIN_ID}-toolbar button#${PLUGIN_ID}-status { flex: 1 1 auto; height: 44px; max-width: none; }
      #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-meter, #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-extra { display: none; }
      #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-mode { flex: none; }
      #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status .${PLUGIN_ID}-pct { margin-left: auto; text-align: right; }
      #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-gear, #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-sp { display: none !important; }
      #${PLUGIN_ID}-toolbar button.${PLUGIN_ID}-stopbtn { height: 44px; padding: 0 16px !important; font-size: 14px; }
      .${PLUGIN_ID}-pop.${PLUGIN_ID}-modal, .${PLUGIN_ID}-pop.${PLUGIN_ID}-modal.is-side, #${PLUGIN_ID}-editor.${PLUGIN_ID}-modal {
        left: 8px; right: 8px; top: auto; bottom: calc(60px + env(safe-area-inset-bottom, 0px)); width: auto; transform: none !important; max-height: 78vh;
      }
      .${PLUGIN_ID}-modal .${PLUGIN_ID}-knobgrid, .${PLUGIN_ID}-modal .${PLUGIN_ID}-keygrid { grid-template-columns: minmax(0, 1fr); }
    }

    @media (prefers-reduced-motion: reduce) {
      .${PLUGIN_ID}-pop { transition: none; }
      #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-status.is-playing .${PLUGIN_ID}-dot,
      .${PLUGIN_ID}-nf-load i { animation: none; }
    }
    @media (max-width: 520px) {
      .${PLUGIN_ID}-modal .${PLUGIN_ID}-cards { grid-template-columns: 1fr 1fr; }
    }
`;
  document.head.appendChild(st);
}

  // ── Toolbar components ─────────────────────────────────────────────────────
  // ── Signal preview (debug scope) ───────────────────────────────────────────
  function buildPreview() {
    const wrap = document.createElement("div");
    wrap.id = `${PLUGIN_ID}-preview-wrap`;
    wrap.style.cssText = "display:none;width:100%;padding-top:6px;";

    const cv = document.createElement("canvas");
    cv.id = `${PLUGIN_ID}-preview`;
    cv.style.cssText = "width:100%;height:80px;display:block;background:var(--sx-bg);" +
                       "border:1px solid var(--sx-deep);border-bottom-color:var(--sx-ui2);border-radius:3px;" +
                       "box-shadow:inset 0 2px 5px rgba(0,0,0,calc(0.5*var(--sx-k)));";
    wrap.appendChild(cv);
    previewCanvas = cv;

    const legend = document.createElement("div");
    legend.id = `${PLUGIN_ID}-preview-legend`;
    legend.style.cssText = "font-size:11px;opacity:0.7;padding-top:2px;" +
                           "display:flex;gap:12px;flex-wrap:wrap;";
    legend.innerHTML =
      '<span style="color:var(--sx-tx2)">\u2014 script</span>' +
      '<span style="color:var(--sx-pu)">- - flow plan</span>' +
      '<span style="color:var(--sx-bl)">\u2014 target</span>' +
      '<span style="color:var(--sx-gr-tx)">\u25AE level sent</span>' +
      '<span style="color:var(--sx-or)">| command</span>' +
      `<span id="${PLUGIN_ID}-preview-stats"></span>`;
    wrap.appendChild(legend);
    return wrap;
  }

  function drawPreview() {
    previewRaf = null;
    const cv = previewCanvas;
    if (!previewOn || !cv || !cv.isConnected) return;

    const dpr = window.devicePixelRatio || 1;
    const w   = Math.max(1, Math.round(cv.clientWidth  * dpr));
    const h   = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    const g = cv.getContext("2d");
    g.clearRect(0, 0, w, h);
    const vt = vidTokens();

    const pts = previewSamples;
    // The backend stamps samples with its own monotonic clock, so anchor the
    // window to the newest sample rather than to Date.now().
    const tEnd = pts.length ? pts[pts.length - 1].t : 0;
    const tSta = tEnd - PREVIEW_WINDOW_MS;
    const X = (t) => ((t - tSta) / PREVIEW_WINDOW_MS) * w;
    const Y = (v) => h - v * (h - 2 * dpr) - dpr;

    // gridlines at 25/50/75/100%
    g.strokeStyle = vt.ui; g.lineWidth = dpr;
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      g.beginPath(); g.moveTo(0, Y(frac)); g.lineTo(w, Y(frac)); g.stroke();
    }
    // motor floor: below this a steady level is impossible without micro pulsing
    if (scalarStep > 0) {
      g.strokeStyle = cRgba(vt.ye, 0.35); g.setLineDash([4 * dpr, 4 * dpr]);
      g.beginPath(); g.moveTo(0, Y(scalarStep)); g.lineTo(w, Y(scalarStep)); g.stroke();
      g.setLineDash([]);
    }

    // ── Funscript, drawn first so the output sits on top of it ──────────────
    // Samples carry both the backend clock (t) and media time (m), which gives
    // the mapping from script position to screen. Anchor on the newest sample
    // that has a media stamp; at playbackRate 1 one media ms is one wall ms.
    let anchor = null;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i].m !== null && pts[i].m !== undefined) { anchor = pts[i]; break; }
    }
    if (previewScript && anchor && previewScript.pts?.length > 1) {
      const rate = (statusData && statusData.rate) || 1;
      const mediaToX = (mediaMs) => X(anchor.t + (mediaMs - anchor.m) / rate);

      // Position track occupies the full height; it is a separate quantity
      // from intensity, so it gets its own faint styling rather than sharing
      // the 0-1 axis visually.
      g.strokeStyle = cRgba(vt.tx2, 0.7);
      g.lineWidth = dpr;
      g.beginPath();
      previewScript.pts.forEach(([at, pos], i) => {
        const x = mediaToX(at);
        const y = Y(pos / 100);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.stroke();

      // Flow: the rendered intensity the toy is following, including what
      // is coming next. Drawn before the live traces so they sit on top.
      if (previewScript.flow?.length > 1) {
        g.strokeStyle = cRgba(vt.pu, 0.85);
        g.lineWidth = 1.2 * dpr;
        g.setLineDash([5 * dpr, 3 * dpr]);
        g.beginPath();
        previewScript.flow.forEach(([at, lv], i) => {
          const x = mediaToX(at), y = Y(lv);
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        });
        g.stroke();
        g.setLineDash([]);
      }

      // Beat markers: where beat mode will actually fire.
      if (previewScript.beats?.length) {
        g.strokeStyle = cRgba(vt.tx2, 0.35);
        for (const at of previewScript.beats) {
          const x = mediaToX(at);
          if (x < -10 || x > w + 10) continue;
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
        }
      }

      // Playhead: where the script is being read right now.
      const px = mediaToX(anchor.m);
      g.strokeStyle = "rgba(255,255,255,0.28)";
      g.setLineDash([3 * dpr, 3 * dpr]);
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
      g.setLineDash([]);
    }

    if (pts.length > 1) {
      // level actually sent, as a step-held fill (that is how the toy sees it)
      g.fillStyle = cRgba(vt["gr-tx"], 0.35);
      g.beginPath(); g.moveTo(X(pts[0].t), Y(0));
      let prev = pts[0];
      for (const p of pts) {
        g.lineTo(X(p.t), Y(prev.lv));
        g.lineTo(X(p.t), Y(p.lv));
        prev = p;
      }
      g.lineTo(X(prev.t), Y(0));
      g.closePath(); g.fill();

      // target, before smoothing and quantisation
      g.strokeStyle = vt.bl; g.lineWidth = 1.2 * dpr;
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.tg)) : g.moveTo(X(p.t), Y(p.tg))));
      g.stroke();

      // tick per actual BLE command
      g.strokeStyle = cRgba(vt.or, 0.85); g.lineWidth = dpr;
      let sent = 0;
      for (const p of pts) {
        if (!p.s) continue;
        sent++;
        const x = X(p.t);
        g.beginPath(); g.moveTo(x, h); g.lineTo(x, h - 6 * dpr); g.stroke();
      }
      previewSentCount = sent;
    }

    const stats = byId(`${PLUGIN_ID}-preview-stats`);
    if (stats) {
      const secs = PREVIEW_WINDOW_MS / 1000;
      const rate = (previewSentCount / secs).toFixed(1);
      const last = pts.length ? pts[pts.length - 1] : null;
      const drift = statusData && typeof statusData.driftMs === "number" ? statusData.driftMs : 0;
      stats.textContent =
        `${rate} cmd/s · now ${last ? (last.lv * 100).toFixed(0) : 0}% · ` +
        `drift ${drift > 0 ? "+" : ""}${drift}ms · ${secs}s window`;
      stats.style.color = Math.abs(drift) > 150 ? "var(--sx-ye)" : "";
    }
    previewRaf = requestAnimationFrame(drawPreview);
  }

  function setPreview(on) {
    previewOn = !!on;
    previewSamples = [];
    previewScript  = null;
    const wrap = byId(`${PLUGIN_ID}-preview-wrap`);
    if (wrap) wrap.style.display = previewOn ? "block" : "none";
    sendMsg({ type: "preview", enabled: previewOn });
    if (previewOn) {
      if (!previewRaf) previewRaf = requestAnimationFrame(drawPreview);
    } else if (previewRaf) {
      cancelAnimationFrame(previewRaf); previewRaf = null;
    }
    log(`Signal preview: ${previewOn ? "on" : "off"}`);
  }

  // ── Handy WiFi Panel ───────────────────────────────────────────────────────
  // ── Manual mode ────────────────────────────────────────────────────────────
  // The toolbar shows only what you touch mid-scene: on/off, intensity, and
  // which pattern is running. Everything that shapes the pattern lives in a
  // popover, because those are set-once values and having eight unlabelled
  // number boxes in the player chrome made the whole bar unreadable.

  // Plain-language description of each pattern, shown on its card and echoed
  // in the popover header so the selected one is never ambiguous.
  const MANUAL_SHAPES = [
    ["constant", "Steady",  "One level, held. No movement."],
    ["wave",     "Wave",    "Rises and falls smoothly, over and over."],
    ["pulse",    "Pulse",   "A short buzz at a regular beat, silence between."],
    ["ramp",     "Ramp",    "Climbs to the top, drops, climbs again."],
    ["tease",    "Tease",   "Buzzes that start short and grow longer."],
    ["random",   "Random",  "Unpredictable level, changing on its own."],
    // 1.49
    ["tidal",    "Tidal",   "Phrases of buzzes that swell and ebb, accents, holds, long silences."],
  ];
  const shapeLabel = (v) => (MANUAL_SHAPES.find((x) => x[0] === v) || ["", v, ""])[1];
  const shapeBlurb = (v) => (MANUAL_SHAPES.find((x) => x[0] === v) || ["", "", ""])[2];

  // ── Pattern popover ────────────────────────────────────────────────────────
  let manualPop = null;

  // ── Pattern maths, mirrored from the backend ──────────────────────────────
  // FunscriptPlayer._manual_shape_value() in IntifaceSync.py is the truth;
  // this copy only draws pictures. Keep the two in step if a shape changes,
  // or the preview will show a pattern the toy does not play.
  const MIN_ON_S = 0.06;          // MANUAL_MIN_ON_MS

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 1.47: the line under Dip to when the low point is still vibration. Wave
  // and Ramp fall to depth x the peak and Random never under it (at least
  // 5% of the peak); at or above the motor's lowest step (5% on a Gush 2)
  // that is felt, so between peaks it never goes quiet. Tease and Pulse do
  // not use Dip to: they are silent between buzzes whatever it says. o:
  // { shape, depth (%), ceiling (the Power limit, %), level (Strength's
  // share, %), step (the motor's lowest step, %) }. Pure.
  function depthWarning(o) {
    if (!o || !["wave", "ramp", "random"].includes(o.shape)) return "";
    const step = Number(o.step) > 0 ? Number(o.step) : 5;
    const share = o.shape === "random" ? Math.max(5, Number(o.depth) || 0) : Number(o.depth) || 0;
    const lowMax = (Number(o.ceiling) || 0) * share / 100;
    if (lowMax < step) return "";
    const now = Math.round(lowMax * clampN(Number(o.level) || 0, 0, 100) / 100);
    const n = now >= 1 ? now : Math.round(lowMax);
    return o.shape === "random"
      ? `Between changes it keeps vibrating at ${n}% or more; Random never goes quiet. Tease or Pulse have silence between buzzes.`
      : `Between peaks it keeps vibrating at ${n}%; set Dip to 0 for silence.`;
  }
  // How much time a picture of this pattern should cover to show what it does.
  function patternWindowS(p) {
    if (p.shape === "constant") return 10;
    if (p.shape === "tidal") return TIDAL.breathS;        // 1.49: one whole breath
    if (p.shape === "tease" && (p.build > 0 || p.buildAmp > 0)) {
      return p.period * Math.min(Math.max(p.build, p.buildAmp) + 2, 16);
    }
    return p.period * 3;
  }

  // Waveform value 0-1 at each of n points across `seconds`, before intensity.
  function patternSamples(p, seconds, n) {
    // 1.49: Tidal from the page's model of the backend's train (a fixed seed)
    if (p.shape === "tidal") {
      const tr = g2Train(tidalWire(p, 7), 0, seconds, 7);
      const out = [];
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1)) * seconds, b = tr.find((x) => t >= x.a && t < x.a + x.len);
        out.push(b ? b.v : 0);
      }
      return out;
    }
    const period = Math.max(0.2, p.period);
    const depth  = Math.max(0, Math.min(0.95, p.depth / 100));
    const on_s   = Math.min(Math.max(MIN_ON_S, p.onMs / 1000), period * 0.95);
    const rnd    = mulberry32(7);
    let randVal = 0, randNext = 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * seconds;
      const phase_s = t % period;
      const phase   = phase_s / period;
      let v = 1;
      switch (p.shape) {
        case "wave":  v = depth + (1 - depth) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase)); break;
        case "pulse": v = phase_s < on_s ? 1 : 0; break;
        case "ramp":  v = depth + (1 - depth) * phase; break;
        case "tease": {
          let this_on = on_s;
          if (p.build > 0) {
            const frac = Math.min(1, Math.floor(t / period) / p.build);
            const from = Math.max(MIN_ON_S, Math.min(on_s, (p.onFromMs ?? 60) / 1000));
            this_on = from + (on_s - from) * frac;
          }
          v = phase_s < this_on ? 1 : 0;
          if (v && p.buildAmp > 0) {
            const a0 = Math.max(0, Math.min(1, p.ampFrom / 100));
            v = a0 + (1 - a0) * Math.min(1, Math.floor(t / period) / p.buildAmp);
          }
          break;
        }
        case "random":
          if (t >= randNext) {
            randVal  = Math.max(0.05, depth) + rnd() * (1 - Math.max(0.05, depth));
            randNext = t + period * (0.5 + rnd());
          }
          v = randVal;
          break;
        default: v = 1;
      }
      out.push(v);
    }
    return out;
  }

  // Small inline sparkline for pattern cards and preset chips.
  function patternIconSvg(p, w = 46, h = 14) {
    const secs = p.shape === "tease" && (p.build > 0 || p.buildAmp > 0) ? p.period * 4
               : p.shape === "tidal" ? 14
               : p.shape === "constant" ? 1 : p.period * 2;
    const n = 90;
    const vals = patternSamples(p, secs, n);
    const pts = vals.map((v, i) =>
      `${((i / (n - 1)) * w).toFixed(1)},${(h - 1 - v * (h - 3)).toFixed(1)}`).join(" ");
    return `<svg class="${PLUGIN_ID}-icon" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
           `aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" ` +
           `stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  }

  function fmtSecs(s) {
    if (s < 1)   return `${(Math.round(s * 100) / 100).toFixed(2).replace(/0$/, "")} s`;
    if (s < 10)  return `${(Math.round(s * 10) / 10)} s`;
    if (s < 60)  return `${Math.round(s)} s`;
    const m = Math.floor(s / 60), r = Math.round(s - m * 60);
    return r ? `${m} min ${r} s` : `${m} min`;
  }

  // The numbers, said the way a person would say them.
  function patternSummary(p) {
    const peak  = (manualLevel / 100) * (p.ceiling / 100);
    const pk    = `${Math.round(peak * 100)}%`;
    const low   = `${Math.round(peak * (p.depth / 100) * 100)}%`;
    const per   = fmtSecs(p.period);
    const on    = fmtSecs(Math.min(Math.max(MIN_ON_S, p.onMs / 1000), p.period * 0.95));
    switch (p.shape) {
      case "constant": return `Holds a steady ${pk}.`;
      case "wave":     return `Swells from ${low} up to ${pk} and back down, every ${per}.`;
      case "pulse": {
        const duty = Math.round(Math.min(p.onMs / 1000, p.period * 0.95) / p.period * 100);
        return `A ${on} buzz at ${pk} every ${per}, silent in between (on ${duty}% of the time).`;
      }
      case "ramp":     return `Climbs from ${low} to ${pk} over ${per}, then drops back and climbs again.`;
      case "tease": {
        const start = `${Math.round(peak * p.ampFrom)}%`;
        const from = Math.max(MIN_ON_S, Math.min(p.onMs / 1000, (p.onFromMs ?? 60) / 1000));
        const len = p.build > 0
          ? ` Buzzes grow from ${fmtSecs(from)} to ${on} long over ${p.build} buzzes (${fmtSecs(p.build * p.period)}).`
          : "";
        const str = p.buildAmp > 0
          ? ` Strength climbs from ${start} to ${pk} over ${p.buildAmp} buzzes (${fmtSecs(p.buildAmp * p.period)}).`
          : "";
        if (!len && !str) return `One ${on} buzz at ${pk} every ${per}, silence the rest of the time.`;
        return `One buzz every ${per}.${len}${str} Then it holds there.`;
      }
      case "random":   return `Jumps to a new level between ${low} and ${pk} roughly every ${per}.`;
      case "tidal": {     // 1.49
        const w = tidalWire(p, 1);
        return `Phrases of ${TIDAL.phraseMin} to ${TIDAL.phraseMax} buzzes, ${fmtSecs(w.onFromMs / 1000)} to ${fmtSecs(w.onMs / 1000)} long, up to ${pk}, ` +
               `about one phrase every ${per}: closer, longer and a little stronger towards high tide, sparse at low tide (a ${TIDAL.breathS} s breath). ` +
               `Accents at full strength, now and then a 0.8-1.2 s hold or a 6-12 s silence. Silent between every buzz.`;
      }
      default:         return "";
    }
  }

  let patternCanvas = null;

  function drawPatternPreview() {
    const cv = patternCanvas;
    if (!cv || !cv.isConnected || !manualPop?.classList.contains("is-open")) return;
    const p   = currentPattern();
    const dpr = window.devicePixelRatio || 1;
    const w   = Math.max(1, Math.round(cv.clientWidth * dpr));
    const h   = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext("2d");
    g.clearRect(0, 0, w, h);

    const axisH = 14 * dpr;                        // room for time labels
    const top   = 6 * dpr;
    const plotH = h - axisH - top;
    const Y = (v) => top + plotH - v * plotH;      // v is motor output 0-1
    const secs = patternWindowS(p);
    const n    = Math.max(120, Math.min(1200, Math.round(w / dpr * 2)));
    const peak = (manualLevel / 100) * (p.ceiling / 100);
    const vals = patternSamples(p, secs, n).map((v) => v * peak);
    const X = (i) => (i / (n - 1)) * w;
    const t = THEME.t;

    // 100% line and the motor floor
    g.lineWidth = dpr;
    g.strokeStyle = "rgba(255,255,255,0.07)";
    g.beginPath(); g.moveTo(0, Y(1)); g.lineTo(w, Y(1)); g.stroke();
    const silent = !vibeSubstep && peak > 0 && peak < scalarStep;
    if (scalarStep > 0) {
      g.strokeStyle = cRgba(t.ye, 0.5);
      g.setLineDash([4 * dpr, 4 * dpr]);
      g.beginPath(); g.moveTo(0, Y(scalarStep)); g.lineTo(w, Y(scalarStep)); g.stroke();
      g.setLineDash([]);
    }

    // the pattern, filled so on/off shapes read as blocks
    const col = THEME.parse(silent ? t.re : t.ma).slice(0, 3).join(",");
    const grad = g.createLinearGradient(0, Y(1), 0, Y(0));
    grad.addColorStop(0, `rgba(${col},0.45)`);
    grad.addColorStop(1, `rgba(${col},0.06)`);
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(0, Y(0));
    vals.forEach((v, i) => g.lineTo(X(i), Y(v)));
    g.lineTo(w, Y(0)); g.closePath(); g.fill();
    g.strokeStyle = `rgb(${col})`; g.lineWidth = 1.5 * dpr;
    g.beginPath();
    vals.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
    g.stroke();

    // time axis: a handful of round-number ticks
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const tick  = steps.find((s) => secs / s <= 6) || 600;
    g.fillStyle = cRgba(t.tx, 0.55);
    g.font = `${10 * dpr}px -apple-system, "Segoe UI", sans-serif`;
    g.textBaseline = "bottom";
    for (let t = 0; t <= secs + 1e-6; t += tick) {
      const x = (t / secs) * w;
      g.fillRect(Math.round(x), h - axisH, dpr, 3 * dpr);
      const lbl = t === 0 ? "0" : fmtSecs(t);
      const tw  = g.measureText(lbl).width;
      g.fillText(lbl, Math.min(Math.max(0, x - tw / 2), w - tw), h);
    }

    // labels on the right edge
    g.textBaseline = "middle";
    const label = (txt, v, color) => {
      const tw = g.measureText(txt).width;
      g.fillStyle = cRgba(t.bg2, 0.85);
      g.fillRect(w - tw - 8 * dpr, Y(v) - 7 * dpr, tw + 6 * dpr, 13 * dpr);
      g.fillStyle = color;
      g.fillText(txt, w - tw - 5 * dpr, Y(v));
    };
    if (peak > 0) label(`peak ${Math.round(peak * 100)}%`, Math.max(peak, 0.12), `rgb(${col})`);
    if (scalarStep > 0 && Math.abs(peak - scalarStep) > 0.1) {
      label(`motor floor ${Math.round(scalarStep * 100)}%`, scalarStep, cRgba(t.ye, 0.9));
    }

    const sum = byId(`${PLUGIN_ID}-pattern-summary`);
    if (sum) {
      sum.textContent = peak <= 0 ? "Intensity is at 0%, so nothing plays."
        : patternSummary(p) + (silent ? " The peak is under the motor's floor, so turn Micro pulsing on or it stays silent." : "");
    }
  }

  // ── Knobs ─────────────────────────────────────────────────────────────────
  // A slider for feel, a number box for precision, and a sentence saying what
  // the number does. Wide ranges (half a second to a minute) are logarithmic,
  // or everything useful would sit in the first few pixels of the track.
  const knobs = [];

  // o.prefix / o.registry / o.onCommit let the script panel reuse this; the
  // defaults are the pattern panel's. o.words(v) adds a live readout in words.
  function knobRow(id, label, help, o, get, set) {
    const pre = `${PLUGIN_ID}-${o.prefix || "manual"}-${id}`;
    const row = document.createElement("div");
    row.id = `${pre}-box`;
    row.className = `${PLUGIN_ID}-field`;

    const head = document.createElement("div");
    head.className = `${PLUGIN_ID}-field-head`;
    const lab = document.createElement("label");
    lab.textContent = label;
    lab.setAttribute("for", pre);
    head.appendChild(lab);
    const words = document.createElement("span");
    words.className = `${PLUGIN_ID}-field-words`;
    if (o.words) head.appendChild(words);

    const ctl = document.createElement("div");
    ctl.className = `${PLUGIN_ID}-field-ctl`;
    const inp = document.createElement("input");
    inp.id   = pre;
    inp.type = "number";
    inp.step = String(o.inputStep);
    ctl.appendChild(inp);
    const unit = document.createElement("span");
    unit.className = `${PLUGIN_ID}-unit`;
    unit.textContent = o.unit;
    ctl.appendChild(unit);
    head.appendChild(ctl);
    row.appendChild(head);

    const sld = document.createElement("input");
    sld.type = "range"; sld.min = "0"; sld.max = "1000"; sld.step = "1";
    sld.className = `${PLUGIN_ID}-knob`;
    sld.setAttribute("aria-label", label);
    row.appendChild(sld);

    const hint = document.createElement("div");
    hint.className = `${PLUGIN_ID}-field-help`;
    hint.textContent = help;
    row.appendChild(hint);

    const { min, max } = o;
    const toPos = (v) => {
      const f = o.curve === "log" ? Math.log(v / min) / Math.log(max / min)
              : o.curve === "sq"  ? Math.sqrt((v - min) / (max - min))
              : (v - min) / (max - min);
      return Math.round(Math.max(0, Math.min(1, f)) * 1000);
    };
    const fromPos = (pos) => {
      const f = pos / 1000;
      return o.curve === "log" ? min * Math.pow(max / min, f)
           : o.curve === "sq"  ? min + (max - min) * f * f
           : min + (max - min) * f;
    };
    const show = o.show || ((v) => v);
    const parse = o.parse || ((v) => v);

    function refresh() {
      const v = get();
      if (document.activeElement !== inp) inp.value = String(show(v));
      const pos = toPos(v);
      if (document.activeElement !== sld) sld.value = String(pos);
      sld.style.setProperty("--fill", `${pos / 10}%`);
      if (o.words) words.textContent = o.words(v);
    }
    function commit(v, final) {
      set(Math.max(min, Math.min(max, v)));
      refresh();
      if (o.onCommit) { o.onCommit(final); return; }
      saveSettingsToStorage();
      updateManualUI();
      if (final) sendManual(); else throttledManual();
    }
    sld.addEventListener("input", () => commit(fromPos(parseInt(sld.value, 10)), false));
    sld.addEventListener("change", () => commit(fromPos(parseInt(sld.value, 10)), true));
    inp.addEventListener("change", () => {
      const v = parseFloat(inp.value);
      if (isNaN(v)) { refresh(); return; }
      commit(parse(v), true);
    });

    (o.registry || knobs).push({ id, refresh });
    refresh();
    return row;
  }

  // ── Preset section (the editor sheet's) ──────────────────────────────────
  // 1.46: the presets themselves are the deck's cards; the editor keeps the
  // name field (Save as new, Rename) and the managing buttons.
  let presetEditMode   = null;    // null | "new" | "rename"
  let presetDeleteArm  = 0;       // timestamp of the first Delete click

  function buildPresetSection() {
    const sec = document.createElement("div");
    sec.className = `${PLUGIN_ID}-section ${PLUGIN_ID}-presets`;
    sec.id = `${PLUGIN_ID}-sec-presets`;
    sec.innerHTML = `
      <div class="${PLUGIN_ID}-sec-title">Preset</div>
      <div class="${PLUGIN_ID}-preset-edit" id="${PLUGIN_ID}-preset-edit">
        <input type="text" id="${PLUGIN_ID}-preset-name" maxlength="${PRESET_NAME_MAX}"
               placeholder="Name, e.g. Slow tease" autocomplete="off">
        <button type="button" data-act="save">Save</button>
        <button type="button" data-act="cancel">Cancel</button>
      </div>
      <div class="${PLUGIN_ID}-preset-bar" id="${PLUGIN_ID}-preset-bar"></div>
      <div class="${PLUGIN_ID}-field-help" id="${PLUGIN_ID}-preset-note"></div>`;

    const edit = sec.querySelector(`#${PLUGIN_ID}-preset-edit`);
    const name = sec.querySelector(`#${PLUGIN_ID}-preset-name`);
    const note = sec.querySelector(`#${PLUGIN_ID}-preset-note`);
    const finish = () => {
      const err = presetEditMode === "rename"
        ? renamePreset(presetStore.active, name.value)
        : savePresetAs(name.value);
      if (err) { note.textContent = err; note.classList.add("is-warn"); return; }
      presetEditMode = null;
      updatePresetUI();
    };
    edit.querySelector('[data-act="save"]').addEventListener("click", finish);
    edit.querySelector('[data-act="cancel"]').addEventListener("click", () => {
      presetEditMode = null; updatePresetUI();
    });
    name.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter")  { ev.preventDefault(); finish(); }
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); presetEditMode = null; updatePresetUI(); }
    });
    name.addEventListener("input", () => {
      const clash = presetEditMode === "new" &&
        presetStore.presets.some((p) => p.name === name.value.trim());
      note.textContent = clash ? "A preset with this name exists. Saving replaces it." : "";
      note.classList.toggle("is-warn", clash);
    });
    return sec;
  }

  // "+ Save as preset" on the deck, and Save as new in the editor: the
  // editor opens with the name field ready.
  function startSaveAs() {
    toggleEditor(true);
    presetEditMode = "new";
    updatePresetUI();
    const name = byId(`${PLUGIN_ID}-preset-name`);
    if (name) { name.value = ""; name.focus(); }
  }

  function updatePresetUI() {
    renderDeckCards();
    updateDeck();
    if (!manualPop) return;
    const act    = activePreset();
    const edited = presetEdited();
    const edit  = manualPop.querySelector(`#${PLUGIN_ID}-preset-edit`);
    const bar   = manualPop.querySelector(`#${PLUGIN_ID}-preset-bar`);
    const note  = manualPop.querySelector(`#${PLUGIN_ID}-preset-note`);
    const name  = manualPop.querySelector(`#${PLUGIN_ID}-preset-name`);
    const sub   = manualPop.querySelector(`#${PLUGIN_ID}-editor-sub`);
    if (sub) sub.textContent = act ? `${act.name}${edited ? " · changed since loaded" : ""}` : `${shapeLabel(manualShape)} · not a preset`;

    edit.style.display = presetEditMode ? "flex" : "none";

    bar.innerHTML = "";
    const mk = (label, title, fn, cls) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.title = title;
      if (cls) b.className = cls;
      b.addEventListener("click", fn);
      bar.appendChild(b);
      return b;
    };
    if (!presetEditMode) {
      if (act) {
        const txt = document.createElement("span");
        txt.className = `${PLUGIN_ID}-preset-state`;
        txt.textContent = edited ? `${act.name}: changed since loaded` : `${act.name}: active, stays on across tabs and visits`;
        bar.appendChild(txt);
        if (edited) {
          mk("Update", `Save these changes into "${act.name}"`, updateActivePreset, "is-on");
          mk("Revert", `Go back to "${act.name}" as saved`, revertActivePreset);
        }
      }
      mk("Save as new", "Save this pattern as a new preset", startSaveAs, act && edited ? "" : "is-on");
      if (act) {
        mk("Rename", "Rename this preset", () => {
          presetEditMode = "rename";
          updatePresetUI();
          name.value = act.name;
          name.focus(); name.select();
        }, `${PLUGIN_ID}-quiet`);
        const armed = Date.now() - presetDeleteArm < 3000;
        const del = mk(armed ? "Click again to delete" : "Delete", `Delete "${act.name}"`, () => {
          if (Date.now() - presetDeleteArm < 3000) {
            presetDeleteArm = 0;
            deletePreset(act.name);
          } else {
            presetDeleteArm = Date.now();
            updatePresetUI();
            setTimeout(updatePresetUI, 3100);
          }
        }, armed ? "is-danger" : "");
        del.classList.add(`${PLUGIN_ID}-quiet`);
        mk("Stop following the preset", "Keep these settings but stop following the preset (Detach)", clearActivePreset,
           `${PLUGIN_ID}-quiet`);
        // its place among the cards: the first four are Alt+1..4
        const i = presetStore.presets.findIndex((p) => p.name === act.name);
        const pos = document.createElement("span");
        pos.className = `${PLUGIN_ID}-preset-state`;
        pos.textContent = `Card ${i + 1} of ${presetStore.presets.length}${i < SLOT_COUNT ? ` (Alt+${i + 1})` : ""}`;
        bar.appendChild(pos);
        const left = mk("Move left", "Earlier among the cards (Shift+Left on a card)", () => moveCard(i, i - 1), `${PLUGIN_ID}-quiet`);
        left.disabled = i <= 0;
        const right = mk("Move right", "Later among the cards (Shift+Right on a card)", () => moveCard(i, i + 1), `${PLUGIN_ID}-quiet`);
        right.disabled = i >= presetStore.presets.length - 1;
      }
    }

    if (!presetEditMode) {
      note.classList.toggle("is-warn", !!presetSyncNote);
      note.textContent = presetSyncNote ||
        (presetStore.presets.length ? "" :
          "No presets yet. Shape a pattern here, then Save as new to use it again later.");
    }
  }

  // ── Edit pattern (1.46): a sheet with every detailed value ────────────────
  // What the 1.45 pattern panel held below its presets: the six shapes, the
  // drawing and its sentence, all the timing values, Power limit and Micro
  // pulse, the preset's buttons and the people in this scene. The deck keeps
  // the everyday part (cards, Strength, Fine-tune). Same element ids as the
  // 1.45 panel, so updateManualUI() and the knobs read it as before.
  function buildEditor() {
    injectStyles();          // it lives on document.body, not inside the toolbar
    const pop = document.createElement("div");
    pop.id = `${PLUGIN_ID}-editor`;
    pop.className = `${PLUGIN_ID}-pop ${PLUGIN_ID}-modal`;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Edit pattern");
    // Belt and braces: if the stylesheet ever fails to apply, these keep the
    // panel out of the document flow instead of dumping it at the end of the
    // page. Everything else about its appearance stays in the stylesheet.
    pop.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
    pop.appendChild(sheetHead("Edit pattern", `${PLUGIN_ID}-editor-sub`, () => toggleEditor(false)));

    // The popover is appended to the body by the caller, so byId() cannot see
    // its children yet. Assign manualPop now for updatePresetUI().
    manualPop = pop;

    // Pattern cards, each with a sketch of its shape
    const pat = document.createElement("div");
    pat.className = `${PLUGIN_ID}-section ${PLUGIN_ID}-first`;
    pat.innerHTML = `<div class="${PLUGIN_ID}-sec-title">Pattern</div>`;
    const grid = document.createElement("div");
    grid.className = `${PLUGIN_ID}-cards ${PLUGIN_ID}-cards3`;
    MANUAL_SHAPES.forEach(([value, label, blurb]) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `${PLUGIN_ID}-card`;
      card.dataset.shape = value;
      const icon = patternIconSvg(cleanPattern({ shape: value, period: 1, onMs: 250,
                                                 depth: 15, build: value === "tease" ? 3 : 0 }));
      card.innerHTML = `<span class="${PLUGIN_ID}-card-top">
                          <span class="${PLUGIN_ID}-card-name">${label}</span>${icon}
                        </span>
                        <span class="${PLUGIN_ID}-card-blurb">${blurb}</span>`;
      card.addEventListener("click", () => {
        // 1.49: Tidal starts from its own timing (a phrase every 6 s, 0.1-0.7 s buzzes)
        if (value === "tidal" && manualShape !== "tidal") {
          manualPeriod = TIDAL.period; manualOnMs = TIDAL.onMs; manualOnFromMs = TIDAL.onFromMs;
        }
        manualShape = value;
        saveSettingsToStorage();
        updateManualUI();
        sendManual();
        log(`Manual pattern: ${value}`, "debug");
      });
      grid.appendChild(card);
    });
    pat.appendChild(grid);

    // Live picture of the current settings, plus the same thing in words
    const pv = document.createElement("div");
    pv.className = `${PLUGIN_ID}-pattern-view`;
    const cv = document.createElement("canvas");
    cv.id = `${PLUGIN_ID}-pattern-canvas`;
    pv.appendChild(cv);
    patternCanvas = cv;
    const sum = document.createElement("div");
    sum.id = `${PLUGIN_ID}-pattern-summary`;
    sum.className = `${PLUGIN_ID}-summary`;
    pv.appendChild(sum);
    pat.appendChild(pv);
    pop.appendChild(pat);

    // Timing, relabelled per pattern by updateManualUI()
    const timing = document.createElement("div");
    timing.className = `${PLUGIN_ID}-section ${PLUGIN_ID}-knobgrid`;
    timing.id = `${PLUGIN_ID}-sec-timing`;
    timing.innerHTML = `<div class="${PLUGIN_ID}-sec-title">Timing</div>`;
    timing.appendChild(knobRow(
      "period", "Cycle length",
      "How long one full cycle takes.",
      { min: 0.5, max: 60, curve: "log", unit: "sec", inputStep: 0.1 },
      () => manualPeriod,
      (v) => { manualPeriod = v < 5 ? Math.round(v * 10) / 10 : Math.round(v * 2) / 2; }
    ));
    timing.appendChild(knobRow(
      "onms", "Buzz length",
      "How long each buzz lasts. Short feels like a tap, long like a throb.",
      { min: 60, max: 10000, curve: "log", unit: "sec", inputStep: 0.05,
        show: (v) => Math.round(v) / 1000, parse: (v) => v * 1000 },
      () => manualOnMs,
      (v) => { manualOnMs = v < 1000 ? Math.round(v / 10) * 10 : Math.round(v / 50) * 50; }
    ));
    const depthRow = knobRow(
      "depth", "Dip to",
      "How low it falls between peaks, as a share of the peak. 0 falls all the way to silence.",
      { min: 0, max: 95, curve: "lin", unit: "%", inputStep: 5 },
      () => manualDepth, (v) => { manualDepth = Math.round(v); }
    );
    // 1.47: say when the dip keeps the toy going between peaks (the user's
    // "constantly vibrating" in Goon came from a wave that never went quiet)
    const depthWarn = document.createElement("div");
    depthWarn.id = `${PLUGIN_ID}-depth-warn`;
    depthWarn.className = `${PLUGIN_ID}-field-help ${PLUGIN_ID}-field-warn`;
    depthWarn.setAttribute("role", "note");
    depthRow.appendChild(depthWarn);
    timing.appendChild(depthRow);
    timing.appendChild(knobRow(
      "onfrom", "Starting buzz length",
      "How long the first buzz is. Each one after it grows a little until it reaches the buzz length above.",
      { min: 60, max: 10000, curve: "log", unit: "sec", inputStep: 0.05,
        show: (v) => Math.round(v) / 1000, parse: (v) => v * 1000 },
      () => manualOnFromMs,
      (v) => { manualOnFromMs = v < 1000 ? Math.round(v / 10) * 10 : Math.round(v / 50) * 50; }
    ));
    timing.appendChild(knobRow(
      "build", "Length build-up",
      "How many buzzes it takes to grow from a flick to the full buzz length. 0 means every buzz is full length.",
      { min: 0, max: 200, curve: "sq", unit: "buzzes", inputStep: 1 },
      () => manualBuild, (v) => { manualBuild = Math.round(v); }
    ));
    timing.appendChild(knobRow(
      "buildamp", "Strength build-up",
      "How many buzzes it takes to grow from the starting strength to full. 0 means every buzz is full strength. Works with or without the length build-up.",
      { min: 0, max: 200, curve: "sq", unit: "buzzes", inputStep: 1 },
      () => manualBuildAmp, (v) => { manualBuildAmp = Math.round(v); }
    ));
    timing.appendChild(knobRow(
      "ampfrom", "Starting strength",
      "How strong the first buzz is, as a share of the peak. Below the motor's floor it is held at the floor rather than going silent.",
      { min: 0, max: 100, curve: "lin", unit: "%", inputStep: 5 },
      () => manualAmpFrom, (v) => { manualAmpFrom = Math.round(v); }
    ));
    pop.appendChild(timing);

    // Output limits
    const limits = document.createElement("div");
    limits.className = `${PLUGIN_ID}-section ${PLUGIN_ID}-knobgrid`;
    limits.innerHTML = `<div class="${PLUGIN_ID}-sec-title">Output limits</div>`;
    limits.appendChild(knobRow(
      "ceiling", "Power limit (Max)",
      "The strongest this pattern may go: the Max mark on Strength. Strength is a share of it, so a preset with a higher Max plays stronger at the same share (it climbs there, never a jump).",
      { min: 1, max: 100, curve: "lin", unit: "%", inputStep: 1 },
      () => manualCeiling, (v) => { manualCeiling = Math.round(v); }
    ));
    const microRow = document.createElement("div");
    microRow.className = `${PLUGIN_ID}-micro-row`;
    microRow.innerHTML = `<label>Below the motor's floor</label>`;
    const microBtn = document.createElement("button");
    microBtn.type = "button";
    microBtn.className = `${PLUGIN_ID}-micro-btn`;
    microBtn.addEventListener("click", toggleMicro);
    microRow.appendChild(microBtn);
    limits.appendChild(microRow);
    limits.appendChild(knobRow(
      "microms", "Micro pulse",
      "Only used below the motor's floor, with Micro pulsing on. Short feels like ticking, long like purring.",
      { min: 40, max: 1000, curve: "log", unit: "ms", inputStep: 10 },
      () => manualMicroMs, (v) => { manualMicroMs = Math.round(v / 10) * 10; }
    ));
    pop.appendChild(limits);

    pop.appendChild(buildPresetSection());

    // Favourite pattern per performer in this scene (1.38). Filled by
    // updateFavUI(); hidden when the scene has nobody in it.
    const favs = document.createElement("div");
    favs.className = `${PLUGIN_ID}-section`;
    favs.id = `${PLUGIN_ID}-sec-favs`;
    favs.innerHTML = `<div class="${PLUGIN_ID}-sec-title">For the people in this scene</div>
      <div id="${PLUGIN_ID}-fav-rows"></div>
      <div class="${PLUGIN_ID}-field-help" id="${PLUGIN_ID}-fav-note"></div>`;
    pop.appendChild(favs);

    updatePresetUI();
    updateMicroButtons();
    return pop;
  }

  function toggleEditor(force) {
    if (!manualPop) {
      if (force === false) return;      // nothing to hide, do not build one
      buildEditor();
    }
    const show = force !== undefined ? !!force : !manualPop.classList.contains("is-open");
    if (show) toggleSettingsPop(false);
    showSheet(manualPop, show);
    if (show) {
      updateMicroButtons();
      updateFavUI();
      updateManualUI();
    } else if (presetEditMode) {
      presetEditMode = null;
    }
  }

  // ── Sheets (1.46): the editor and the settings ─────────────────────────────
  // Centred over a dimmed page (a bottom sheet on a phone), Esc or a click
  // outside closes them, and each has its own Stop: the bar's may be under
  // the veil. With the script's tuning open the settings sheet moves to the
  // side and the page stays usable, so the video can be scrubbed while tuning.
  function sheetHead(title, subId, close) {
    const head = document.createElement("div");
    head.className = `${PLUGIN_ID}-modal-head`;
    head.innerHTML = `<strong>${escHtml(title)}</strong><span class="${PLUGIN_ID}-modal-sub" id="${subId}"></span>
      <span class="${PLUGIN_ID}-sp"></span>`;
    head.appendChild(stopButton(""));
    const x = document.createElement("button");
    x.type = "button";
    x.className = `${PLUGIN_ID}-modal-x`;
    x.innerHTML = ic("x");
    x.setAttribute("aria-label", "Close");
    x.setAttribute("aria-keyshortcuts", "Escape");
    x.title = "Close (Esc)";
    x.addEventListener("click", close);
    head.appendChild(x);
    return head;
  }
  function showSheet(el, show) {
    if (show && el.parentNode !== document.body) document.body.appendChild(el);
    el.classList.toggle("is-open", show);
    el.style.opacity       = show ? "" : "0";
    el.style.pointerEvents = show ? "" : "none";
    syncVeil();
  }
  function sheetOpen() {
    return [manualPop, settingsPop].find((p) => p && p.classList.contains("is-open")) || null;
  }
  function closeSheets() {
    toggleEditor(false);
    toggleSettingsPop(false);
  }
  function syncVeil() {
    const open = sheetOpen();
    let v = document.getElementById(`${PLUGIN_ID}-veil`);
    if (!open) { if (v) v.remove(); return; }
    if (!v) {
      v = document.createElement("div");
      v.id = `${PLUGIN_ID}-veil`;
      v.setAttribute("aria-hidden", "true");
    }
    if (v.nextSibling !== open) document.body.insertBefore(v, open);
    v.classList.toggle("is-clear", open.classList.contains("is-side"));
  }

  // One dismiss handler for both sheets: a press outside the open one (on the
  // veil, mostly) closes it. Not while it sits at the side for tuning: then
  // the page is meant to be used.
  document.addEventListener("pointerdown", (ev) => {
    const open = sheetOpen();
    if (!open || open.contains(ev.target) || open.classList.contains("is-side")) return;
    if (byId(`${PLUGIN_ID}-gear`)?.contains(ev.target)) return;
    closeSheets();
  }, true);
  window.addEventListener("resize", () => updateDeck());

  // ── Per-script memory ──────────────────────────────────────────────────────
  // The right offset and feel depend on the script, not on the user: a FunGen
  // tracker file and a Cock Hero file want different settings, and every file
  // has its own sync. Tuning while a script is loaded is remembered for that
  // script; scripts never tuned use the defaults. Stored like presets (Stash
  // plugin config plus a browser mirror, newer rev wins), keyed by a short
  // hash of the path so the config stays small. Capped at SCRIPT_MAX, oldest
  // dropped first.
  const SCRIPT_STORE_KEY = "IntifaceSync.scriptSettings";
  const SCRIPT_CFG_KEY   = "scriptSettings";
  const SCRIPT_MAX       = 200;
  const SCRIPT_KEYS = ["vibeMode", "flowSmooth", "flowRhythm", "flowGain", "vibeMaxSpeed",
                       "beatMs", "beatEdge", "beatProminence", "offsetMs", "strokeMin",
                       "strokeMax", "vibeTrackOn"];
  let scriptStore    = { v: 1, rev: 0, scripts: {} };
  let scriptDefaults = null;       // the values scripts without memory use
  // Vibe mode the Collections plugin asks for this scene (e.g. Cock Hero ->
  // beat). Applies to scripts with no tuning of their own; never saved into
  // the defaults.
  let collectionVibe = null;
  let scriptSaveTimer = null;

  function pathKey(path) {
    let h = 0x811c9dc5;                                   // FNV-1a, 32 bit
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function readScriptValues() {
    return { vibeMode, flowSmooth, flowRhythm, flowGain, vibeMaxSpeed, beatMs, beatEdge,
             beatProminence, offsetMs, strokeMin, strokeMax, vibeTrackOn };
  }

  function writeScriptValues(o) {
    if (!o) return;
    const n = (v, lo, hi, d) => (typeof v === "number" && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : d;
    if (["auto", "flow", "speed", "position", "beat", "off"].includes(o.vibeMode)) vibeMode = o.vibeMode;
    flowSmooth     = n(o.flowSmooth, 0, 100, flowSmooth);
    flowRhythm     = n(o.flowRhythm, 0, 100, flowRhythm);
    flowGain       = n(o.flowGain, 0.25, 4, flowGain);
    vibeMaxSpeed   = n(o.vibeMaxSpeed, 50, 2000, vibeMaxSpeed);
    beatMs         = n(o.beatMs, 60, 1000, beatMs);
    if (["all", "low", "high"].includes(o.beatEdge)) beatEdge = o.beatEdge;
    beatProminence = n(o.beatProminence, 5, 60, beatProminence);
    offsetMs       = n(o.offsetMs, -2000, 2000, offsetMs);
    strokeMin      = n(o.strokeMin, 0, 95, strokeMin);
    strokeMax      = n(o.strokeMax, 5, 100, strokeMax);
    if (typeof o.vibeTrackOn === "boolean") vibeTrackOn = o.vibeTrackOn;
  }

  function scriptMemory(path) {
    if (!path) return null;
    const m = scriptStore.scripts[pathKey(path)];
    return m && m.path === path ? m : null;
  }

  // A script just became current (loaded, picked, or switched in another tab).
  function applyScriptSettingsFor(path) {
    const base = (path && collectionVibe && scriptDefaults)
      ? { ...scriptDefaults, vibeMode: collectionVibe } : scriptDefaults;
    writeScriptValues(scriptMemory(path) || base);
    sendSettings();
    updateScriptUI();
  }

  // Every script-panel control calls this instead of sendSettings().
  function scriptSettingChanged() {
    if (selectedFunscript) {
      scriptStore.scripts[pathKey(selectedFunscript)] =
        { path: selectedFunscript, ...readScriptValues(), ts: Date.now() };
      const keys = Object.keys(scriptStore.scripts);
      if (keys.length > SCRIPT_MAX) {
        keys.sort((a, b) => (scriptStore.scripts[a].ts || 0) - (scriptStore.scripts[b].ts || 0));
        keys.slice(0, keys.length - SCRIPT_MAX).forEach((k) => delete scriptStore.scripts[k]);
      }
      // Sliders fire on release, but a run of edits should be one write.
      clearTimeout(scriptSaveTimer);
      scriptSaveTimer = setTimeout(persistScripts, 800);
    } else {
      scriptDefaults = readScriptValues();
    }
    sendSettings();
    updateScriptUI();
  }

  function persistScripts() {
    scriptStore.rev = Date.now();
    try { localStorage.setItem(SCRIPT_STORE_KEY, JSON.stringify(scriptStore)); } catch (_) {}
    writeStashKey(SCRIPT_CFG_KEY, scriptStore)
      .catch((e) => log(`Script settings sync to Stash failed: ${e.message}`));
  }

  function forgetScriptTuning() {
    if (!selectedFunscript) return;
    delete scriptStore.scripts[pathKey(selectedFunscript)];
    persistScripts();
    applyScriptSettingsFor(selectedFunscript);
  }

  function makeScriptDefaults() {
    scriptDefaults = readScriptValues();
    saveSettingsToStorage();
    updateScriptUI();
  }

  function parseScriptStore(raw) {
    try {
      const s = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!s || typeof s.scripts !== "object" || !s.scripts) return null;
      return { v: 1, rev: Number(s.rev) || 0, scripts: s.scripts };
    } catch (_) { return null; }
  }

  async function loadScriptStore() {
    let local = null;
    try { local = parseScriptStore(localStorage.getItem(SCRIPT_STORE_KEY)); } catch (_) {}
    let remote = null;
    try { remote = parseScriptStore((await loadPluginData())?.[SCRIPT_CFG_KEY]); } catch (_) {}
    const best = [local, remote].filter(Boolean).sort((a, b) => b.rev - a.rev)[0];
    if (best) scriptStore = best;
    if (local && (!remote || local.rev > remote.rev)) {
      writeStashKey(SCRIPT_CFG_KEY, scriptStore).catch(() => {});
    }
    if (best && best !== local) {
      try { localStorage.setItem(SCRIPT_STORE_KEY, JSON.stringify(scriptStore)); } catch (_) {}
    }
    if (selectedFunscript) applyScriptSettingsFor(selectedFunscript);
  }

  window.addEventListener("storage", (ev) => {
    if (ev.key !== SCRIPT_STORE_KEY) return;
    const s = parseScriptStore(ev.newValue);
    if (!s || s.rev <= scriptStore.rev) return;
    const before = JSON.stringify(scriptMemory(selectedFunscript));
    scriptStore = s;
    if (JSON.stringify(scriptMemory(selectedFunscript)) !== before) {
      applyScriptSettingsFor(selectedFunscript);
    }
  });

  // ── Script dock ────────────────────────────────────────────────────────────
  // Everything about how the funscript drives the toy, docked under the
  // player and toggled from the script name. 1.26 made this a popover, which
  // closed as soon as you clicked the timeline, and tuning a script means
  // scrubbing while you change things. So it sits below the toolbar, laid out
  // horizontally, stays open across scenes, and only the script button (or its
  // own close button) closes it.
  const SCRIPT_MODES = [
    ["auto",     "Auto",     "Flow, or Beat for music-synced scripts. Start here."],
    ["flow",     "Flow",     "Follows how busy the scene is. Best for most scripts."],
    ["beat",     "Beat",     "A burst on every stroke. For Cock Hero style scripts."],
    ["speed",    "Speed",    "Classic: faster strokes buzz harder."],
    ["position", "Position", "Follows the stroke: the top is strongest."],
    ["off",      "Off",      "The script does not drive the vibrator."],
  ];
  let scriptPop = null;
  const scriptKnobs = [];
  let overviewCanvas = null;
  let overviewTimer  = null;

  function effectiveScriptMode() {
    if (vibeMode !== "auto") return vibeMode;
    return (isOwner && statusData && statusData.vibeEffective) || "flow";
  }

  function scriptKnob(id, label, help, o, get, set) {
    return knobRow(id, label, help,
      { ...o, prefix: "script", registry: scriptKnobs,
        onCommit: (final) => { if (final) scriptSettingChanged(); else updateScriptUI(); } },
      get, set);
  }

  function buildScriptPanel() {
    injectStyles();
    const pop = document.createElement("div");
    pop.id = `${PLUGIN_ID}-dock`;
    // .pop supplies the content styling shared with the pattern panel; the
    // #IntifaceSync-dock rules undo its floating-window parts.
    pop.className = `${PLUGIN_ID}-pop ${PLUGIN_ID}-dock`;
    pop.addEventListener("pointerdown", () => tryTakeover("toolbar"), true);
    scriptPop = pop;

    pop.innerHTML = `
      <div class="${PLUGIN_ID}-dock-head">
        <strong id="${PLUGIN_ID}-sp-title">Script</strong>
        <div class="${PLUGIN_ID}-memory" id="${PLUGIN_ID}-sp-memory"></div>
        <button type="button" id="${PLUGIN_ID}-sp-scope-btn"
                title="Draw what is being sent to the toy, under these settings"></button>
        <button type="button" id="${PLUGIN_ID}-sp-close" title="Hide script settings" aria-label="Hide script settings">${ic("x")}</button>
      </div>
      <div class="${PLUGIN_ID}-overview" id="${PLUGIN_ID}-sp-overview">
        <canvas id="${PLUGIN_ID}-overview-canvas"></canvas>
        <div class="${PLUGIN_ID}-field-help">Scene intensity as Flow sees it. Click to jump there.</div>
      </div>
      <div class="${PLUGIN_ID}-dock-grid">
        <div class="${PLUGIN_ID}-dock-col">
          <div class="${PLUGIN_ID}-sp-pick" id="${PLUGIN_ID}-script-pick">
            <label for="${PLUGIN_ID}-select">Script file</label>
          </div>
          <div id="${PLUGIN_ID}-sp-track"></div>
          <div class="${PLUGIN_ID}-sec-title">Mode</div>
          <div class="${PLUGIN_ID}-cards ${PLUGIN_ID}-modes" id="${PLUGIN_ID}-sp-modes"></div>
        </div>
        <div class="${PLUGIN_ID}-dock-col" id="${PLUGIN_ID}-sp-feel">
          <div class="${PLUGIN_ID}-sec-title">Feel</div>
        </div>
        <div class="${PLUGIN_ID}-dock-col" id="${PLUGIN_ID}-sp-timing">
          <div class="${PLUGIN_ID}-sec-title">Timing and range</div>
        </div>
      </div>
      <div id="${PLUGIN_ID}-sp-signal">
        <div class="${PLUGIN_ID}-field-help">Grey is the script, dashed purple the Flow plan, green
          what the toy actually gets, orange each Bluetooth command.</div>
      </div>`;
    pop.querySelector(`#${PLUGIN_ID}-sp-close`).addEventListener("click", () => toggleScriptPanel(false));

    // script picker, for folders with more than one candidate
    const sel = document.createElement("select");
    sel.id = `${PLUGIN_ID}-select`;
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      selectedFunscript = sel.value;
      applyScriptSettingsFor(sel.value);
      loadFunscript(sel.value);
    });
    pop.querySelector(`#${PLUGIN_ID}-script-pick`).appendChild(sel);

    // whole-scene strip: click to seek
    overviewCanvas = pop.querySelector(`#${PLUGIN_ID}-overview-canvas`);
    overviewCanvas.addEventListener("click", (ev) => {
      if (!flowOverview || !videoEl) return;
      const r = overviewCanvas.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const ms = flowOverview.t0 + f * (flowOverview.t1 - flowOverview.t0);
      videoEl.currentTime = Math.max(0, ms / 1000);
    });

    // vibrator track switch
    const track = pop.querySelector(`#${PLUGIN_ID}-sp-track`);
    const trackBtn = document.createElement("button");
    trackBtn.type = "button";
    trackBtn.id = `${PLUGIN_ID}-sp-track-btn`;
    trackBtn.addEventListener("click", () => {
      vibeTrackOn = !vibeTrackOn;
      scriptSettingChanged();
      updateFunscriptSelector();
    });
    const trackText = document.createElement("div");
    trackText.className = `${PLUGIN_ID}-field-help`;
    trackText.id = `${PLUGIN_ID}-sp-track-text`;
    const trackHead = document.createElement("div");
    trackHead.className = `${PLUGIN_ID}-field-head`;
    trackHead.innerHTML = `<label>Vibrator track</label>`;
    trackHead.appendChild(trackBtn);
    track.appendChild(trackHead);
    track.appendChild(trackText);

    // mode cards
    const modes = pop.querySelector(`#${PLUGIN_ID}-sp-modes`);
    SCRIPT_MODES.forEach(([value, label, blurb]) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `${PLUGIN_ID}-card`;
      card.dataset.mode = value;
      card.innerHTML = `<span class="${PLUGIN_ID}-card-name">${label}</span>
                        <span class="${PLUGIN_ID}-card-blurb">${blurb}</span>`;
      card.addEventListener("click", () => { vibeMode = value; scriptSettingChanged(); });
      modes.appendChild(card);
    });

    // feel: one set of knobs per mode, shown by updateScriptUI()
    const feel = pop.querySelector(`#${PLUGIN_ID}-sp-feel`);
    feel.appendChild(scriptKnob("smooth", "Smoothness",
      "Left: the level moves with every stroke. Right: it follows how busy the scene is and rises and fades gently.",
      { min: 0, max: 100, curve: "lin", unit: "%", inputStep: 5,
        words: (v) => v < 25 ? "follows each stroke" : v < 70 ? "balanced" : "follows the scene" },
      () => flowSmooth, (v) => { flowSmooth = Math.round(v); }));
    feel.appendChild(scriptKnob("rhythm", "Rhythm",
      "How much each stroke pulses on top of the level. 0 is a smooth buzz; all the way right is one burst per stroke with silence between.",
      { min: 0, max: 100, curve: "lin", unit: "%", inputStep: 5,
        words: (v) => v < 1 ? "smooth" : v < 40 ? "light pulse" : v < 85 ? "strong pulse" : "bursts only" },
      () => flowRhythm, (v) => { flowRhythm = Math.round(v); }));
    feel.appendChild(scriptKnob("gain", "Sensitivity",
      "Flow levels itself to each script so the busiest parts reach full power. Right makes quieter parts stronger, left calms it down.",
      { min: 0.25, max: 4, curve: "log", unit: "x", inputStep: 0.05,
        words: (v) => Math.abs(v - 1) < 0.05 ? "as scripted" : v > 1 ? "livelier" : "calmer" },
      () => flowGain, (v) => { flowGain = Math.round(v * 20) / 20; }));
    feel.appendChild(scriptKnob("maxspeed", "Sensitivity",
      "The stroke speed that means full power. If it sits at full most of the time, raise it; if it barely moves, lower it.",
      { min: 50, max: 2000, curve: "log", unit: "u/s", inputStep: 25,
        words: (v) => v >= 1000 ? "gentle" : v >= 600 ? "balanced" : v >= 300 ? "lively" : "very buzzy" },
      () => vibeMaxSpeed, (v) => { vibeMaxSpeed = Math.round(v / 25) * 25; }));
    feel.appendChild(scriptKnob("burst", "Burst length",
      "How long each beat buzzes. Raise it if slow sections are too faint to feel; it shortens itself when beats come fast.",
      { min: 60, max: 1000, curve: "log", unit: "ms", inputStep: 10 },
      () => beatMs, (v) => { beatMs = Math.round(v / 10) * 10; }));
    feel.appendChild(scriptKnob("prom", "Beat detail",
      "This script is sampled every video frame (FunGen or another tracker), so beats are picked out of it. Left finds more, smaller beats; right keeps only big strokes.",
      { min: 5, max: 60, curve: "lin", unit: "", inputStep: 5,
        words: (v) => v <= 15 ? "fine" : v <= 35 ? "normal" : "coarse" },
      () => beatProminence, (v) => { beatProminence = Math.round(v / 5) * 5; }));
    const edgeRow = document.createElement("div");
    edgeRow.className = `${PLUGIN_ID}-field`;
    edgeRow.id = `${PLUGIN_ID}-script-edge-box`;
    edgeRow.innerHTML = `<div class="${PLUGIN_ID}-field-head"><label for="${PLUGIN_ID}-sp-edge">Fire on</label></div>
      <div class="${PLUGIN_ID}-field-help">Pick bottom or top only to halve the tempo, for scripts that mark both the beat and the off-beat.</div>`;
    const edgeSel = document.createElement("select");
    edgeSel.id = `${PLUGIN_ID}-sp-edge`;
    [["all", "every stroke turn"], ["low", "bottom turns only"], ["high", "top turns only"]]
      .forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; edgeSel.appendChild(o); });
    edgeSel.addEventListener("change", () => { beatEdge = edgeSel.value; scriptSettingChanged(); });
    edgeRow.querySelector(`.${PLUGIN_ID}-field-head`).appendChild(edgeSel);
    feel.appendChild(edgeRow);

    // timing and output range
    const timing = pop.querySelector(`#${PLUGIN_ID}-sp-timing`);
    timing.appendChild(scriptKnob("offset", "Timing",
      "If the toy reacts after the action on screen, make it fire earlier. Every script has its own sync, so this is remembered per script.",
      { min: -2000, max: 2000, curve: "lin", unit: "ms", inputStep: 10,
        words: (v) => v === 0 ? "in sync" : v > 0 ? `${v} ms earlier` : `${-v} ms later` },
      () => offsetMs, (v) => { offsetMs = Math.round(v / 10) * 10; }));
    timing.appendChild(scriptKnob("rmin", "Weakest",
      "The level the quietest moving part of the script plays at. Raise it if quiet parts drop below what you can feel. Silence stays silent.",
      { min: 0, max: 95, curve: "lin", unit: "%", inputStep: 1 },
      () => strokeMin, (v) => { strokeMin = Math.min(Math.round(v), strokeMax - MIN_STROKE_GAP); }));
    timing.appendChild(scriptKnob("rmax", "Strongest",
      "The most the script may drive the toy. Manual mode has its own Power limit in the pattern panel.",
      { min: 5, max: 100, curve: "lin", unit: "%", inputStep: 1 },
      () => strokeMax, (v) => { strokeMax = Math.max(Math.round(v), strokeMin + MIN_STROKE_GAP); }));

    // live signal: a switch in the header, a full-width scope at the bottom
    pop.querySelector(`#${PLUGIN_ID}-sp-scope-btn`).addEventListener("click", () => {
      previewWanted = !previewWanted;
      saveSettingsToStorage();
      setPreview(previewWanted && dockOpen);
      updateScriptUI();
    });
    pop.querySelector(`#${PLUGIN_ID}-sp-signal`).appendChild(buildPreview());

    updateScriptUI();
    return pop;
  }

  // 1.46: the script's tuning lives in the settings sheet, collapsed under
  // "This script" (it was a dock under the player, and the user found the
  // per-scene tuning too prominent). Tune script on the deck opens the sheet
  // with it expanded; the sheet then moves to the side so the video can be
  // scrubbed while tuning.
  function updateScriptUI() {
    const btn = byId(`${PLUGIN_ID}-script-name`);
    if (btn) btn.classList.toggle("is-tuned", !!scriptMemory(selectedFunscript));
    if (!scriptPop) return;
    const $ = (id) => scriptPop.querySelector(`#${PLUGIN_ID}-${id}`);
    const eff = effectiveScriptMode();

    setIconText($("sp-title"), selectedFunscript ? "note" : "",
      selectedFunscript ? (currentSceneTitle || prettyName(selectedFunscript)) : "Script");

    // memory bar
    const mem = $("sp-memory");
    mem.innerHTML = "";
    const tuned = !!scriptMemory(selectedFunscript);
    const txt = document.createElement("span");
    txt.textContent = !selectedFunscript
      ? "No script loaded. Changes here set your defaults."
      : tuned ? "Tuned for this script. It comes back like this next time."
      : collectionVibe ? `Using your defaults, in ${collectionVibe} mode for this collection. Anything you change is remembered for this script.`
              : "Using your defaults. Anything you change is remembered for this script.";
    mem.appendChild(txt);
    mem.classList.toggle("is-tuned", tuned);
    if (tuned) {
      const b1 = document.createElement("button");
      b1.type = "button"; b1.textContent = "Use defaults";
      b1.title = "Forget the tuning for this script and go back to your defaults";
      b1.addEventListener("click", forgetScriptTuning);
      const b2 = document.createElement("button");
      b2.type = "button"; b2.textContent = "Make these my defaults";
      b2.title = "Scripts you have not tuned will start from these settings";
      b2.addEventListener("click", makeScriptDefaults);
      mem.appendChild(b1); mem.appendChild(b2);
    }

    $("script-pick").style.display = funscripts.length > 1 ? "" : "none";

    const hasTrack = isOwner && statusData && statusData.vibeTrack;
    $("sp-track").style.display = hasTrack ? "" : "none";
    if (hasTrack) {
      $("sp-track-btn").textContent = vibeTrackOn ? "Used" : "Ignored";
      $("sp-track-btn").classList.toggle("is-on", vibeTrackOn);
      $("sp-track-text").textContent = vibeTrackOn
        ? `${statusData.vibeTrack} was made for vibrators, so the vibrator plays it as written and the mode below is not used. A stroker still follows the main script.`
        : `${statusData.vibeTrack} is being ignored; the mode below is used instead.`;
    }

    scriptPop.querySelectorAll(`#${PLUGIN_ID}-sp-modes .${PLUGIN_ID}-card`).forEach((c) => {
      c.classList.toggle("is-sel", c.dataset.mode === vibeMode);
      if (c.dataset.mode === "auto") {
        c.querySelector(`.${PLUGIN_ID}-card-name`).textContent =
          vibeMode === "auto" ? `Auto (${eff === "beat" ? "Beat" : "Flow"})` : "Auto";
      }
    });

    const show = (id, on) => { const el = $(`script-${id}-box`); if (el) el.style.display = on ? "" : "none"; };
    show("smooth", eff === "flow");
    show("rhythm", eff === "flow");
    show("gain", eff === "flow");
    // graded beat scripts take their strength from stroke height, not speed
    show("maxspeed", eff === "speed" || (eff === "beat" && statusData?.beatKind !== "graded"));
    show("burst", eff === "beat");
    show("edge", eff === "beat");
    show("prom", eff === "beat" && !!(statusData && statusData.beatPicked));
    const feelAny = ["flow", "speed", "beat"].includes(eff) && !(hasTrack && vibeTrackOn);
    $("sp-feel").style.display = feelAny ? "" : "none";
    const edge = $("sp-edge"); if (edge && edge.value !== beatEdge) edge.value = beatEdge;
    scriptKnobs.forEach((k) => k.refresh());

    $("sp-scope-btn").textContent = previewWanted ? "Live signal on" : "Live signal off";
    $("sp-scope-btn").classList.toggle("is-on", previewWanted);
    $("sp-signal").style.display = previewWanted ? "" : "none";
    drawOverview();
  }

  function drawOverview() {
    const cv = overviewCanvas;
    const box = scriptPop && scriptPop.querySelector(`#${PLUGIN_ID}-sp-overview`);
    if (!cv || !box) return;
    const lv = flowOverview && flowOverview.levels;
    box.style.display = lv && lv.length && isOwner ? "" : "none";
    if (!lv || !lv.length || !cv.isConnected || !dockOpen) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr));
    const h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext("2d");
    g.clearRect(0, 0, w, h);
    const bw = w / lv.length;
    const vt = vidTokens();
    lv.forEach((v, i) => {
      const bh = Math.max(v > 0 ? 1.5 * dpr : 0, v * (h - 2 * dpr));
      g.fillStyle = cRgba(vt.ma, 0.25 + 0.6 * v);
      g.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh);
    });
    if (videoEl && flowOverview.t1 > flowOverview.t0) {
      const x = ((videoEl.currentTime * 1000 - flowOverview.t0) / (flowOverview.t1 - flowOverview.t0)) * w;
      g.fillStyle = vt.hi;
      g.fillRect(Math.round(Math.max(0, Math.min(w - dpr, x))), 0, dpr * 1.5, h);
    }
  }

  function toggleScriptPanel(force) {
    const show = force !== undefined ? !!force : !dockOpen;
    if (show) toggleSettingsPop(true);
    const det = byId(`${PLUGIN_ID}-set-tune`);
    if (det && det.open !== show) det.open = show;      // its toggle event calls setTuneOpen
    else setTuneOpen(show);
  }
  function setTuneOpen(show) {
    if (show && !scriptPop) buildScriptPanel();
    dockOpen = !!show && !!(settingsPop && settingsPop.classList.contains("is-open"));
    saveSettingsToStorage();
    clearInterval(overviewTimer);
    if (dockOpen) {
      const host = byId(`${PLUGIN_ID}-set-tune-body`);
      if (host && scriptPop.parentNode !== host) host.appendChild(scriptPop);
      updateScriptUI();
      overviewTimer = setInterval(drawOverview, 500);    // moving playhead
      if (previewWanted && !previewOn) setPreview(true);
    } else if (previewOn) {
      // the scope is only visible there; stop the stream, keep the switch
      setPreview(false);
    }
    if (settingsPop) settingsPop.classList.toggle("is-side", dockOpen && !isPhone());
    syncVeil();
    updateFunscriptSelector();
  }

  // Micro pulsing is one setting shown in two places: the settings row and the
  // pattern panel, where the floor hint tells people to turn it on.
  function toggleMicro() {
    vibeSubstep = !vibeSubstep;
    saveSettingsToStorage();
    sendSettings();
    updateMicroButtons();
    updateManualUI();
    log(`Micro pulsing: ${vibeSubstep ? "on" : "off"}`);
  }

  function updateMicroButtons() {
    const floorPct = (scalarStep * 100).toFixed(0);
    document.querySelectorAll(`.${PLUGIN_ID}-micro-btn`).forEach((b) => {
      setTog(b, vibeSubstep, "Micro pulsing");
      b.title =
        `Gets you below the motor's own floor of ${floorPct}%. It rapidly pulses between ` +
        "silence and one step, and the motor's inertia averages that into something gentler " +
        `than the hardware can hold steady. Only does anything below ${floorPct}%.`;
    });
  }

  function buildHandyPanel() {
    const panel = document.createElement("div");
    panel.id = `${PLUGIN_ID}-handy-panel`;

    const keyLabel = document.createElement("span");
    keyLabel.textContent  = "Connection Key:";
    keyLabel.style.cssText = "font-size:11px;";
    panel.appendChild(keyLabel);

    const keyInput = document.createElement("input");
    keyInput.id          = `${PLUGIN_ID}-handy-key`;
    keyInput.type        = "text";
    keyInput.placeholder = "XXXX-XXXX";
    keyInput.value       = handyKey;
    keyInput.maxLength   = 20;
    panel.appendChild(keyInput);

    const connectBtn = document.createElement("button");
    connectBtn.id = `${PLUGIN_ID}-connect-handy-btn`;
    connectBtn.textContent   = "Connect Handy";
    connectBtn.addEventListener("click", () => {
      const key = keyInput.value.trim();
      if (!key) return;
      handyKey = key;
      saveSettingsToStorage();
      log(`Sending connectHandy, wsReady=${wsReady}, ws=${ws?.readyState}`, "debug");
      sendMsg({ type: "connectHandy", connectionKey: key });
    });
    panel.appendChild(connectBtn);

    const tunnelLabel = document.createElement("span");
    tunnelLabel.textContent   = "Tunnel:";
    tunnelLabel.style.cssText = "font-size:11px;opacity:0.7;";
    panel.appendChild(tunnelLabel);

    const tunnelUrl = document.createElement("span");
    tunnelUrl.id          = `${PLUGIN_ID}-tunnel-url`;
    tunnelUrl.textContent = "–";
    panel.appendChild(tunnelUrl);

        panel.appendChild(tunnelUrl);

    // Reupload-Button
    const reuploadBtn = document.createElement("button");
    reuploadBtn.id          = `${PLUGIN_ID}-reupload-btn`;
    setIconText(reuploadBtn, "refresh", "Reupload script");
    reuploadBtn.addEventListener("click", () => {
      if (!selectedFunscript) { log("No funscript selected for reupload", "error"); return; }
      if (ws && ws.readyState === WebSocket.OPEN) {
        log(`Reuploading funscript: ${selectedFunscript}`);
        ws.send(JSON.stringify({ type: "loadFile", path: selectedFunscript, force: true, invert: invert}));
      } else {
        log("WS not connected", "error");
      }
    });
    panel.appendChild(reuploadBtn);

    return panel;
  }

  function updateTunnelUrlDisplay(url) {
    const el = byId(`${PLUGIN_ID}-tunnel-url`);
    if (el) el.textContent = url || "–";
  }

  // A message in the status line that the next status does not overwrite
  // for `ms` (the same hold the backend's events get).
  function showInfoFor(message, ms) {
    updateToolbarInfo(message);
    eventInfoActive = true;
    clearTimeout(eventInfoTimer);
    eventInfoTimer = setTimeout(() => { eventInfoActive = false; updateToolbarStatus(); }, ms);
  }

  let lastInfoMsg = "";
  function updateToolbarInfo(message) {
    lastInfoMsg = message;
    // 1.46: said in the pill, as its one line, until the hold ends
    const el = byId(`${PLUGIN_ID}-status`);
    if (el) paintPill(el, { tone: "note", mode: message, parts: [], pct: null, title: message });
    const act = byId(`${PLUGIN_ID}-status-act`);
    if (act) act.style.display = "none";
  }

  // ── Toast (suite design) ───────────────────────────────────────────────────
  // Raised, 12px, a 3px edge in the kind's colour, bottom centre 72px up,
  // mounted into the fullscreen element when there is one so it shows over
  // a fullscreen player. Done 3 s, error 8 s.
  let toastEl = null;
  let toastTimer = null;
  // Where the toast goes (its CSS bottom, px) when its usual spot would cover
  // the bar; null when it does not. Pure, tested: t and bar are rects.
  function toastSpot(t, bar, vh) {
    if (!t || !bar || !(bar.height > 0) || !(t.height > 0)) return null;
    const over = t.bottom > bar.top && t.top < bar.bottom && t.right > bar.left && t.left < bar.right;
    if (!over) return null;
    if (bar.top - 8 - t.height >= 8) return Math.round(vh - bar.top + 8);         // above the bar
    return Math.max(8, Math.round(vh - bar.bottom - 8 - t.height));               // under it
  }
  function toast(text, kind = "info", ms) {
    if (!document.body) return;
    injectStyles();
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = `${PLUGIN_ID}-toast`;
      toastEl.setAttribute("role", "status");
    }
    const host = document.fullscreenElement || document.body;
    if (toastEl.parentNode !== host) host.appendChild(toastEl);
    toastEl.textContent = text;
    toastEl.className = kind && kind !== "info" ? `is-${kind}` : "";
    // 1.45: never over the bar (its Stop, the slider): above it when there
    // is room, else under it. In fullscreen the bar is not on screen.
    toastEl.style.bottom = "";
    if (host === document.body && toolbarEl && toolbarEl.isConnected) {
      const b = toastSpot(toastEl.getBoundingClientRect(), toolbarEl.getBoundingClientRect(), window.innerHeight);
      if (b != null) toastEl.style.bottom = `${b}px`;
    }
    void toastEl.offsetWidth;                 // restart the transition on a repeat
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"),
                            ms || (kind === "error" ? 8000 : kind === "warn" ? 6000 : 3000));
  }

  // ── Fullscreen pill (1.45) ─────────────────────────────────────────────────
  // video.js fullscreens its .video-js element, and the bar is under it in
  // .VideoPlayer, so in fullscreen there was no Stop on screen (only the
  // keys). A small pill inside the fullscreen element, like the toast and the
  // Goon pad: what plays and how strong, and Stop. There whenever fullscreen
  // is on and the bar is in the page; dimmed, never hidden, while video.js
  // hides its controls. A bare <video> cannot hold children (§3.6): no pill.
  let fsPillEl = null;
  // What the pill says. Pure, tested. Percentages are what reaches the motor.
  function fsPillState(s) {
    if (!s.wsReady) return { tone: "warn", text: "Not connected" };
    if (!s.isOwner && !s.legacy) return { tone: "info", text: "Another tab drives the toy" };
    if (!s.outputOn) return { tone: "danger", text: "Muted" };
    if (s.goonOn) return { tone: "good", text: `Goon · level ${s.goonLevel} · ${s.goonPct}%` };
    if (s.manualOn) return { tone: "good", text: `Manual · ${s.pattern} · ${s.manualPct}%` };
    if (s.halted) return { tone: "quiet", text: "Stopped" };
    if (s.hasScript) return { tone: s.playing ? "good" : "quiet", text: `Script · ${s.level}%${s.playing ? "" : " · paused"}` };
    return { tone: "quiet", text: "Nothing playing" };
  }
  function fsHost() {
    const f = document.fullscreenElement;
    return f && f.tagName !== "VIDEO" ? f : null;
  }
  function buildFsPill() {
    injectStyles();
    const el = document.createElement("div");
    el.id = `${PLUGIN_ID}-fspill`;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Intiface Sync");
    el.innerHTML = `<span class="${PLUGIN_ID}-fs-dot" aria-hidden="true"></span><span class="${PLUGIN_ID}-fs-txt" role="status"></span>`;
    el.appendChild(stopButton(""));
    // inside the player: video.js must not see these as clicks on the video
    ["pointerdown", "mousedown", "click", "dblclick", "touchstart", "keydown"].forEach((t) =>
      el.addEventListener(t, (ev) => ev.stopPropagation()));
    return el;
  }
  function updateFsPill() {
    const host = !pluginOff && toolbarEl && toolbarEl.isConnected ? fsHost() : null;
    if (!host) { if (fsPillEl && fsPillEl.parentNode) fsPillEl.remove(); return; }
    if (!fsPillEl) fsPillEl = buildFsPill();
    if (fsPillEl.parentNode !== host) host.appendChild(fsPillEl);
    const ro = goonOn && goonSt ? g2Readout(goonLim(), goonSt, g2Mot()) : null;
    const act = activePreset();
    const st = fsPillState({ wsReady, isOwner, legacy: legacyBackend, outputOn, goonOn: !!ro,
      goonLevel: ro ? ro.level : 0, goonPct: ro ? ro.playing : 0, manualOn,
      pattern: act ? act.name : shapeLabel(manualShape), manualPct: Math.round(manualLevel * effectiveCeiling() / 100),
      halted: haltHeld, hasScript: funscriptLoaded === true, playing: !!(statusData && statusData.playing),
      level: Math.round(scriptLevel * strokeMax / 100) });
    fsPillEl.dataset.tone = st.tone;
    const t = fsPillEl.querySelector(`.${PLUGIN_ID}-fs-txt`);
    if (t && t.textContent !== st.text) { t.textContent = st.text; t.title = st.text; }
  }
  // the pill, the pad and the toast follow the player in and out of fullscreen
  document.addEventListener("fullscreenchange", () => {
    updateFsPill();
    if (goonOn) placePadHostOnly();
  });

  // ── Bar state ──────────────────────────────────────────────────────────────
  // One state at a time, in plain words, with at most one action. Pure: the
  // tests feed it every combination (scripts/test_intifacesync.js). The order
  // is the order of what blocks what: no backend hides everything else, a
  // spectator cannot act on the device, mute beats any connection detail.
  function barState(s) {
    if (s.off) {
      return { key: "off", tone: "quiet", text: "Intiface · off", action: "on", label: "Turn on",
               title: "Off in this browser: nothing connects and nothing reaches a toy." };
    }
    // 1.49: Restart / Stop / Start backend from the player, in progress
    if (s.ctl) return { key: "backendctl", tone: "warn", text: s.ctl, action: null };
    if (!s.wsReady) {
      if (s.startingBackend) return { key: "starting", tone: "warn", text: "Starting the backend…", action: null };
      return { key: "nobackend", tone: "warn", text: "Backend not running", action: "start",
               label: s.gaveUp ? "Try again" : "Start",
               title: `Nothing answers at ${s.backendUrl || "the backend port"}. Start runs Stash's ` +
                      "“Start Backend” task (Settings › Tasks › Intiface Sync)." };
    }
    if (!s.versionOk) {
      // 1.49: the fix is one click (Restart backend), no trip to Settings › Tasks
      return { key: "oldbackend", tone: "warn", text: "Old backend: restart it", action: "restart", label: "Restart backend",
               title: `This page is ${s.pageVersion || "newer"} but the backend is ${s.backendVersion || "older"}. ` +
                      "Reloading plugins does not restart it. Restart backend stops the toy, stops the old backend and starts the new one " +
                      "(the same as Stop Backend, then Start Backend in Settings › Tasks › Intiface Sync)." };
    }
    if (!s.isOwner && !s.legacy) {
      const d = s.driver;
      const where = d ? (d.title ? `“${d.title}”` : `scene ${d.scene || "?"}`) : "";
      return { key: "spectator", tone: "info", text: d ? "Another tab drives the toy" : "No tab is driving",
               action: "takeover", label: "Take over",
               title: (d ? `The toy follows ${where} in another tab${d.playing ? " (playing)" : ""}. `
                         : "Nothing drives the toy. ") +
                      "One tab drives at a time, across all browsers; pressing play here takes over too. " +
                      "Mute, Disconnect and Manual off work from any tab." };
    }
    if (!s.outputOn) {
      return { key: "muted", tone: "danger", text: "Muted", action: "unmute", label: "Unmute",
               title: "Nothing reaches the toy, script or manual (E)." };
    }
    if (s.mode === "handy_wifi") {
      if (s.error) return { key: "error", tone: "danger", text: s.error, action: null };
      if (!s.connected) return { key: "handyoff", tone: "quiet", text: "Handy not connected", action: null,
                                 title: "Enter the connection key in the row below and press Connect Handy." };
      return { key: s.playing ? "playing" : "connected", tone: "good", playing: !!s.playing,
               text: s.playing ? "Handy playing" : "Handy connected", action: null };
    }
    const failed = !!(s.error && /^Failed to connect/.test(s.error));
    if (s.error && !failed) return { key: "error", tone: "danger", text: s.error, action: "connect", label: "Retry" };
    if (!s.connected) {
      if (s.connecting) return { key: "connecting", tone: "warn", text: "Connecting to Intiface…", action: null };
      if (failed || s.noServer) {
        return { key: "noserver", tone: "warn", text: "No Intiface server", action: "connect", label: "Retry",
                 title: `Nothing answered at ${s.intifaceUrl || "the Intiface server URL"}. Is Intiface Central ` +
                        "running with its server started? Other tabs wait a minute before trying again on their own." };
      }
      return { key: "disconnected", tone: "quiet", text: "Not connected", action: "connect", label: "Connect" };
    }
    const names = (s.devices || []).map((d) => d && d.name).filter(Boolean);
    if (!names.length) {
      return { key: "searching", tone: "warn", text: "Searching for devices", action: null,
               title: "Intiface is connected and scanning. Turn the toy on, or pair it in Intiface Central." };
    }
    return { key: s.playing ? "playing" : "connected", tone: "good", playing: !!s.playing,
             text: names.join(", ") + (s.extra || ""), action: null };
  }

  // What the script is doing, appended to the device name.
  function statusExtra() {
    const sd = statusData || {};
    if (sd.vibeEffective === "track") return " · vibe track";
    if (sd.beatScript) {
      const kind = sd.beatKind === "graded" ? "beat/amp" : "beat";
      return sd.vibeEffective === "beat" ? ` · ${kind}` : " · beat script, mode not beat";
    }
    if (sd.beatPicked && sd.vibeEffective === "beat") return ` · ${sd.beatPeaks} peaks`;
    return "";
  }

  let lastIntifaceUrl = "";
  function currentBarState() {
    const sd = statusData || {};
    return barState({
      off: pluginOff, wsReady, ctl: backendCtlText(),
      startingBackend: backendStartInFlight || pendingIntifaceConnect,
      gaveUp: backendStartGaveUp, backendUrl: BACKEND_URL,
      versionOk: !(backendStatusSeen && sd.version !== PLUGIN_VERSION),
      pageVersion: PLUGIN_VERSION, backendVersion: sd.version || "before 1.30",
      isOwner, legacy: legacyBackend, driver: driverInfo, outputOn, mode,
      connected: !!sd.connected, playing: !!sd.playing, devices: sd.devices, error: sd.error,
      noServer: noServerAt() > 0, connecting: connectingToIntiface,
      intifaceUrl: lastIntifaceUrl, extra: statusExtra(),
    });
  }

  function runStatusAction(action) {
    switch (action) {
      case "on":       goOn(); break;
      case "start":
      case "connect":  requestIntifaceConnect(); break;
      case "takeover": tryTakeover("button"); break;
      case "unmute":   setOutput(true); break;
      // 1.49: the backend from the player
      case "restart":  backendCtl("restart"); break;
      case "bstop":    backendCtl("stop"); break;
      case "bstart":   backendCtl("start"); break;
      // 1.46: after Stop with the video still playing, the user's own resume
      // (the same as pressing play again): the script goes on from here
      case "resume": {
        const v = liveVideo();
        haltHeld = false;
        if (v && !v.paused && !v.ended && funscriptLoaded === true) sendMsg({ type: "play", time: v.currentTime * 1000, rate: v.playbackRate });
        updateToolbarStatus();
        break;
      }
      default: break;
    }
  }

  // ── Toolbar (1.46: the quiet bar) ──────────────────────────────────────────
  // One line under the player: the pill (what plays, how strong at the
  // motor; a click opens the deck), its one action when something needs
  // doing (Start, Retry, Take over, Unmute, Resume, Turn on), a key hint,
  // the gear and Stop. Everything else is in the deck under it or in the
  // settings sheet. Nothing over the video (the fullscreen pill aside).
  // Stop (1.45): the bar's, the deck's, the sheets', the Goon pad's and the
  // fullscreen pill's. A red outline with an icon and the word, solid red
  // only on hover and focus; the hit area is larger than it looks (::before).
  function stopButton(id) {
    const b = document.createElement("button");
    b.type = "button";
    if (id) b.id = `${PLUGIN_ID}-${id}`;
    b.className = `${PLUGIN_ID}-stopbtn`;
    b.innerHTML = ic("stop") + `<span class="${PLUGIN_ID}-stopword">Stop</span>`;
    b.setAttribute("aria-label", "Stop the toy (0)");
    b.setAttribute("aria-keyshortcuts", "0");
    b.title = "Stop (0): the script, the manual pattern and Goon mode, from any tab. The script starts again on the next play. " +
              "The Intiface link stays; Disconnect is in the settings.";
    b.addEventListener("click", (ev) => { ev.stopPropagation(); log("Stop pressed", "debug"); stopAll(); });
    return b;
  }

  function iconButton(id, icon, label, extraClass) {
    const b = document.createElement("button");
    b.type = "button";
    b.id = `${PLUGIN_ID}-${id}`;
    b.className = `${PLUGIN_ID}-icon-btn${extraClass ? " " + extraClass : ""}`;
    b.innerHTML = ic(icon);
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  }

  // What the pill says (1.46). Pure, tested. s.bar is barState(): anything
  // but a working connection is said in its words with its one action. A
  // working one names the mode in bold, then the preset or the device and
  // the script's mode, and the strength that reaches the motor.
  function pillState(s) {
    const b = s.bar || {};
    if (b.key !== "connected" && b.key !== "playing") {
      return { tone: b.tone || "quiet", mode: b.text || "", parts: [], pct: null, action: b.action || null,
               label: b.label || "", title: b.title || b.text || "", playing: false };
    }
    if (s.halted && s.mode === "script") {
      return { tone: "warn", mode: "Stopped", parts: [s.canResume ? "until the next play" : "nothing reaches the toy"], pct: null,
               action: s.canResume ? "resume" : null, label: "Resume",
               title: "Stop was pressed. The script starts again on the next play, or with Resume; Manual starts the pattern." };
    }
    // 1.49: held silent while the video is paused (the setting)
    const quiet = s.pauseHold ? ["paused · silent"] : [];
    const qt = s.pauseHold ? " Silent while the video is paused; it goes on when you press play." : "";
    if (s.mode === "goon") {
      return { tone: "good", mode: "Goon", parts: [s.style, `level ${s.level}`].filter(Boolean).concat(quiet), pct: s.pct, action: null,
               title: `Goon mode, ${s.style}, level ${s.level}: ${s.pct}% at the motor.${qt} Click for the controls.`, playing: !s.pauseHold };
    }
    if (s.mode === "manual") {
      return { tone: "good", mode: "Manual", parts: [s.pattern].concat(s.auto ? ["no funscript"] : []).concat(quiet), pct: s.pct, action: null,
               title: `Manual: ${s.pattern}, ${s.pct}% at the motor${s.auto ? " (this scene has no funscript)" : ""}.${qt} Click for the controls.`, playing: !s.pauseHold };
    }
    if (!s.hasScript) {
      return { tone: b.tone || "quiet", mode: "Script", parts: [b.text, s.pending ? "looking for a funscript" : "no funscript"].filter(Boolean),
               pct: null, action: null, title: "This scene has no funscript. Click for the controls: Manual or Goon play a pattern.", playing: false };
    }
    return { tone: "good", mode: "Script", parts: [b.text, s.vibe].filter(Boolean), pct: s.pct, action: null,
             title: `The funscript drives ${b.text}${s.playing ? "" : " (paused)"}: up to ${s.pct}% at the motor. Click for the controls.`,
             playing: !!s.playing };
  }
  function vibeShort() {
    if (statusData && statusData.vibeEffective === "track") return "vibe track";
    const eff = effectiveScriptMode();
    const name = (SCRIPT_MODES.find((m) => m[0] === eff) || ["", eff])[1];
    return vibeMode === "auto" ? `Auto · ${name}` : name;
  }
  function currentPillState() {
    const mode = currentMode();
    const sv = strengthNow();
    const act = activePreset();
    return pillState({
      bar: currentBarState(), mode, halted: haltHeld && !manualOn,
      canResume: haltHeld && funscriptLoaded === true && videoIsPlaying(),
      style: (G2_STYLES.find((x) => x[0] === goonSet.style) || G2_STYLES[0])[1], level: sv.kind === "level" ? sv.value : 0,
      pct: sv.kind === "level" ? sv.pct : sv.value,
      pattern: act ? act.name + (presetEdited() ? "*" : "") : shapeLabel(manualShape), auto: autoManualActive,
      hasScript: funscriptLoaded === true || (funscriptLoaded === "pending"),
      pending: sceneScriptPending, vibe: vibeShort(), playing: !!(statusData && statusData.playing),
      pauseHold,
    });
  }
  function paintPill(el, p) {
    el.dataset.tone = p.tone || "quiet";
    el.classList.toggle("is-playing", !!p.playing);
    // 1.50: past the first part they are "extra": a phone shows the mode,
    // one word and the % (it cut every part to "S…", "l…", "p…")
    const parts = (p.parts || []).map((x, i) => `<span class="${PLUGIN_ID}-sep${i ? ` ${PLUGIN_ID}-extra` : ""}">·</span>` +
      `<span class="${PLUGIN_ID}-q${i ? ` ${PLUGIN_ID}-extra` : ""}">${escHtml(x)}</span>`).join("");
    const meter = p.pct != null
      ? `<span class="${PLUGIN_ID}-meter" aria-hidden="true"><i style="width:${clampN(p.pct, 0, 100)}%"></i></span><span class="${PLUGIN_ID}-pct">${Math.round(p.pct)}%</span>` : "";
    const html = `<span class="${PLUGIN_ID}-dot"></span><b class="${PLUGIN_ID}-mode">${escHtml(p.mode)}</b>${parts}${meter}` +
                 ic(deckOpen ? "up" : "down", "trail");
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    el.title = p.title || p.mode;
    el.setAttribute("aria-label", `Intiface Sync: ${[p.mode].concat(p.parts || []).join(", ")}${p.pct != null ? `, ${Math.round(p.pct)} percent` : ""}. ` +
                                  (deckOpen ? "Close the controls" : "Open the controls"));
  }
  function paintBar() {
    if (eventInfoActive) return;
    const el = byId(`${PLUGIN_ID}-status`);
    if (!el) return;
    const p = currentPillState();
    paintPill(el, p);
    const act = byId(`${PLUGIN_ID}-status-act`);
    if (act) {
      act.style.display  = p.action ? "" : "none";
      act.textContent    = p.label || "";
      act.dataset.action = p.action || "";
      act.title          = p.title || "";
    }
  }

  function buildToolbar() {
    injectStyles();

    const bar = document.createElement("div");
    bar.id    = `${PLUGIN_ID}-toolbar`;
    toolbarEl = bar;                     // byId can reach it before it is mounted
    bar.addEventListener("pointerdown", () => tryTakeover("toolbar"), true);
    bar.style.cssText = `
      display:flex; flex-direction:column; align-items:stretch; gap:6px;
      padding:6px 10px; background:var(--sx-bg);
      color:var(--sx-tx); font-size:12px;
      border-top:1px solid var(--sx-ui); position:relative; z-index:1;
    `;

    const row1 = document.createElement("div");
    row1.className = `${PLUGIN_ID}-row`;

    // The pill: what plays and how strong; a click opens the deck
    const pill = document.createElement("button");
    pill.type = "button";
    pill.id = `${PLUGIN_ID}-status`;
    pill.className = `${PLUGIN_ID}-pillbtn`;
    pill.setAttribute("aria-haspopup", "true");
    pill.setAttribute("aria-expanded", deckOpen ? "true" : "false");
    pill.addEventListener("click", (ev) => { ev.stopPropagation(); toggleDeck(); });
    row1.appendChild(pill);
    const act = document.createElement("button");
    act.type = "button";
    act.id = `${PLUGIN_ID}-status-act`;
    act.style.display = "none";
    act.addEventListener("click", (ev) => { ev.stopPropagation(); runStatusAction(act.dataset.action); });
    row1.appendChild(act);

    const sp = document.createElement("span");
    sp.className = `${PLUGIN_ID}-sp`;
    row1.appendChild(sp);
    // 1.50: no key hint on the bar any more (the user: keys only on hover);
    // Stop's tooltip says 0, Live's says E, the settings list them all
    const gear = iconButton("gear", "gear", "Settings: connection, this script, behaviour, the keyboard shortcuts", `${PLUGIN_ID}-quiet`);
    gear.addEventListener("click", (ev) => { ev.stopPropagation(); toggleSettingsPop(); });
    row1.appendChild(gear);

    // 1.45: Stop, labelled: a full stop of the script, the pattern and Goon
    // mode from any tab (stopAll: "halt", the backend's _panic() keeping the
    // Intiface link). Never folded away, never greyed, on every screen size.
    const stopBtn = stopButton("stop");
    row1.appendChild(stopBtn);

    bar.appendChild(row1);

    updateHotkeyBtn();
    updateMicroButtons();
    updateToolbarStatus();
    return bar;
  }

  // ── The deck (1.46) ────────────────────────────────────────────────────────
  // A click on the pill opens it under the player; it pushes the page down
  // and is never over the video. Top: Script · Manual · Goon, Mute, Stop.
  // Then Strength (Goon: the Level), then what the mode needs: the script's
  // line and Tune script; the preset cards (the first four are Alt+1..4),
  // the sentence, Update / Revert, the favourite line, Fine-tune and Edit
  // pattern; Goon's style, stage, graph, Pace, pads and moves. On a phone it
  // is a bottom sheet with pages (main, Fine-tune, All presets) and a wide
  // Stop. Folding by itself is a setting, off unless turned on (prefs.fold).
  const DECK_FOLD_MS = 4000;
  let deckOpen   = false;
  let deckPinned = false;
  let deckFine   = false;        // the Fine-tune drawer (desktop)
  let deckPage   = "main";       // the phone sheet's page: main | fine | presets
  let deckFoldT  = null;
  let deckCardsKey = "";
  let deckDrag   = -1;
  let buildWhich = null;         // which build-ups the Build-up macro moves: { len, amp }
  const isPhone = () => (window.innerWidth || 1200) <= 640;
  function deckIsOpen() { return !!(deckEl && deckOpen && deckEl.isConnected); }

  // Whether the deck folds now (pure, tested): the setting on, not pinned,
  // open, the video playing, nobody pointing at it or typing in it.
  // 1.49: "pointing at it" is a mouse that moved over the deck in the last
  // DECK_FOLD_MS (o.hover), not a pointer resting there; "typing" is a text
  // field (o.focus), not the Strength slider or a select that kept focus.
  function foldDue(o) {
    return !!(o.fold && !o.pinned && o.open && o.playing && !o.hover && !o.focus);
  }
  // 1.49: the auto-fold never fired in the user's tests (setting on, video
  // playing). Found by reading the timer's checks: (1) after a click or a
  // drag of Strength the mouse stays where it was, over the deck, and
  // `:hover` kept re-arming the timer for as long as it rested there; (2) a
  // range input or a select keeps focus after it is used, and
  // typingInAField() counts every INPUT and SELECT, so after one Strength
  // drag the deck never folded again; (3) on a touch screen `:hover` sticks
  // to the last tap; (4) `videoIsPlaying()` read videoEl only. Now a hover
  // counts only while the mouse moved over the deck within DECK_FOLD_MS,
  // focus only in a text field, touch never hovers, and the player is
  // liveVideo(). Every change in the deck (and a play) restarts the 4 s;
  // nothing else does (Goon's tick and the echo repaint without touching it).
  let deckMoveAt = 0, deckPointer = "mouse";
  function foldTyping(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA" || el.isContentEditable) return true;
    if (el.tagName !== "INPUT") return false;
    return ["text", "search", "number", "email", "url", "tel", "password", ""].includes(String(el.type || "").toLowerCase());
  }
  function deckTouched() {
    clearTimeout(deckFoldT);
    deckFoldT = null;
    if (!prefs.fold || deckPinned || !deckOpen) return;
    deckFoldT = setTimeout(deckFoldCheck, DECK_FOLD_MS);
  }
  function deckFoldCheck() {
    deckFoldT = null;
    const now = Date.now();
    const over = deckPointer === "mouse" && !!(deckEl && deckEl.matches && deckEl.matches(":hover"));
    const hover = over && now - deckMoveAt < DECK_FOLD_MS;
    const focus = !!(deckEl && document.activeElement && deckEl.contains(document.activeElement) &&
                    foldTyping(document.activeElement));
    const v = liveVideo();
    const playing = !!(v && !v.paused && !v.ended);
    if (foldDue({ fold: prefs.fold, pinned: deckPinned, open: deckOpen, playing, hover, focus })) toggleDeck(false);
    else if (deckOpen && prefs.fold && !deckPinned && (hover || focus)) {
      // look again when the last movement is DECK_FOLD_MS old (or soon, typing)
      clearTimeout(deckFoldT);
      deckFoldT = setTimeout(deckFoldCheck, hover ? Math.max(250, DECK_FOLD_MS - (now - deckMoveAt)) : DECK_FOLD_MS);
    }
  }

  function toggleDeck(force) {
    const show = force !== undefined ? !!force : !deckOpen;
    deckOpen = show;
    if (show) {
      if (!deckEl) buildDeck();
      deckPage = "main";
      placeDeck();
      updateOutputUI();
      updateMicroButtons();
      renderDeckCards();
      updateManualUI();
      deckTouched();
    } else {
      clearTimeout(deckFoldT);
      deckFoldT = null;
      if (deckEl) deckEl.remove();
    }
    const pill = byId(`${PLUGIN_ID}-status`);
    if (pill) pill.setAttribute("aria-expanded", show ? "true" : "false");
    paintBar();
  }
  // The deck sits right after the bar. The bar is rebuilt on every scene;
  // the deck is built once and moved, so its state survives.
  // On a phone it is a fixed bottom sheet: it lives on the body, where no
  // player styling (a transform, an overflow) can clip or move it.
  function placeDeck() {
    if (!deckEl || !deckOpen) return;
    if (isPhone()) { if (deckEl.parentNode !== document.body) document.body.appendChild(deckEl); return; }
    const bar = toolbarEl;
    if (bar && bar.isConnected && bar.nextSibling !== deckEl) bar.after(deckEl);
  }

  // ── Fine-tune's three macros (1.46) ──
  // One slider each that moves its detailed values together; the editor
  // sheet still has every value on its own. Pure, tested.
  //   Intensity: Power limit (the Max) 5..100%, and the Micro pulse length
  //              with it (200 ms purr when gentle, 80 ms ticks at full).
  //   Rhythm:    the cycle (Repeat every) 12 s .. 0.6 s on a log scale, the
  //              buzz length and the starting buzz length in proportion (the
  //              share of the cycle stays), and Dip to 30% .. 0%: slow long
  //              throbs that never quite stop, fast taps with silence between.
  //   Build-up:  0 .. 30 buzzes for the length and/or the strength build-up
  //              (the two chips), starting shorter (60% .. 15% of the buzz)
  //              and weaker (60% .. 15% of the peak) the longer it builds.
  const MACRO_RHY_SLOW = 12, MACRO_RHY_FAST = 0.6, MACRO_BUILD_MAX = 30;
  const lerp = (a, b, t) => a + (b - a) * t;
  function macroPos(kind, p) {
    if (kind === "intensity") return clampN((p.ceiling - 5) / 95, 0, 1);
    if (kind === "rhythm") return clampN(Math.log(MACRO_RHY_SLOW / clampN(p.period, 0.5, 60)) / Math.log(MACRO_RHY_SLOW / MACRO_RHY_FAST), 0, 1);
    if (kind === "build") return clampN(Math.sqrt(Math.max(p.build || 0, p.buildAmp || 0) / MACRO_BUILD_MAX), 0, 1);
    return 0;
  }
  function macroApply(kind, p, x, which) {
    x = clampN(Number(x) || 0, 0, 1);
    const q = { ...p };
    if (kind === "intensity") {
      q.ceiling = Math.round(5 + 95 * x);
      q.microMs = Math.round(lerp(200, 80, x) / 10) * 10;
    } else if (kind === "rhythm") {
      const raw = MACRO_RHY_SLOW * Math.pow(MACRO_RHY_FAST / MACRO_RHY_SLOW, x);
      const per = raw < 5 ? Math.round(raw * 10) / 10 : Math.round(raw * 2) / 2;
      const k = per / clampN(p.period, 0.5, 60);
      q.period = per;
      q.onMs = Math.round(clampN(p.onMs * k, 60, 10000) / 10) * 10;
      q.onFromMs = Math.round(clampN(p.onFromMs * k, 60, 10000) / 10) * 10;
      q.depth = Math.round(30 * (1 - x));
    } else if (kind === "build") {
      const n = Math.round(MACRO_BUILD_MAX * x * x);
      const w = which || { len: true, amp: true };
      q.build = w.len ? n : 0;
      q.buildAmp = w.amp ? n : 0;
      q.onFromMs = Math.max(60, Math.round(p.onMs * lerp(0.6, 0.15, x) / 10) * 10);
      q.ampFrom = Math.round(lerp(60, 15, x));
    }
    return cleanPattern(q);
  }
  function buildChips() {
    if (buildWhich) return buildWhich;
    const none = !manualBuild && !manualBuildAmp;
    return { len: none || manualBuild > 0, amp: none || manualBuildAmp > 0 };
  }
  // The pattern's own values from a cleaned pattern (the editor's, the macros').
  function assignPattern(c) {
    manualShape = c.shape;   manualPeriod  = c.period;  manualOnMs    = c.onMs;
    manualDepth = c.depth;   manualBuild   = c.build;   manualCeiling = c.ceiling;
    manualMicroMs = c.microMs; manualBuildAmp = c.buildAmp; manualAmpFrom = c.ampFrom;
    manualOnFromMs = c.onFromMs;
  }
  function applyMacro(kind, x, final) {
    assignPattern(macroApply(kind, currentPattern(), x, buildChips()));
    saveSettingsToStorage();
    updateManualUI();
    if (final) sendManual(); else throttledManual();
  }

  function buildDeck() {
    injectStyles();
    const P = PLUGIN_ID;
    const d = document.createElement("div");
    d.id = `${P}-deck`;
    // .pop supplies the content styling shared with the sheets; the
    // #IntifaceSync-deck rules undo its floating-window parts.
    d.className = `${P}-pop ${P}-deck`;
    d.setAttribute("role", "region");
    d.setAttribute("aria-label", "Intiface Sync controls");
    deckEl = d;
    const macro = (kind, name, left, right) => `<div class="${P}-macro" data-macro-box="${kind}">
        <div class="${P}-macro-hd"><b>${name}</b><span class="${P}-macro-wd" id="${P}-mw-${kind}"></span></div>
        <input type="range" class="${P}-knob" data-macro="${kind}" min="0" max="1000" step="1" aria-label="${name}">
        <div class="${P}-macro-ends"><span>${left}</span><span>${right}</span></div>
        <div class="${P}-macro-det" id="${P}-md-${kind}"></div></div>`;
    d.innerHTML = `
      <div class="${P}-dk-phead ${P}-phone-only" data-pg="main">
        <span class="${P}-dot" id="${P}-dk-pdot"></span><b id="${P}-dk-pdev"></b><span class="${P}-muted" id="${P}-dk-psub"></span>
        <span class="${P}-sp"></span>
        <button type="button" class="${P}-ibtn" data-dk="gear" aria-label="Settings">${ic("gear")}</button>
        <button type="button" class="${P}-ibtn" data-dk="close" aria-label="Close the controls">${ic("down")}</button>
      </div>
      <div class="${P}-dk-row ${P}-phone-only" data-pg="fine presets">
        <button type="button" class="${P}-btn ${P}-wide" data-dk="back">Back to the controls</button></div>
      <div class="${P}-dk-top" data-pg="main">
        <div class="${P}-dk-seg" role="group" aria-label="What drives the toy">
          <button type="button" data-mode="script" id="${P}-script-name">${ic("note", "lead")}Script <span class="${P}-sub"></span></button>
          <button type="button" data-mode="manual" id="${P}-manual-btn">Manual <span class="${P}-sub"></span></button>
          <button type="button" data-mode="goon" id="${P}-goon-btn">Goon <span class="${P}-sub"></span></button>
        </div>
        <span class="${P}-muted ${P}-dk-note" id="${P}-dk-note"></span>
        <span class="${P}-sp"></span>
        <button type="button" id="${P}-output-btn"></button>
        <button type="button" class="${P}-ibtn" data-dk="pin" id="${P}-dk-pin"></button>
        <button type="button" class="${P}-ibtn ${P}-desk-only" data-dk="close" aria-label="Fold the controls" title="Fold back to the pill">${ic("up")}</button>
      </div>
      <div class="${P}-dk-str" id="${P}-strength" data-pg="main">
        <span class="${P}-lab" id="${P}-dk-slab">Strength</span>
        <button type="button" class="${P}-step" data-dk="down" aria-label="Weaker" title="Weaker ([ or -)" aria-keyshortcuts="[">−</button>
        <div class="${P}-trk" id="${P}-dk-trk">
          <input type="range" class="${P}-knob" id="${P}-manual-level" min="0" max="100" step="1" aria-label="Strength">
          <i class="${P}-maxmark" id="${P}-dk-max" aria-hidden="true"></i><span class="${P}-maxlab" id="${P}-dk-maxlab"></span>
        </div>
        <div class="${P}-dk-lvs ${P}-lvdots" id="${P}-dk-lvs" role="group" aria-label="Goon level">${levelDots()}</div>
        <button type="button" class="${P}-step" data-dk="up" aria-label="Stronger" title="Stronger (] or =)" aria-keyshortcuts="]">+</button>
        <span class="${P}-val" id="${P}-manual-val"></span>
      </div>

      <div class="${P}-dk-body" data-body="script" data-pg="main">
        <div class="${P}-dk-row"><span class="${P}-dk-sico">${ic("note")}</span><b id="${P}-dk-stitle"></b><span class="${P}-muted" id="${P}-dk-sfile"></span></div>
        <div class="${P}-note" id="${P}-dk-sline"></div>
        <div class="${P}-dk-row"><button type="button" class="${P}-btn" data-dk="tune">${ic("tune", "lead")}Tune script</button>
          <span class="${P}-muted" id="${P}-dk-smem"></span></div>
      </div>

      <div class="${P}-dk-body" data-body="manual">
        <div class="${P}-dk-row" data-pg="main presets"><span class="${P}-cap">Presets</span>
          <span class="${P}-info ${P}-desk-only" tabindex="0" role="img" aria-label="The first four are Alt+1 to Alt+4. Drag a card, or Shift+Left and Shift+Right on a focused one, to reorder."
            title="The first four are Alt+1 to Alt+4 (Alt+Shift+N moves the active preset there). Drag a card, or Shift+Left / Shift+Right on a focused one, to reorder.">${ic("info")}</span>
          <span class="${P}-sp"></span>
          <button type="button" class="${P}-btn ${P}-ghost ${P}-desk-only" data-dk="fine" id="${P}-dk-finebtn">Fine-tune</button>
          <button type="button" class="${P}-btn ${P}-ghost" data-dk="edit">Edit pattern</button></div>
        <div class="${P}-dk-cards" id="${P}-dk-cards" data-pg="main presets"></div>
        <div class="${P}-dk-row ${P}-dk-sent" data-pg="main"><span class="${P}-note" id="${P}-dk-sentence"></span><span class="${P}-sp"></span>
          <span class="${P}-muted" id="${P}-dk-edited"></span>
          <button type="button" class="${P}-btn ${P}-pri" data-dk="update" id="${P}-dk-update">Update</button>
          <button type="button" class="${P}-btn" data-dk="revert" id="${P}-dk-revert">Revert</button></div>
        <div class="${P}-dk-row ${P}-phone-only" data-pg="main">
          <button type="button" class="${P}-btn ${P}-wide" data-dk="page-fine">Fine-tune</button>
          <button type="button" class="${P}-btn ${P}-wide" data-dk="page-presets">All presets</button></div>
        <div class="${P}-dk-fine" id="${P}-dk-fine" data-pg="fine">
          <div class="${P}-dk-row"><b id="${P}-dk-ftitle"></b><span class="${P}-muted" id="${P}-dk-fshape"></span><span class="${P}-sp"></span>
            <button type="button" class="${P}-btn ${P}-ghost ${P}-phone-only" data-dk="edit">Edit pattern</button></div>
          <div class="${P}-macros">
            ${macro("intensity", "Intensity", "gentle", "full power")}
            ${macro("rhythm", "Rhythm", "slow, long throbs", "fast, short taps")}
            ${macro("build", "Build-up", "no build", "long build")}
          </div>
          <div class="${P}-dk-row ${P}-dk-foot"><span class="${P}-muted" id="${P}-manual-hint"></span><span class="${P}-sp"></span>
            <button type="button" class="${P}-micro-btn"></button></div>
        </div>
      </div>

      <div class="${P}-dk-body" data-body="goon" data-pg="main">
        <div class="${P}-dk-row ${P}-dk-styles" id="${P}-dk-styles">${G2_STYLES.map(([id, name, line]) =>
          `<button type="button" class="${P}-chip" data-style="${id}" title="${escHtml(line)}"><span class="${P}-sk"></span>${name}</button>`).join("")}</div>
        <div class="${P}-dk-ggrid">
          <div class="${P}-dk-gleft">
            <div class="${P}-dk-row ${P}-dk-gstat" id="${P}-dk-gstat"></div>
            <div class="${P}-dk-graph ${P}-desk-only" id="${P}-dk-graph"></div>
            <div class="${P}-dk-row ${P}-dk-gact">
              <div class="${P}-dk-seg ${P}-sm ${P}-dk-gmoves" role="group" aria-label="Moves">
                <button type="button" data-g2="edge" class="is-edge" aria-keyshortcuts="${GOON_KEY_LABEL.edge}" title="${escHtml(G2_MOVE_TIPS.edge)}"><b>Edge</b></button>
                <button type="button" data-g2="hold" class="is-hold" aria-keyshortcuts="${GOON_KEY_LABEL.hold}" title="${escHtml(G2_MOVE_TIPS.hold)}"><b>Hold</b></button>
                <button type="button" data-g2="cool" class="is-cool" aria-keyshortcuts="${GOON_KEY_LABEL.cool}" title="${escHtml(G2_MOVE_TIPS.cool)}"><b>Cool down</b></button>
              </div>
              <span class="${P}-muted ${P}-dk-padsum" id="${P}-dk-padsum"></span>
              <button type="button" class="${P}-btn" data-dk="showpad" id="${P}-dk-showpad">Show pad</button>
              <span class="${P}-sp"></span>
              <button type="button" class="${P}-btn" data-dk="goonend" title="${escHtml(GOON_END_TIP)}">End Goon</button>
            </div>
          </div>
          <div class="${P}-dk-gright">
            <div class="${P}-dk-sec"><span class="${P}-cap">Pace</span>
              <div class="${P}-dk-seg ${P}-sm" id="${P}-dk-pace">${G2_PACES.map(([id, label, min]) =>
                `<button type="button" data-pace="${id}" title="${escHtml(`${label}: up one level about every ${min} minutes, at most ${G2_PACE_UP_MAX} above where you started`)}">${label}</button>`).join("")}</div>
              <div class="${P}-muted ${P}-oneline" id="${P}-dk-pacenote"></div></div>
            <div class="${P}-dk-sec"><label class="${P}-cap" for="${P}-dk-gbase">Built on</label>
              <div class="${P}-dk-row"><select id="${P}-dk-gbase" class="${P}-select" data-g2base="1" title="The preset whose buzzes Goon builds up: its cycle and buzz lengths"></select>
                <button type="button" class="${P}-btn" id="${P}-dk-gtidal" data-dk="savetidal" style="display:none"
                  title="Saves the built-in Tidal as a preset of your own (Power limit 30%): a card in Manual, and Goon is then built on your copy, which you can edit">${ic("plus", "lead")}Save as my preset</button></div>
              <div class="${P}-muted ${P}-oneline" id="${P}-dk-gbasenote"></div></div>
            <div class="${P}-dk-sec ${P}-desk-only"><span class="${P}-cap">Start level</span>
              <div class="${P}-dk-row">
                <span class="${P}-stepper" role="group" aria-label="Start level next time">
                  <button type="button" class="${P}-step" data-dk="startdown" aria-label="Start one level lower" title="Start one level lower next time">−</button>
                  <b id="${P}-dk-startval"></b>
                  <button type="button" class="${P}-step" data-dk="startup" aria-label="Start one level higher" title="Start one level higher next time">+</button></span>
                <button type="button" class="${P}-btn" data-dk="startlv" id="${P}-dk-startlv"></button></div>
              <div class="${P}-muted ${P}-oneline" id="${P}-dk-lvnote"></div></div>
            <div class="${P}-muted ${P}-oneline ${P}-desk-only" id="${P}-dk-glearn"></div>
          </div>
        </div>
        <div class="${P}-muted ${P}-phone-only">The pads are on the Goon pad at the foot of the screen (close this sheet).</div>
      </div>

      <div class="${P}-dk-row ${P}-dk-fav" id="${P}-fav-offer" data-pg="main"></div>
      <div class="${P}-dk-wstop ${P}-phone-only"></div>`;
    // Stop: the bar's is right above the deck; the phone sheet covers the
    // page, so it has its own, full width
    const wide = stopButton("");
    wide.classList.add(`${P}-stop-wide`);
    d.querySelector(`.${P}-dk-wstop`).appendChild(wide);

    d.addEventListener("pointerdown", (ev) => { deckPointer = (ev && ev.pointerType) || "mouse"; deckMoveAt = Date.now(); tryTakeover("toolbar"); deckTouched(); }, true);
    // 1.49: a mouse moving over the deck holds the fold off; one resting there does not
    d.addEventListener("pointermove", (ev) => { deckPointer = (ev && ev.pointerType) || "mouse"; if (deckPointer === "mouse") deckMoveAt = Date.now(); }, { passive: true });
    d.addEventListener("input", deckTouched, true);
    // 1.47: Goon's base preset
    d.addEventListener("change", (ev) => {
      const sel = ev.target && ev.target.closest ? ev.target.closest("[data-g2base]") : null;
      if (sel) goonSetBase(sel.value);
    });

    // Strength: the number is what reaches the motor; it stops at Max
    const sld = d.querySelector(`#${P}-manual-level`);
    const capped = () => Math.min(parseInt(sld.value, 10) || 0, strengthNow().max);
    sld.addEventListener("input", () => {
      const v = capped();
      if (String(v) !== sld.value) sld.value = String(v);
      setStrength(v, false);
    });
    sld.addEventListener("change", () => setStrength(capped(), true));

    d.querySelectorAll("[data-macro]").forEach((m) => {
      m.addEventListener("input", () => applyMacro(m.dataset.macro, (parseInt(m.value, 10) || 0) / 1000, false));
      m.addEventListener("change", () => applyMacro(m.dataset.macro, (parseInt(m.value, 10) || 0) / 1000, true));
    });

    d.addEventListener("click", (ev) => {
      const t = ev.target && ev.target.closest ? ev.target : null;
      if (!t) return;
      const md = t.closest("[data-mode]");
      if (md) { chooseMode(md.dataset.mode); return; }
      const card = t.closest("[data-card]");
      if (card) {
        if (card.dataset.card === "add") { startSaveAs(); return; }
        const i = +card.dataset.card, p = presetStore.presets[i];
        if (p && (p.name !== presetStore.active || presetEdited())) switchToSlot(i);
        return;
      }
      const lv = t.closest("[data-lv]");
      if (lv) { goonLevel(+lv.dataset.lv); return; }
      const sty = t.closest("[data-style]");
      if (sty) { goonSetStyle(sty.dataset.style); return; }
      const pc = t.closest("[data-pace]");
      if (pc) { goonSetPace(pc.dataset.pace); return; }
      const mv = t.closest("[data-g2]");
      if (mv) { goonDo(mv.dataset.g2); return; }
      if (t.closest(`#${P}-output-btn`)) { setOutput(!outputOn); return; }
      const b = t.closest("[data-dk]");
      if (!b) return;
      const a = b.dataset.dk;
      if (a === "close") toggleDeck(false);
      else if (a === "gear") toggleSettingsPop(true);
      else if (a === "pin") { deckPinned = !deckPinned; deckTouched(); updateDeck(); }
      else if (a === "down") nudgeManual(-5);
      else if (a === "up") nudgeManual(+5);
      else if (a === "fine") { deckFine = !deckFine; updateDeck(); }
      else if (a === "page-fine") { deckPage = "fine"; updateDeck(); }
      else if (a === "page-presets") { deckPage = "presets"; updateDeck(); }
      else if (a === "back") { deckPage = "main"; updateDeck(); }
      else if (a === "edit") toggleEditor(true);
      else if (a === "tune") toggleScriptPanel(true);
      else if (a === "update") updateActivePreset();
      else if (a === "revert") revertActivePreset();
      else if (a === "goonend") goonStop("Goon mode off. Back to the pattern as it was.");
      else if (a === "startlv") { if (goonSt) goonSetStartLevel(goonSt.L); }
      else if (a === "startdown" || a === "startup") goonSetStartLevel(clampN((goonSet.level || 3) + (a === "startup" ? 1 : -1), 1, 10));
      else if (a === "showpad") showPadWhole();
      else if (a === "forget") goonDo("forget");
      else if (a === "savetidal") saveTidalPreset();
      else if (a === "blen" || a === "bamp") {
        const w = { ...buildChips() };
        w[a === "blen" ? "len" : "amp"] = !w[a === "blen" ? "len" : "amp"];
        buildWhich = w;
        applyMacro("build", macroPos("build", currentPattern()) || 0.45, true);
      } else if (a === "tease") { manualShape = "tease"; saveSettingsToStorage(); updateManualUI(); sendManual(); }
    });
    d.querySelector(`.${P}-micro-btn`).addEventListener("click", toggleMicro);

    // 1.50: the deck has no pads of its own (they doubled the floating
    // pad's); a summary and Show pad instead, the pads live on the pad

    // cards: drag to reorder, Shift+Left / Shift+Right on a focused card
    d.addEventListener("dragstart", (ev) => {
      const c = ev.target.closest ? ev.target.closest("[data-card]") : null;
      if (!c || c.dataset.card === "add") return;
      deckDrag = +c.dataset.card;
      try { ev.dataTransfer.setData("text/plain", String(deckDrag)); ev.dataTransfer.effectAllowed = "move"; } catch (_) {}
    });
    d.addEventListener("dragover", (ev) => {
      if (deckDrag < 0) return;
      const c = ev.target.closest ? ev.target.closest("[data-card]") : null;
      if (c && c.dataset.card !== "add") ev.preventDefault();
    });
    d.addEventListener("drop", (ev) => {
      const c = ev.target.closest ? ev.target.closest("[data-card]") : null;
      if (deckDrag >= 0 && c && c.dataset.card !== "add") { ev.preventDefault(); moveCard(deckDrag, +c.dataset.card); }
      deckDrag = -1;
    });
    d.addEventListener("dragend", () => { deckDrag = -1; });
    d.addEventListener("keydown", (ev) => {
      const c = ev.target.closest ? ev.target.closest("[data-card]") : null;
      if (!c || c.dataset.card === "add" || !ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      ev.stopPropagation();
      const i = +c.dataset.card, to = i + (ev.key === "ArrowLeft" ? -1 : 1);
      moveCard(i, to);
      const n = d.querySelector(`[data-card="${clampN(to, 0, presetStore.presets.length - 1)}"]`);
      if (n) n.focus();
    });
    return d;
  }

  // The preset cards, each with a picture of its shape and its Max.
  function renderDeckCards() {
    const host = deckEl && deckEl.querySelector(`#${PLUGIN_ID}-dk-cards`);
    if (!host) return;
    const P = PLUGIN_ID;
    const act = presetStore.active, edited = presetEdited();
    const key = JSON.stringify([presetStore.presets.map((p) => [p.name, p.shape, p.ceiling, p.period, p.onMs, p.depth, p.build, p.buildAmp, p.ampFrom, p.onFromMs]), act, edited]);
    if (key === deckCardsKey && host.childElementCount) return;
    deckCardsKey = key;
    host.innerHTML = presetStore.presets.map((p, i) => {
      const c = cleanPattern(p);
      const on = p.name === act;
      const tip = `${p.name}: ${shapeLabel(c.shape)}, Max ${c.ceiling}%.${i < SLOT_COUNT ? ` Alt+${i + 1}.` : ""} Drag or Shift+arrows to reorder.`;
      return `<button type="button" class="${P}-pc${on ? " is-on" : ""}" data-card="${i}" draggable="true" title="${escHtml(tip)}"${i < SLOT_COUNT ? ` aria-keyshortcuts="Alt+${i + 1}"` : ""}>` +
        patternIconSvg(c, 120, 26).replace("<svg ", `<svg preserveAspectRatio="none" `) +
        `<span class="${P}-pc-nm"><span class="${P}-pc-name">${escHtml(p.name)}</span>` +
        (on && edited ? `<span class="${P}-chip-dot" title="Changed since loaded"></span>` : "") +
        `</span>` +
        `<span class="${P}-pc-meta">${shapeLabel(c.shape)} · max ${c.ceiling}%</span></button>`;
    }).join("") + `<button type="button" class="${P}-pc ${P}-pc-add" data-card="add">+ Save as preset</button>`;
  }

  // The script's line, for the deck and the settings sheet.
  function scriptLine() {
    if (!selectedFunscript) {
      if (sceneScriptPending) return "Looking for this scene's funscript…";
      return funscripts.length ? "" : "No funscript for this scene. " +
        (autoManual ? "Your pattern plays while the video plays (a switch in the settings)." : "The toy stays silent unless you choose Manual or Goon.");
    }
    const off = offsetMs === 0 ? "timing in sync" : offsetMs > 0 ? `${offsetMs} ms earlier` : `${-offsetMs} ms later`;
    const eff = effectiveScriptMode();
    const how = statusData && statusData.vibeEffective === "track" ? "the vibrator track plays as written"
      : vibeMode === "auto" ? `Auto picked ${eff === "beat" ? "Beat" : "Flow"}` : `${(SCRIPT_MODES.find((m) => m[0] === vibeMode) || ["", vibeMode])[1]} mode`;
    return `${how}, ${off}, strongest ${strokeMax}%.`;
  }

  function updateDeck() {
    const d = deckEl;
    if (!d) return;
    const P = PLUGIN_ID;
    const $ = (id) => d.querySelector(`#${P}-${id}`);
    const mode = currentMode();
    const phone = isPhone();
    if (deckOpen && phone !== (d.parentNode === document.body)) placeDeck();
    d.classList.toggle("is-phone", phone);
    d.classList.toggle("is-offline", !wsReady && !pluginOff);
    d.dataset.current = mode;
    if (!phone) deckPage = "main";
    d.dataset.page = phone ? deckPage : "";
    d.querySelectorAll("[data-pg]").forEach((el) => el.classList.toggle(`${P}-pg-hide`, phone && !el.dataset.pg.split(" ").includes(deckPage)));
    d.querySelectorAll("[data-body]").forEach((el) => { el.style.display = el.dataset.body === mode ? "" : "none"; });
    // on a phone the Fine-tune page; on a desktop the drawer
    const fine = $("dk-fine");
    if (fine) fine.style.display = phone ? "" : deckFine ? "" : "none";
    const fb = $("dk-finebtn");
    if (fb) { fb.classList.toggle("is-on", deckFine); fb.textContent = deckFine ? "Close Fine-tune" : "Fine-tune"; }

    // the phone sheet's head line: the device and the strength at the motor
    const bs = currentBarState();
    const pdev = $("dk-pdev");
    if (pdev) {
      pdev.textContent = bs.text || "";
      $("dk-pdot").dataset.tone = bs.tone || "quiet";
      const sv0 = strengthNow();
      $("dk-psub").textContent = bs.key === "connected" || bs.key === "playing" ? `${sv0.kind === "level" ? sv0.pct : sv0.value}% at the motor` : "";
    }

    // the mode choice and what each one says
    const act = activePreset();
    const subs = {
      script: funscriptLoaded === true || funscriptLoaded === "pending" ? vibeShort() : sceneScriptPending ? "looking…" : "no funscript",
      manual: act ? act.name + (presetEdited() ? "*" : "") : shapeLabel(manualShape),
      goon: goonOn && goonSt ? `running ${mmss(goonSt.t || 0)}` : (G2_STYLES.find((x) => x[0] === goonSet.style) || G2_STYLES[0])[1],
    };
    // 1.50: what each choice does is its tooltip (it was a line of text
    // beside the segment); only the no-funscript fact stays in words
    const tips = {
      script: mode === "script" ? "Script: the funscript drives the toy." : "Script: back to the funscript; Manual and Goon turn off.",
      manual: mode === "goon" ? "Manual: ends Goon; the pattern goes on." : mode === "manual" ? "Manual: your pattern plays." : "Manual: your pattern plays now.",
      goon: mode === "goon" ? "Goon: running." : "Goon: starts now, built up from your pattern.",
    };
    d.querySelectorAll("[data-mode]").forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("is-sel", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.title = tips[b.dataset.mode] || "";
      const sub = b.querySelector(`.${P}-sub`);
      if (sub && sub.textContent !== subs[b.dataset.mode]) sub.textContent = subs[b.dataset.mode];
    });
    const note = $("dk-note");
    if (note) note.textContent = mode === "manual" && autoManualActive ? "No funscript here: your pattern plays while the video plays." : "";
    const pin = $("dk-pin");
    if (pin) {
      pin.style.display = prefs.fold ? "" : "none";
      pin.innerHTML = ic(deckPinned ? "x" : "list");
      pin.classList.toggle("is-on", deckPinned);
      pin.title = deckPinned ? "Pinned open: it does not fold by itself. Click to let it fold again." : "Folds by itself 4 s after the last change while the video plays. Click to keep it open.";
      pin.setAttribute("aria-label", deckPinned ? "Let the controls fold by themselves" : "Keep the controls open");
    }

    // Strength (Goon: the Level)
    const sv = strengthNow();
    const sld = $("manual-level"), lvs = $("dk-lvs"), trk = $("dk-trk");
    $("dk-slab").textContent = sv.kind === "level" ? "Level" : "Strength";
    trk.style.display = sv.kind === "level" ? "none" : "";
    lvs.style.display = sv.kind === "level" ? "" : "none";
    const strRow = $("strength");
    if (strRow) strRow.classList.toggle("is-level", sv.kind === "level");
    if (sv.kind === "level") {
      paintLevel(lvs, sv.value, sv.pct, goonSet.level);   // 1.50: the pad's dots
      $("manual-val").innerHTML = `${sv.value}<small> · ${sv.pct}%</small>`;
      $("manual-val").title = `Level ${sv.value} of 10: ${sv.pct}% reaches the motor now. Level 10 is the Power limit, ${sv.maxPct}%.`;
    } else {
      if (document.activeElement !== sld) sld.value = String(sv.value);
      sld.style.setProperty("--fill", `${sv.value}%`);
      const mk = $("dk-max"), ml = $("dk-maxlab");
      mk.style.left = `${sv.max}%`;
      ml.style.left = `${sv.max}%`;
      ml.classList.toggle("is-right", sv.max > 80);
      const showMax = mode === "manual" || sv.max < 100;
      mk.style.display = ml.style.display = showMax ? "" : "none";
      ml.textContent = mode === "manual" ? `Max ${sv.max}%${act ? ` (${act.name})` : ""}` : `Max ${sv.max}% (Strongest)`;
      trk.style.setProperty("--max", `${sv.max}%`);
      $("manual-val").innerHTML = `${sv.value}<small>%</small>`;
      $("manual-val").title = mode === "manual"
        ? `${sv.value}% reaches the motor at the pattern's peak: ${Math.round(manualLevel)}% of its Max (${sv.max}%, the Power limit).`
        : `${sv.value}% reaches the motor at the script's strongest: ${Math.round(scriptLevel)}% of its Strongest (${sv.max}%).`;
    }

    if (mode === "script") {
      $("dk-stitle").textContent = selectedFunscript ? (currentSceneTitle || prettyName(selectedFunscript)) : (currentSceneTitle || "This scene");
      $("dk-sfile").textContent = selectedFunscript && funscripts.length > 1 ? baseName(selectedFunscript) : "";
      $("dk-sline").textContent = scriptLine();
      $("dk-smem").textContent = !selectedFunscript ? "" : scriptMemory(selectedFunscript) ? "Remembered for this script." : "Your defaults.";
    }
    if (mode === "manual") updateDeckManual();
    if (mode === "goon") updateDeckGoon();
    updateDeckFav();
  }

  function updateDeckManual() {
    const d = deckEl, P = PLUGIN_ID;
    const $ = (id) => d.querySelector(`#${P}-${id}`);
    renderDeckCards();
    const act = activePreset(), edited = presetEdited();
    $("dk-sentence").textContent = patternSummary(currentPattern());
    $("dk-edited").textContent = act && edited ? "Changed since loaded" : "";
    $("dk-update").style.display = act && edited ? "" : "none";
    $("dk-revert").style.display = act && edited ? "" : "none";
    $("dk-sentence").parentNode.classList.toggle("is-plain", !(act && edited));
    if (!(deckFine || isPhone())) return;
    const p = currentPattern();
    $("dk-ftitle").textContent = act ? act.name : "Your pattern";
    $("dk-fshape").textContent = shapeLabel(p.shape) + (act && edited ? " · changed" : "");
    d.querySelectorAll("[data-macro]").forEach((m) => {
      if (document.activeElement !== m) m.value = String(Math.round(macroPos(m.dataset.macro, p) * 1000));
      m.style.setProperty("--fill", `${Math.round(macroPos(m.dataset.macro, p) * 100)}%`);
    });
    const peak = Math.round(manualLevel * p.ceiling / 100);
    const floor = Math.round(scalarStep * 100);
    $("mw-intensity").textContent = `peaks at ${p.ceiling}% Max · ${peak}% at the motor now`;
    $("md-intensity").innerHTML = `Moves <b>Power limit</b> ${p.ceiling}% and <b>Micro pulse</b> ${p.microMs} ms together. ` +
      `Below the motor's floor (${floor}%): <b>Micro pulsing</b> ${vibeSubstep ? "on" : "off"}.`;
    const timed = p.shape !== "constant";
    const burst = p.shape === "pulse" || p.shape === "tease";
    const rb = d.querySelector('[data-macro-box="rhythm"]');
    rb.classList.toggle("is-off", !timed);
    rb.querySelector("input").disabled = !timed;
    $("mw-rhythm").textContent = !timed ? "Steady has no rhythm" : burst
      ? `a ${fmtSecs(Math.min(p.onMs / 1000, p.period * 0.95))} buzz every ${fmtSecs(p.period)}`
      : `one cycle every ${fmtSecs(p.period)}, dips to ${p.depth}%`;
    $("md-rhythm").innerHTML = !timed ? "Choose Wave, Pulse, Ramp, Tease or Random in Edit pattern for a rhythm." :
      `Moves <b>${burst ? "Repeat every" : "Cycle length"}</b> ${fmtSecs(p.period)}` +
      (burst ? `, <b>Buzz length</b> ${fmtSecs(p.onMs / 1000)}${p.shape === "tease" ? ` and <b>Starting buzz length</b> ${fmtSecs(p.onFromMs / 1000)}` : ""} in proportion` : "") +
      `, and <b>Dip to</b> ${p.depth}%.`;
    const tease = p.shape === "tease";
    const bb = d.querySelector('[data-macro-box="build"]');
    bb.classList.toggle("is-off", !tease);
    bb.querySelector("input").disabled = !tease;
    const w = buildChips(), n = Math.max(p.build, p.buildAmp);
    $("mw-build").textContent = !tease ? "a Tease pattern's" : n ? `grows over ${n} buzzes (${fmtSecs(n * p.period)})` : "no build-up";
    $("md-build").innerHTML = !tease
      ? `Build-ups belong to the Tease pattern. <button type="button" class="${P}-btn ${P}-ghost" data-dk="tease">Use Tease</button>`
      : `<span class="${P}-chips"><button type="button" class="${P}-chip${w.len ? " is-sel" : ""}" data-dk="blen" aria-pressed="${w.len}">Longer buzzes</button>` +
        `<button type="button" class="${P}-chip${w.amp ? " is-sel" : ""}" data-dk="bamp" aria-pressed="${w.amp}">Stronger buzzes</button></span>` +
        `Sets <b>Length build-up</b> ${p.build} and <b>Strength build-up</b> ${p.buildAmp} buzzes, from <b>${fmtSecs(p.onFromMs / 1000)}</b> and <b>${p.ampFrom}%</b>.`;
  }

  function updateDeckGoon() {
    const d = deckEl, P = PLUGIN_ID;
    const $ = (id) => d.querySelector(`#${P}-${id}`);
    d.querySelectorAll("[data-style]").forEach((b) => {
      const on = b.dataset.style === goonSet.style;
      b.classList.toggle("is-sel", on);
      const sk = b.querySelector(`.${P}-sk`);
      if (sk && sk.dataset.on !== String(on)) { sk.innerHTML = g2StyleSketch(b.dataset.style, on); sk.dataset.on = String(on); }
    });
    d.querySelectorAll("[data-pace]").forEach((b) => b.classList.toggle("is-sel", b.dataset.pace === goonSet.pace));
    const pc = G2_PACES.find((x) => x[0] === goonSet.pace) || G2_PACES[1];
    // 1.50: each note one line, the whole sentence in its tooltip
    oneLine($("dk-pacenote"), `Up a level about every ${pc[2]} min`,
      `${pc[1]}: up one level about every ${pc[2]} minutes, at most ${G2_PACE_UP_MAX} above where you started.`);
    // 1.47: the preset Goon builds up
    const bsel = $("dk-gbase");
    if (bsel) {
      const names = g2BaseList(presetStore), rhy = g2BaseRhythm(goonSet, presetStore);
      const opts = [["", `Default (${presetStore.presets.some((x) => x.name === G2_BASE_NAME && g2BaseUsable(x)) ? G2_BASE_NAME : "built-in"})`]]
        .concat([[G2_BASE_TIDAL, G2_TIDAL_LABEL]])          // 1.49
        .concat(names.map((n) => [n, n]));
      if (goonSet.base && goonSet.base !== G2_BASE_TIDAL && !names.includes(goonSet.base)) opts.push([goonSet.base, `${goonSet.base} (gone)`]);
      const key = JSON.stringify(opts);
      if (bsel.dataset.key !== key) {
        bsel.dataset.key = key;
        bsel.innerHTML = opts.map(([v, l]) => `<option value="${escHtml(v)}">${escHtml(l)}</option>`).join("");
      }
      if (bsel.value !== (goonSet.base || "")) bsel.value = goonSet.base || "";
      oneLine($("dk-gbasenote"), g2BaseShort(rhy), g2BaseNote(rhy));
      const tb = $("dk-gtidal");
      if (tb) tb.style.display = goonSet.base === G2_BASE_TIDAL ? "" : "none";
    }
    if (!goonOn || !goonSt) return;
    const lim = goonLim();
    const ro = g2Readout(lim, goonSt, g2Mot());
    $("dk-gstat").innerHTML = `<span class="${P}-g2-chip" style="--c:${g2Hue(ro.hue)}">${escHtml(ro.label)}</span>` +
      (ro.left != null ? `<b class="${P}-g2-left">${mmss(ro.left)}</b>` : "") +
      (ro.held ? `<span class="${P}-g2-held">Held</span>` : "") +
      (!outputOn ? `<span class="${P}-g2-held">Muted · waiting</span>` : "") +
      (outputOn && pauseHold ? `<span class="${P}-g2-held">Paused · silent</span>` : "") +
      (goonSource ? `<span class="${P}-g2-src">Started by ${escHtml(goonSourceName(goonSource))}</span>` : "") +
      `<span class="${P}-g2-then" title="${escHtml(ro.then)}">${escHtml(ro.then)}</span>`;
    // 1.50: 40 s back (was 90, most of it empty), the plan ahead, the 10 s close-up
    if (deckIsOpen()) g2GraphFor($("dk-graph"), true, G2_DECK_PAST_S, G2_PLAN_S, 10);
    const lt = g2LearnText(goonSt.learn);
    const gl = $("dk-glearn");
    gl.innerHTML = lt ? `<span class="${P}-g2-learned">Learned</span> <span class="${P}-oneline-t">${escHtml(lt)}</span> <button type="button" class="${P}-g2-link" data-dk="forget">Forget</button>`
                      : "Nothing learned yet";
    gl.title = lt ? lt : "Nothing learned yet. A Cool down teaches Goon where your peaks are.";
    const silentLimit = lim.limit < scalarStep * 100;
    const lvFull = `Started at ${goonSt.L0}. Level 10 is the Power limit, ${lim.limit}% at the motor` +
      (silentLimit ? ", under this motor's lowest step: Goon stays silent. Choose a preset with a higher Max." : ".") +
      ` Never softer than ${Math.max(G2_FLOOR, Math.round(scalarStep * 100))}% while it plays.`;
    const ln = $("dk-lvnote");
    oneLine(ln, silentLimit ? `Power limit ${lim.limit}%: under the motor's lowest step, silent` : `Level 10 is the Power limit, ${lim.limit}%`, lvFull);
    ln.classList.toggle("is-warn", silentLimit);
    $("dk-startval").textContent = String(goonSet.level);
    const sl = $("dk-startlv");
    sl.textContent = `Use ${goonSt.L}`;
    sl.title = `Start at level ${goonSt.L} (where it is now) next time`;
    sl.style.display = goonSet.level === goonSt.L ? "none" : "";
    // the pads stay on the floating pad: a summary here, and a way back to it
    const shown = !!(goonPadEl && goonPadEl.isConnected && goonPadEl.classList.contains("is-on"));
    const mini = shown && goonPadEl.classList.contains("is-mini");
    $("dk-padsum").textContent = `${goonSet.padCount} pad${goonSet.padCount === 1 ? "" : "s"} on the floating pad${mini ? " (small)" : ""}`;
    $("dk-padsum").title = "Tap a pad there (or Alt+1 to Alt+" + goonSet.padCount + "): its length; hold: keeps going; twice quickly: latch. Its Edit chooses what a pad plays.";
    $("dk-showpad").style.display = shown && !mini ? "none" : "";
    const mv = (k) => d.querySelector(`[data-g2="${k}"]`);
    const edgeOn = !!(goonSt.move && goonSt.move.k === "edge"), coolOn = !!(goonSt.move && goonSt.move.k === "cool");
    mv("edge").querySelector("b").textContent = edgeOn ? "Let go" : "Edge";
    mv("hold").querySelector("b").textContent = goonSt.held ? "Go on" : "Hold";
    [["edge", edgeOn], ["hold", !!goonSt.held], ["cool", coolOn]].forEach(([k, on]) => {
      mv(k).classList.toggle("is-active", on);
      mv(k).setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  // 1.50: a note shown on one line (cut with "…" when it has to be), the
  // whole sentence on hover and for screen readers
  function oneLine(el, short, full) {
    if (!el) return;
    if (el.textContent !== short) el.textContent = short;
    el.title = full || short;
    if (full && full !== short) el.setAttribute("aria-label", full); else el.removeAttribute("aria-label");
  }
  // 1.50: the base in a few words (g2BaseNote is the tooltip)
  function g2BaseShort(rhy) {
    const r = rhy || G2_BASE_DEFAULT;
    if (r.tide) return `Phrases of ${r.tide.phraseMin}-${r.tide.phraseMax} buzzes, about every ${fmtSecs(r.cycle)}`;
    return `${r.gone ? "Gone: built-in timing, " : ""}${fmtSecs(r.lo / 1000)}-${fmtSecs(r.hi / 1000)} buzzes, one every ${fmtSecs(r.cycle)}`;
  }
  // Shows the whole floating pad again (made small, or not on the page)
  // and makes it blink once so it can be found.
  function showPadWhole() {
    if (!goonOn) return;
    goonUi.mini = false;
    if (!goonPadEl || !goonPadEl.isConnected || !goonPadEl.classList.contains("is-on")) showGoonPad(true);
    else placePad();
    if (isPhone()) toggleDeck(false);
    if (goonPadEl) {
      goonPadEl.classList.remove("is-flash");
      void goonPadEl.offsetWidth;
      goonPadEl.classList.add("is-flash");
      setTimeout(() => { if (goonPadEl) goonPadEl.classList.remove("is-flash"); }, 1200);
    }
    updateGoonUI();
  }

  // The favourite of someone in this scene, offered, never applied by itself:
  // one line in the deck while Manual is (or will be) what plays. The full
  // list (Remember, Forget) is in the editor.
  function updateDeckFav() {
    const el = deckEl && deckEl.querySelector(`#${PLUGIN_ID}-fav-offer`);
    if (!el) return;
    const P = PLUGIN_ID;
    const f = pluginOff ? null : favouriteFor(currentScenePerformers, favStore);
    // Manual is what plays: by hand, or on a scene without a script (the
    // backend's answer, or Stash's flag while that answer has not come).
    const manualScene = (manualOn && !goonOn) || sceneHasNoScript || (!funscripts.length && !currentSceneFunscript);
    const people = currentScenePerformers || [];
    const offer = !!f && favOfferDismissed !== currentSceneId && manualScene && !samePattern(f.pattern, currentPattern());
    const act = activePreset();
    const remember = !f && manualOn && !goonOn && people.length && act && !presetEdited() ? people[0] : null;
    el.style.display = offer || remember ? "" : "none";
    const key = offer ? `o|${f.performer.id}|${favWhat(f.fav, f.pattern)}` : remember ? `r|${remember.id}|${act.name}` : "";
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = "";
    if (!key) return;
    if (offer) {
      el.innerHTML = ic("star") + `<span class="${P}-note"></span><button type="button" class="${P}-btn">Use it</button>` +
        `<span class="${P}-sp"></span><button type="button" class="${P}-btn ${P}-ghost" aria-label="Not this scene" title="Not this scene">${ic("x")}</button>`;
      el.querySelector(`.${P}-note`).textContent = `${f.performer.name}: your favourite is ${favWhat(f.fav, f.pattern)}.`;
      const [use, close] = el.querySelectorAll("button");
      use.title = `${f.performer.name}'s favourite pattern. Use loads it; it does not start the toy.`;
      use.addEventListener("click", (ev) => { ev.stopPropagation(); const now = favouriteFor(currentScenePerformers, favStore); if (now) useFav(now); });
      close.addEventListener("click", (ev) => { ev.stopPropagation(); favOfferDismissed = currentSceneId; updateDeckFav(); });
    } else {
      el.innerHTML = ic("star") + `<button type="button" class="${P}-btn ${P}-ghost"></button>`;
      const b = el.querySelector("button");
      b.textContent = `Remember ${act.name} for ${(remember.name || "").split(" ")[0] || "them"}`;
      b.title = `Remember ${act.name} as ${remember.name}'s favourite (for every browser). Everyone in the scene: Edit pattern.`;
      b.addEventListener("click", (ev) => { ev.stopPropagation(); rememberCurrentFor(remember); });
    }
  }

  // ── Intiface / The Handy switch (settings sheet) ──────────────────────────
  function updateModeButtons() {
    const bi = byId(`${PLUGIN_ID}-mode-intiface`);
    const bh = byId(`${PLUGIN_ID}-mode-handy`);
    if (bi) bi.classList.toggle("is-on", mode === "intiface");
    if (bh) bh.classList.toggle("is-on", mode === "handy_wifi");
    const hp = byId(`${PLUGIN_ID}-handy-panel`);
    if (hp) hp.style.display = (handyEnabled && mode === "handy_wifi") ? "flex" : "none";
  }

  function switchMode(m) {
    if (mode === m) return;
    mode          = m;
    intifaceReady = false;
    statusData    = { connected: false, playing: false };
    saveSettingsToStorage();
    log(`Mode switched to ${m}`);
    sendMsg({ type: "setMode", mode: m });
    updateModeButtons();
    updateToolbarStatus();
  }

  // ── Settings sheet (1.46) ──────────────────────────────────────────────────
  // The gear: the connection in three lines (backend, Intiface Central, the
  // device) with Disconnect, this script (its tuning collapsed), the
  // switches, the keys, the no-funscript list and Not using it. A sheet
  // like the editor (sheetHead, showSheet, the one dismiss handler).
  let settingsPop = null;

  function buildSettingsPop() {
    injectStyles();
    const P = PLUGIN_ID;
    const pop = document.createElement("div");
    pop.id = `${P}-settings-pop`;
    pop.className = `${P}-pop ${P}-modal`;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Intiface Sync settings");
    pop.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
    const k = (x) => `<kbd>${x}</kbd>`;
    pop.appendChild(sheetHead("Intiface Sync", `${P}-set-ver`, () => toggleSettingsPop(false)));
    const body = document.createElement("div");
    body.innerHTML = `
      <div class="${P}-section ${P}-first">
        <div class="${P}-sec-title">Connection</div>
        <div class="${P}-stat" id="${P}-set-st-backend"></div>
        <div class="${P}-stat" id="${P}-set-st-intiface"></div>
        <div class="${P}-stat" id="${P}-set-st-device"></div>
        <div class="${P}-btns" id="${P}-set-bctl"></div>
        <div class="${P}-btns">
          <button type="button" class="${P}-btn is-danger" id="${P}-set-disconnect">${ic("unplug")}Disconnect</button>
          <span class="${P}-field-help">stops the toy and drops the Intiface link (Connect again brings it back). For a plain stop: Stop or 0.</span>
        </div>
        <div class="${P}-btns" id="${P}-mode-wrap">
          <button type="button" class="${P}-btn" id="${P}-mode-intiface">Intiface</button>
          <button type="button" class="${P}-btn" id="${P}-mode-handy">The Handy</button>
        </div>
        <div id="${P}-set-handy"></div>
      </div>
      <div class="${P}-section">
        <div class="${P}-sec-title">This script</div>
        <div class="${P}-field-help" id="${P}-set-script"></div>
        <details class="${P}-tune" id="${P}-set-tune"><summary>Tune this script: mode, feel, timing, live signal</summary>
          <div id="${P}-set-tune-body"></div></details>
      </div>
      <div class="${P}-section">
        <div class="${P}-sec-title">Behaviour</div>
        <button type="button" id="${P}-set-auto"></button>
        <button type="button" id="${P}-set-fold"></button>
        <button type="button" id="${P}-set-pausequiet"></button>
        <button type="button" class="${P}-micro-btn" id="${P}-set-micro"></button>
        <button type="button" id="${P}-hotkey-btn"></button>
      </div>
      <div class="${P}-section">
        <div class="${P}-sec-title">Keys</div>
        <div class="${P}-keygrid">
          <span>${k("0")} Stop</span><span>${k("E")} Mute or unmute</span>
          <span>${k("[")} ${k("]")} or ${k("-")} ${k("=")} Weaker, stronger</span><span>${k("\\")} Manual on or off</span>
          <span>${k("Alt 1..4")} Preset card 1 to 4</span><span>${k("Alt Shift 1..4")} Move the preset there</span>
          <span class="${P}-muted">Goon: ${k("Alt W")} Edge ${k("Alt A")} Hold ${k("Alt Q")} Cool down</span>
          <span class="${P}-muted">Goon: ${k("Alt 1..8")} pads, ${k("Alt")} + wheel level</span>
          <span class="${P}-muted">Cards: ${k("Shift ←")} ${k("Shift →")} reorder</span><span class="${P}-muted">${k("Esc")} closes a sheet</span>
        </div>
      </div>
      <div class="${P}-section">
        <div class="${P}-btns">
          <button type="button" class="${P}-btn" id="${P}-set-nofs">${ic("list")}Scenes without a funscript</button>
          <span class="${P}-sp"></span>
          <button type="button" class="${P}-btn ${P}-ghost" id="${P}-set-off" title="Stops anything running, folds the bar to a small pill and stops connecting, in every tab of this browser, until you click the pill.">${ic("fold")}Not using it: turn off in this browser</button>
        </div>
      </div>`;
    while (body.firstChild) pop.appendChild(body.firstChild);
    settingsPop = pop;
    const $ = (id) => pop.querySelector(`#${P}-${id}`);
    $("set-handy").appendChild(buildHandyPanel());
    $("set-disconnect").addEventListener("click", () => { sendMsg({ type: "stop" }); toggleSettingsPop(false); });
    $("mode-intiface").addEventListener("click", () => switchMode("intiface"));
    $("mode-handy").addEventListener("click", () => switchMode("handy_wifi"));
    $("set-tune").addEventListener("toggle", () => setTuneOpen($("set-tune").open));
    $("set-auto").addEventListener("click", () => {
      autoManual = !autoManual;
      saveSettingsToStorage();
      updateSettingsUI();
      updateFunscriptSelector();
      if (autoManual) autoManualCheck(); else autoManualStop();
    });
    $("set-fold").addEventListener("click", () => {
      prefs.fold = !prefs.fold;
      savePrefs();
      updateSettingsUI();
      deckTouched();
      updateDeck();
    });
    // 1.49: silent while the video is paused (on unless turned off)
    $("set-pausequiet").addEventListener("click", () => {
      prefs.pauseQuiet = !prefs.pauseQuiet;
      savePrefs();
      updateSettingsUI();
      refreshPauseHold();
    });
    $("set-micro").addEventListener("click", toggleMicro);
    $("hotkey-btn").addEventListener("click", () => {
      if (!hotkeysAllowed) return;      // the plugin setting wins
      hotkeysOn = !hotkeysOn;
      updateHotkeyBtn();
      saveSettingsToStorage();
      paintBar();
    });
    $("set-nofs").addEventListener("click", () => { toggleSettingsPop(false); openNoScripts(); });
    $("set-off").addEventListener("click", () => { toggleSettingsPop(false); goOff(); });
    // the connection rows' buttons are rebuilt with the rows
    pop.addEventListener("click", (ev) => {
      const b = ev.target.closest ? ev.target.closest("[data-conn]") : null;
      if (!b) return;
      if (b.dataset.conn === "connect") requestIntifaceConnect();
      else runStatusAction(b.dataset.conn);
    });
    return pop;
  }

  // The connection in three lines (pure, tested): the backend, Intiface
  // Central, the device. Each { tone, name, text, right, action, label }.
  function connRows(s) {
    const back = !s.wsReady
      ? { tone: "warn", name: "Backend", text: s.starting ? "starting…" : "not running", right: s.backendUrl, action: s.starting ? null : "start", label: "Start" }
      : s.versionOk ? { tone: "good", name: "Backend", text: `running, ${s.backendVersion}`, right: s.backendUrl }
      : { tone: "warn", name: "Backend", text: `${s.backendVersion}, older than this page (${s.pageVersion}): Restart backend (Stop Backend, then Start Backend)`, right: s.backendUrl,
          action: "restart", label: "Restart backend" };
    const intif = !s.wsReady ? { tone: "quiet", name: "Intiface Central", text: "waits for the backend", right: s.intifaceUrl }
      : s.connected ? { tone: "good", name: "Intiface Central", text: "connected", right: s.intifaceUrl, action: "connect", label: "Connect again" }
      : s.connecting ? { tone: "warn", name: "Intiface Central", text: "connecting…", right: s.intifaceUrl }
      : { tone: "warn", name: "Intiface Central", text: s.noServer ? "no server answered" : "not connected", right: s.intifaceUrl, action: "connect", label: s.noServer ? "Retry" : "Connect" };
    const names = (s.devices || []).map((x) => x && x.name).filter(Boolean);
    const steps = s.scalarStep > 0 ? Math.round(1 / s.scalarStep) : 0;
    const who = s.isOwner || s.legacy ? "this tab drives it" : s.driver ? `another tab drives it${s.driver.title ? ` (“${s.driver.title}”)` : ""}` : "no tab drives it";
    const dev = names.length
      ? { tone: "good", name: names.join(", "), text: steps ? `${steps} steps, floor ${Math.round(s.scalarStep * 100)}%` : "", right: who,
          action: s.isOwner || s.legacy ? null : "takeover", label: "Take over" }
      : { tone: s.connected ? "warn" : "quiet", name: "Device", text: s.connected ? "searching: turn the toy on or pair it in Intiface Central" : "none yet", right: who };
    return [back, intif, dev];
  }

  function updateSettingsUI() {
    if (!settingsPop) return;
    const P = PLUGIN_ID;
    const $ = (id) => settingsPop.querySelector(`#${P}-${id}`);
    setTog($("set-auto"), autoManual, "Play my pattern on scenes without a funscript");
    $("set-auto").title = autoManual
      ? "Scenes without a funscript play your manual pattern while the video plays, and stop when it pauses."
      : "Scenes without a funscript stay silent.";
    setTog($("set-fold"), prefs.fold, "Fold the controls while the video plays");
    $("set-fold").title = "On: the controls under the player fold back to the pill 4 s after the last change while the video plays (a pin keeps them open). This browser only.";
    setTog($("set-pausequiet"), prefs.pauseQuiet, "Silent while the video is paused");
    $("set-pausequiet").title = "On (default): while the scene's video is paused, ended or buffering, nothing reaches the toy, in Script, Manual and Goon mode; " +
      "Manual stays on and Goon waits, and both go on when you press play. Pages without a video player (Manual or Goon on another page) are not affected. This browser only.";
    // 1.49: the backend from the player
    const bc = $("set-bctl");
    if (bc) {
      const armed = Date.now() - backendCtlArm <= BACKEND_ARM_MS;
      const btn = (act, label, cls, title) => `<button type="button" class="${P}-btn${cls ? " " + cls : ""}" data-conn="${act}" title="${escHtml(title)}">${escHtml(label)}</button>`;
      const html = backendCtlStep ? `<span class="${P}-muted">${escHtml(backendCtlText())}</span>`
        : wsReady ? btn("restart", "Restart backend", "", "Stops the toy, stops the backend and starts it again (after copying a new version, or when something is stuck).") +
                    btn("bstop", armed ? "Click again to stop" : "Stop backend", "is-danger", "Stops the toy and the backend process. Click twice.")
        : btn("bstart", "Start backend", "", "Starts the backend (Stash's Start Backend operation).") +
          btn("restart", "Restart backend", "", "Stops whatever is left of the backend and starts it again.");
      if (bc.dataset.html !== html) { bc.innerHTML = html; bc.dataset.html = html; }
    }
    $("set-ver").textContent = PLUGIN_VERSION;
    const sd = statusData || {};
    const rows = connRows({ wsReady, starting: backendStartInFlight || pendingIntifaceConnect, backendUrl: BACKEND_URL,
      versionOk: !(backendStatusSeen && sd.version !== PLUGIN_VERSION), backendVersion: sd.version || "before 1.30", pageVersion: PLUGIN_VERSION,
      connected: !!sd.connected, connecting: connectingToIntiface, noServer: noServerAt() > 0,
      intifaceUrl: lastIntifaceUrl || "ws://localhost:12345", devices: sd.devices, scalarStep,
      isOwner, legacy: legacyBackend, driver: driverInfo });
    ["backend", "intiface", "device"].forEach((id, i) => {
      const r = rows[i], el = $(`set-st-${id}`);
      const html = `<span class="${P}-dot" data-tone="${r.tone}"></span><b>${escHtml(r.name)}</b><span class="${P}-muted">${escHtml(r.text || "")}</span>` +
        `<span class="${P}-r"><span class="${P}-muted">${escHtml(r.right || "")}</span>` +
        (r.action ? `<button type="button" class="${P}-btn" data-conn="${r.action}">${escHtml(r.label)}</button>` : "") + `</span>`;
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    });
    const tuned = !!scriptMemory(selectedFunscript);
    $("set-script").textContent = selectedFunscript
      ? `${currentSceneTitle || prettyName(selectedFunscript)}: ${scriptLine()} ${tuned ? "Remembered for this script." : "Your defaults."}`
      : scriptLine() || "No script loaded. Changes in the tuning set your defaults.";
    $("mode-wrap").style.display = handyEnabled ? "flex" : "none";
    updateModeButtons();
    updateMicroButtons();
    updateHotkeyBtn();
  }

  function toggleSettingsPop(force) {
    if (!settingsPop) {
      if (force === false) return;      // nothing to hide, do not build one
      buildSettingsPop();
    }
    const show = force !== undefined ? !!force : !settingsPop.classList.contains("is-open");
    if (show) toggleEditor(false);
    const gear = byId(`${PLUGIN_ID}-gear`);
    if (gear) gear.classList.toggle("is-on", show);
    if (!show) {
      // the tuning closes with the sheet (and its live scope with it)
      const det = byId(`${PLUGIN_ID}-set-tune`);
      if (det && det.open) det.open = false;
      if (dockOpen) setTuneOpen(false);
      settingsPop.classList.remove("is-side");
    }
    showSheet(settingsPop, show);
    if (show) { updateSettingsUI(); applyHandyVisibility(); }
  }

  // ── Status Display ─────────────────────────────────────────────────────────
  function updateToolbarStatus() {
    const barEl = byId(`${PLUGIN_ID}-toolbar`);
    if (barEl) barEl.classList.toggle("is-offline", !wsReady && !pluginOff);
    updateModeSeg();
    if (settingsPop && settingsPop.classList.contains("is-open")) updateSettingsUI();
  }

  function baseName(path) {
    return String(path || "").split(/[\\/]/).pop();
  }

  function prettyName(path) {
    return baseName(path).replace(/\.funscript$/i, "").replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // The pill, the deck and the fullscreen pill say what plays.
  function updateModeSeg() {
    paintBar();
    updateDeck();
    updateFsPill();
  }

  function updateFunscriptSelector() {
    const sel   = byId(`${PLUGIN_ID}-select`);
    const label = byId(`${PLUGIN_ID}-script-name`);
    const pick  = byId(`${PLUGIN_ID}-script-pick`);

    updateModeSeg();
    if (label) {
      // The scene's title reads better than a script file name.
      const title = currentSceneTitle || (selectedFunscript ? prettyName(selectedFunscript) : "");
      if (funscripts.length === 0) {
        label.title = "No funscript belongs to this video. " +
          (autoManual ? "Your manual pattern plays while the video plays (switch in Settings)."
                      : "The toy stays silent (switch in Settings).") +
          " Manual drives it by hand.";
      } else {
        const track = isOwner && statusData && statusData.vibeTrack;
        label.title = `${title}\n${selectedFunscript}\n\n` +
          (manualOn ? "Manual is driving. Click to let the script drive the toy again."
                    : "The script drives the toy. How it drives it (mode, feel, timing): Tune script.") +
          (track ? `\n\nVibrator track: ${track}. ` +
                   (vibeTrackOn ? "The vibrator plays this track directly; a stroker still follows the main script."
                                : "Ignored, the vibrator follows the main script. Turn it back on in the script settings.")
                 : "");
      }
    }

    // The picker is only worth showing when there is a real choice to make.
    if (pick) pick.style.display = funscripts.length > 1 ? "" : "none";

    if (!sel) return;
    sel.innerHTML = "";
    if (funscripts.length === 0) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "No funscript found";
      sel.appendChild(opt);
      return;
    }
    funscripts.forEach((path) => {
      const opt = document.createElement("option");
      opt.value       = path;
      opt.textContent = baseName(path);
      if (path === selectedFunscript) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function injectToolbar() {
    const existing = byId(`${PLUGIN_ID}-toolbar`);
    if (existing) {
      existing.remove();
      toolbarInjected = false;
    }
    if (toolbarInjected) return;
    const player = document.querySelector(".VideoPlayer, .video-player, #player");
    if (!player) return;
    removePill();
    player.appendChild(buildToolbar());
    toolbarInjected = true;
    placeDeck();                        // an open deck follows the bar to the new scene
    applyHandyVisibility();
    updateManualUI();
    updateOutputUI();
    updateHotkeyBtn();
    updateToolbarStatus();
    // a held message (event, read error) outlives a rebuild of the bar
    if (eventInfoActive && lastInfoMsg) updateToolbarInfo(lastInfoMsg);
    updateFunscriptSelector();
    log("Toolbar injected", "debug");
  }


  // Stash renders the player some time after the route changes. On a slow
  // load (a cold server, a big library, a phone on wifi) that was after the
  // 10 s this used to give up at, so the scene had no toolbar, and with it no
  // Disconnect button and no hotkeys, until the next navigation (audit A11).
  // Now: every 500 ms for the first 10 s, then every 2 s for as long as this
  // scene stays open. A newer scene's run replaces this one; leaving the
  // scene pages ends it. A toolbar already in the page is left alone rather
  // than rebuilt on every attempt, and one React threw away is put back.
  let injectRun = 0;
  function retryInjectToolbar(attempts = 0, run = ++injectRun) {
    if (run !== injectRun || !getSceneIdFromUrl()) return;
    // Off: only the pill, no video hooks (nothing to send them to).
    if (pluginOff) {
      if (!injectPill()) setTimeout(() => retryInjectToolbar(attempts + 1, run), attempts < 20 ? 500 : 2000);
      return;
    }
    if (!toolbarInjected || !(toolbarEl && toolbarEl.isConnected)) {
      toolbarInjected = false;
      injectToolbar();
    }
    const video = document.querySelector("video");
    if (video) attachVideoEvents(video);
    if (toolbarInjected && video) return;
    setTimeout(() => retryInjectToolbar(attempts + 1, run), attempts < 20 ? 500 : 2000);
  }

  // ── Off and on (1.38) ──────────────────────────────────────────────────────
  // The pill that stands in for the bar while IntifaceSync is off in this
  // browser. One click turns it back on.
  function injectPill() {
    const player = document.querySelector(".VideoPlayer, .video-player, #player");
    if (!player) return false;
    let pill = document.getElementById(`${PLUGIN_ID}-pill`);
    if (pill && pill.parentNode === player) return true;
    injectStyles();
    if (!pill) {
      pill = document.createElement("div");
      pill.id = `${PLUGIN_ID}-pill`;
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<span class="${PLUGIN_ID}-dot"></span>Intiface · off`;
      b.title = "Intiface Sync is off in this browser: nothing connects and nothing reaches a toy. Click to turn it on.";
      b.setAttribute("aria-label", "Intiface Sync is off. Turn it on");
      b.addEventListener("click", (ev) => { ev.stopPropagation(); goOn(); });
      pill.appendChild(b);
    }
    player.appendChild(pill);
    return true;
  }

  function removePill() {
    const pill = document.getElementById(`${PLUGIN_ID}-pill`);
    if (pill) pill.remove();
  }

  // Not using it. The order matters: first anything running goes through the
  // stop path (offPlan: the driver sends "stop", which is _panic() in the
  // backend), then the socket closes (the backend panics again when the
  // driver's socket goes, belt and braces), then nothing reconnects. Other
  // tabs of this browser follow through the storage event (fromOtherTab).
  function goOff(fromOtherTab = false) {
    if (pluginOff) return;
    autoManualStop(true);
    const plan = offPlan({ wsReady, isOwner, legacy: legacyBackend, driver: driverInfo });
    if (plan.sendStop) sendMsg({ type: "stop" });
    if (previewOn) setPreview(false);
    pluginOff = true;
    if (!fromOtherTab) { prefs.off = true; savePrefs(); }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    pendingIntifaceConnect = false;
    connectingToIntiface   = false;
    if (statusPollInterval) { statusPollInterval.stop(); statusPollInterval = null; }
    const sock = ws;
    ws = null;
    wsReady = false; isOwner = false; intifaceReady = false;
    funscriptLoaded = false; pendingPlay = null; driverInfo = null; backendStatusSeen = false;
    if (sock && plan.closeSocket) { try { sock.close(); } catch (_) {} }

    closeSheets();
    toggleDeck(false);
    closeNoScripts();
    clearInterval(overviewTimer);
    const bar = byId(`${PLUGIN_ID}-toolbar`);
    if (bar) bar.remove();
    toolbarEl = null;
    toolbarInjected = false;
    if (getSceneIdFromUrl()) retryInjectToolbar();
    if (!fromOtherTab) toast("Intiface Sync is off in this browser. The pill under the player turns it back on.", "info", 5000);
    log("Off in this browser: no backend connection until it is turned on again");
  }

  let storesLoaded = false;
  function loadStores() {
    if (storesLoaded) return;
    storesLoaded = true;
    loadPresets();
    loadScriptStore();
    loadFavs();
  }

  function goOn(fromOtherTab = false) {
    if (!pluginOff) return;
    pluginOff = false;
    if (!fromOtherTab) { prefs.off = false; savePrefs(); }
    removePill();
    // Turning it on is a deliberate act, like Connect: a fresh start budget.
    autoStartCount     = 0;
    backendStartGaveUp = false;
    reconnectDelay     = 3000;
    loadStores();
    connectBackend();
    const id = getSceneIdFromUrl();
    if (id) { lastSceneId = id; onSceneLoad(id); }
    if (!fromOtherTab) toast("Intiface Sync is on.", "done");
    log("On in this browser");
  }

  // The other tabs of this browser follow the switch, and the heat strip
  // switch; favourites changed in another tab show up here.
  window.addEventListener("storage", (ev) => {
    if (ev.key === PREFS_KEY) {
      const p = readPrefs(ev.newValue);
      prefs = p;
      if (p.off && !pluginOff) goOff(true);
      else if (!p.off && pluginOff) goOn(true);
      updateSettingsUI();
      return;
    }
    if (ev.key === FAV_STORE_KEY) {
      const s = parseFavStore(ev.newValue);
      if (!s || s.rev <= favStore.rev) return;
      favStore = s;
      updateFavUI();
      updateFavOffer();
    }
  });

  // ── Scene detection ────────────────────────────────────────────────────────
  function getSceneIdFromUrl() {
    const m = window.location.pathname.match(/\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  async function onSceneLoad(sceneId) {
    log(`Scene loaded: ${sceneId}`);
    favOfferDismissed = null;
    if (pluginOff) {
      // Off: no scene read, no script lookup, just the pill.
      currentSceneId  = sceneId;
      toolbarInjected = false;
      retryInjectToolbar();
      return;
    }
    // A new scene starts clean: the last scene's script is dropped and nothing
    // from it plays until this scene's script (or its absence) is known. An
    // automatic manual pattern is the exception: it is held until then, and
    // keeps going without a restart if this scene has no script either (the
    // funscripts reply decides; autoManualSettle stops it if no answer comes).
    sceneScriptPending = true;
    autoManualSettle();
    autoManualVeto   = false;
    sceneHasNoScript = false;
    if (isOwner) sendMsg({ type: "unloadScript" });
    funscriptLoaded       = false;
    pendingPlay           = null;
    pendingFindFunscripts = null;
    funscripts            = [];
    selectedFunscript     = null;

    sceneReadError = null;
    const scene = await getSceneDetails(sceneId);
    if (!scene) {
      // Nothing to look a script up for, but the toolbar still goes in: it
      // carries Disconnect and the device switch, and the hotkeys need it.
      // The previous scene's path must not linger for the next lookup.
      sceneScriptPending = false;
      currentScenePath   = null;
      currentSceneId     = sceneId;
      currentSceneTitle  = "";
      currentScenePerformers = [];
      currentSceneStudio     = null;
      currentSceneFunscript  = null;
      currentSceneDurationMs = 0;
      toolbarInjected    = false;
      retryInjectToolbar();
      if (sceneReadError) showInfoFor(`Could not read this scene: ${sceneReadError}`, 8000);
      return;
    }

    const videoPath  = scene.files?.[0]?.path ?? null;
    currentScenePath = videoPath;
    currentSceneId    = sceneId;
    currentSceneTitle = scene.title || (videoPath ? baseName(videoPath) : "");
    currentScenePerformers = Array.isArray(scene.performers) ? scene.performers : [];
    currentSceneStudio     = scene.studio || null;
    currentSceneFunscript  = scene.interactive && scene.paths?.funscript ? scene.paths.funscript : null;
    currentSceneDurationMs = Math.max(0, Number(scene.files?.[0]?.duration) || 0) * 1000;
    sendPresence();
    updateFavUI();
    updateFavOffer();

    // The Collections plugin, if installed, says which vibe mode this scene's
    // collection starts in. Asked per scene; its answer can arrive after the
    // script, so re-apply if the script has no tuning of its own.
    collectionVibe = null;
    const coll = window.__Collections;
    if (coll && typeof coll.vibeModeFor === "function") {
      coll.vibeModeFor(sceneId).then((m) => {
        if (currentSceneId !== sceneId) return;
        collectionVibe = m || null;
        if (collectionVibe && selectedFunscript && !scriptMemory(selectedFunscript)) {
          applyScriptSettingsFor(selectedFunscript);
        }
      }).catch(() => {});
    }

    if (videoPath) {
      if (wsReady) askFunscripts(videoPath);
      else         pendingFindFunscripts = { videoPath };
    } else {
      sceneScriptPending = false;         // nothing to look up, no answer coming
    }

    toolbarInjected = false;
    retryInjectToolbar();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  let lastUrl = location.href;
  let lastSceneId = null;

  function watchNavigation() {
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; onUrlChange(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState    = (...a) => { origPush(...a);    onUrlChange(); };
    history.replaceState = (...a) => { origReplace(...a); onUrlChange(); };
    window.addEventListener("popstate", onUrlChange);
  }

  function onUrlChange() {
    // 1.48: Goon goes on across pages (same session, clock, level, latched
    // pad); its pad lives on the body (the fullscreen element in fullscreen),
    // never in the player or the bar, so it only has to be put back if
    // something took it out. The deck is moved to the new bar and repainted
    // by Goon's tick.
    if (goonOn) placePadHostOnly();
    const sceneId = getSceneIdFromUrl();
    if (!sceneId) {
      lastSceneId = null;
      sceneScriptPending = false;
      autoManualStop();                   // off the scene pages: nothing to carry it to (held under Goon, 1.48)
      return;
    }
    if (sceneId === lastSceneId) return;
    lastSceneId = sceneId;

    const old = byId(`${PLUGIN_ID}-toolbar`);
    if (old) old.remove();
    toolbarInjected       = false;
    videoEl               = null;
    funscripts            = [];
    selectedFunscript     = null;
    funscriptLoaded       = false;
    pendingPlay           = null;
    pendingFindFunscripts = null;
    onSceneLoad(sceneId);
  }

  // ── Favourite pattern per performer (1.38) ─────────────────────────────────
  // "Remember for <performer>" in the pattern panel stores the current
  // pattern (and the preset it came from) under that performer. When a scene
  // with them plays in Manual (by hand, or because it has no funscript), the
  // bar offers it; Use applies the pattern like a preset does, which can
  // reshape a running session but never starts one.
  //
  // Stored like the presets: Stash plugin config key performerPatterns (every
  // browser, survives plugin updates) through writeStashKey, which refuses to
  // write when its own read fails (rule 5), plus a browser mirror; the newer
  // rev wins. Its own key, not inside patternPresets: a 1.37 page still open
  // somewhere rewrites patternPresets through its own parser, which would
  // drop a field it does not know. Entries are kept exactly as stored,
  // fields this version does not know included; only reading them is careful.
  const FAV_STORE_KEY = "IntifaceSync.performerPatterns";
  const FAV_CFG_KEY   = "performerPatterns";
  const FAV_MAX       = 500;
  let favStore = { v: 1, rev: 0, favs: {} };
  let favNote  = "";
  let favOfferDismissed = null;     // scene id whose offer was closed
  let favForgetArm = { id: null, t: 0 };

  function parseFavStore(raw) {
    try {
      const s = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!s || typeof s !== "object" || !s.favs || typeof s.favs !== "object" || Array.isArray(s.favs)) return null;
      return { ...s, v: 1, rev: Number(s.rev) || 0, favs: { ...s.favs } };
    } catch (_) {
      return null;
    }
  }

  function favPattern(e) {
    if (!e || typeof e !== "object" || !e.pattern || typeof e.pattern !== "object") return null;
    if (!MANUAL_SHAPES.some((x) => x[0] === e.pattern.shape)) return null;
    return cleanPattern(e.pattern);
  }

  // The first performer of the scene (Stash's order) who has a usable one.
  function favouriteFor(performers, store) {
    if (!Array.isArray(performers) || !store || !store.favs) return null;
    for (const p of performers) {
      if (!p || p.id === undefined || p.id === null) continue;
      const e = store.favs[String(p.id)];
      const pattern = favPattern(e);
      if (pattern) return { performer: p, fav: e, pattern };
    }
    return null;
  }

  // New store with this performer's favourite set; every other entry, and
  // any unknown field on this one, rides through untouched.
  function rememberFav(store, performer, pattern, presetName, now) {
    const id = String(performer.id);
    const favs = { ...((store && store.favs) || {}) };
    if (!favs[id] && Object.keys(favs).length >= FAV_MAX) {
      return { store, error: `That is ${FAV_MAX} people already. Forget one first.` };
    }
    const old = favs[id] && typeof favs[id] === "object" ? favs[id] : {};
    favs[id] = { ...old, name: String(performer.name || ""), preset: presetName || null,
                 pattern: cleanPattern(pattern), ts: now };
    return { store: { ...store, favs }, error: "" };
  }

  function forgetFav(store, id) {
    const favs = { ...((store && store.favs) || {}) };
    delete favs[String(id)];
    return { ...store, favs };
  }

  function persistFavs() {
    favStore.rev = Date.now();
    try { localStorage.setItem(FAV_STORE_KEY, JSON.stringify(favStore)); } catch (_) {}
    writeStashKey(FAV_CFG_KEY, favStore).then(() => {
      favNote = "";
      updateFavUI();
    }).catch((e) => {
      favNote = "Saved in this browser only. Stash did not accept it: " + e.message;
      log(`Favourite patterns sync to Stash failed: ${e.message}`, "error");
      updateFavUI();
    });
  }

  async function loadFavs() {
    let local = null;
    try { local = parseFavStore(localStorage.getItem(FAV_STORE_KEY)); } catch (_) {}
    let remote = null;
    try { remote = parseFavStore((await loadPluginData())?.[FAV_CFG_KEY]); } catch (_) {}
    const best = [local, remote].filter(Boolean).sort((a, b) => b.rev - a.rev)[0];
    if (best) favStore = best;
    if (local && (!remote || local.rev > remote.rev)) {
      writeStashKey(FAV_CFG_KEY, favStore).catch((e) => log(`Favourite patterns sync to Stash failed: ${e.message}`));
    }
    if (best && best !== local) {
      try { localStorage.setItem(FAV_STORE_KEY, JSON.stringify(favStore)); } catch (_) {}
    }
    updateFavUI();
    updateFavOffer();
  }

  function favWhat(e, pattern) {
    return (e && e.preset) || shapeLabel(pattern.shape);
  }

  function useFav(found) {
    const preset = found.fav && found.fav.preset
      ? presetStore.presets.find((p) => p.name === found.fav.preset) : null;
    // The preset by name if it still exists (it may have been tuned since),
    // else the pattern as it was remembered.
    if (preset) selectPreset(preset.name);
    else applyPattern(found.pattern);
    toast(`${found.performer.name}: ${favWhat(found.fav, found.pattern)}`, "done");
    updateFavUI();
    updateFavOffer();
  }

  function rememberCurrentFor(p) {
    const act = activePreset();
    const r = rememberFav(favStore, p, currentPattern(), act && !presetEdited() ? act.name : null, Date.now());
    if (r.error) { favNote = r.error; updateFavUI(); return; }
    favStore = r.store;
    persistFavs();
    toast(`Remembered for ${p.name}: ${favWhat(favStore.favs[String(p.id)], currentPattern())}`, "done");
    updateFavUI();
    updateFavOffer();
  }

  function updateFavUI() {
    if (!manualPop) return;
    const sec  = manualPop.querySelector(`#${PLUGIN_ID}-sec-favs`);
    const rows = manualPop.querySelector(`#${PLUGIN_ID}-fav-rows`);
    const note = manualPop.querySelector(`#${PLUGIN_ID}-fav-note`);
    if (!sec || !rows) return;
    const people = (currentScenePerformers || []).slice(0, 6);
    sec.style.display = people.length ? "" : "none";
    rows.innerHTML = "";
    const cur = currentPattern();
    people.forEach((p) => {
      const e = favStore.favs[String(p.id)];
      const pattern = favPattern(e);
      const row = document.createElement("div");
      row.className = `${PLUGIN_ID}-fav-row`;
      const name = document.createElement("span");
      name.className = `${PLUGIN_ID}-fav-name`;
      name.textContent = p.name || `Performer ${p.id}`;
      const what = document.createElement("span");
      what.className = `${PLUGIN_ID}-fav-what`;
      what.textContent = pattern ? `Favourite: ${favWhat(e, pattern)}` : "No favourite yet";
      name.appendChild(what);
      row.appendChild(name);
      const mk = (label, title, fn, cls) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `${PLUGIN_ID}-btn${cls ? " " + cls : ""}`;
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", fn);
        row.appendChild(b);
        return b;
      };
      if (pattern) {
        const same = samePattern(pattern, cur);
        if (!same) {
          mk("Use", `Load ${p.name}'s favourite. It does not start the toy.`,
             () => useFav({ performer: p, fav: e, pattern }), "is-on");
          mk("Remember this instead", `Replace ${p.name}'s favourite with the pattern below`, () => rememberCurrentFor(p));
        }
        const armed = favForgetArm.id === String(p.id) && Date.now() - favForgetArm.t < 6000;
        mk(armed ? "Click again to forget" : "Forget", `Forget ${p.name}'s favourite`, () => {
          if (favForgetArm.id === String(p.id) && Date.now() - favForgetArm.t < 6000) {
            favForgetArm = { id: null, t: 0 };
            favStore = forgetFav(favStore, p.id);
            persistFavs();
            updateFavOffer();
          } else {
            favForgetArm = { id: String(p.id), t: Date.now() };
            setTimeout(updateFavUI, 6100);
          }
          updateFavUI();
        }, armed ? "is-danger" : "");
      } else {
        mk(`Remember for ${(p.name || "").split(" ")[0] || "them"}`,
           `Remember the pattern below as ${p.name}'s favourite (for every browser)`, () => rememberCurrentFor(p));
      }
      rows.appendChild(row);
    });
    if (note) {
      note.classList.toggle("is-warn", !!favNote);
      note.textContent = favNote ||
        "When someone with a favourite is in a scene that plays in Manual, the controls under the player offer it. It never starts by itself.";
    }
  }

  // The offer (1.46: a line in the deck, updateDeckFav): only while Manual is
  // (or will be) what plays, only when the pattern differs, and not again
  // this scene once closed.
  function updateFavOffer() {
    updateDeckFav();
  }

  // ── Scenes without a funscript (1.38) ──────────────────────────────────────
  // Read only. Stash marks a scene interactive when a funscript with the
  // video's name sits next to it; this lists the rest, for the whole library,
  // one performer or one studio of the scene playing, with counts per
  // performer and studio and the most watched scenes first (the ones most
  // worth finding a script for). Every request is a GraphQL query.
  let nofsEl    = null;
  let nofsScope = { kind: "all" };
  let nofsSort  = "play_count";
  let nofsRun   = 0;
  let nofsData  = null;

  const NOFS_SORTS = [["play_count", "Most played"], ["created_at", "Newest"], ["rating", "Highest rated"],
                      ["o_counter", "Most O's"]];

  function noScriptsOpen() { return !!(nofsEl && nofsEl.isConnected); }

  function scopeFilter(sc) {
    if (sc && sc.kind === "performer") return { performers: { value: [String(sc.id)], modifier: "INCLUDES" } };
    if (sc && sc.kind === "studio")    return { studios: { value: [String(sc.id)], modifier: "INCLUDES" } };
    return {};
  }

  // Stash's own list with the same filter (its URL criteria format).
  function noScriptsUrl(sc, sort) {
    const c = encodeURIComponent('("type":"interactive","modifier":"EQUALS","value":"false")');
    const base = sc && sc.kind === "performer" ? `/performers/${encodeURIComponent(sc.id)}/scenes`
               : sc && sc.kind === "studio"    ? `/studios/${encodeURIComponent(sc.id)}/scenes`
               : "/scenes";
    return `${base}?c=${c}&sortby=${encodeURIComponent(sort || "play_count")}&sortdir=desc`;
  }

  // Counts per performer and studio over a list of scenes. Pure; tested.
  function groupCounts(scenes) {
    const per = new Map(), stu = new Map();
    for (const s of scenes || []) {
      for (const p of (s && s.performers) || []) {
        if (!p || p.id == null) continue;
        const e = per.get(String(p.id)) || { id: String(p.id), name: p.name || "", n: 0 };
        e.n++; per.set(e.id, e);
      }
      const st = s && s.studio;
      if (st && st.id != null) {
        const e = stu.get(String(st.id)) || { id: String(st.id), name: st.name || "", n: 0 };
        e.n++; stu.set(e.id, e);
      }
    }
    const order = (a, b) => b.n - a.n || a.name.localeCompare(b.name);
    return { performers: [...per.values()].sort(order), studios: [...stu.values()].sort(order) };
  }

  function navigateTo(url) {
    // React Router listens for popstate; a full reload would lose the page.
    history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }

  function openNoScripts() {
    injectStyles();
    closeSheets();
    if (!nofsEl) {
      nofsEl = document.createElement("div");
      nofsEl.id = `${PLUGIN_ID}-nofs`;
      nofsEl.setAttribute("role", "dialog");
      nofsEl.setAttribute("aria-modal", "true");
      nofsEl.setAttribute("aria-label", "Scenes without a funscript");
      nofsEl.addEventListener("pointerdown", (ev) => { if (ev.target === nofsEl) closeNoScripts(); });
      nofsEl.addEventListener("click", onNoScriptsClick);
      nofsEl.addEventListener("change", (ev) => {
        if (ev.target && ev.target.id === `${PLUGIN_ID}-nf-sort`) { nofsSort = ev.target.value; loadNoScripts(); }
      });
    }
    (document.fullscreenElement || document.body).appendChild(nofsEl);
    loadNoScripts();
    setTimeout(() => { const c = nofsEl && nofsEl.querySelector(`.${PLUGIN_ID}-nf-close`); if (c) c.focus(); }, 0);
  }

  function closeNoScripts() {
    nofsRun++;
    if (nofsEl) nofsEl.remove();
  }

  function onNoScriptsClick(ev) {
    const t = ev.target.closest ? ev.target.closest("[data-nf]") : null;
    if (!t) return;
    const kind = t.dataset.nf;
    if (kind === "close") { closeNoScripts(); return; }
    if (kind === "scope") {
      nofsScope = t.dataset.kind === "all" ? { kind: "all" }
        : { kind: t.dataset.kind, id: t.dataset.id, name: t.dataset.name || "" };
      loadNoScripts();
      return;
    }
    if (kind === "go") {
      // Plain left click stays in the app; middle or modified clicks open
      // a new tab the browser's way.
      if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      closeNoScripts();
      navigateTo(t.getAttribute("href"));
    }
  }

  async function loadNoScripts() {
    const run = ++nofsRun;
    const scope = nofsScope;
    nofsData = { loading: true };
    renderNoScripts();
    const base = scopeFilter(scope);
    const none = { ...base, interactive: false };
    try {
      const q = `query ($all: SceneFilterType, $none: SceneFilterType, $f: FindFilterType) {
        all:  findScenes(filter: {per_page: 1}, scene_filter: $all) { count }
        none: findScenes(filter: $f, scene_filter: $none) {
          count
          scenes { id title date play_count o_counter rating100 files { basename duration }
                   performers { id name } studio { id name } }
        }
      }`;
      const d = await gqlQuery(q, { all: base, none, f: { per_page: 40, sort: nofsSort, direction: "DESC" } });
      if (run !== nofsRun) return;
      nofsData = { loading: true, all: d.all.count, none: d.none.count, scenes: d.none.scenes };
      renderNoScripts();
      const groups = scope.kind === "all" ? await libraryGroups() : await scopedGroups(none);
      if (run !== nofsRun) return;
      nofsData = { ...nofsData, loading: false, ...groups };
      renderNoScripts();
    } catch (e) {
      if (run !== nofsRun) return;
      nofsData = { ...(nofsData || {}), loading: false, error: e.message };
      renderNoScripts();
    }
  }

  // Whole library: the 24 performers and studios with the most scenes, each
  // counted for scenes without a script in one aliased query. Reading every
  // scene of a 20,000-scene library to group them would be far slower.
  async function libraryGroups() {
    const top = await gqlQuery(`{
      p: findPerformers(filter: {per_page: 24, sort: "scenes_count", direction: DESC}) { performers { id name scene_count } }
      s: findStudios(filter: {per_page: 24, sort: "scenes_count", direction: DESC}) { studios { id name scene_count } }
    }`);
    const perfs = (top.p && top.p.performers) || [];
    const studs = (top.s && top.s.studios) || [];
    if (!perfs.length && !studs.length) return { performers: [], studios: [] };
    const part = (alias, field, id) =>
      `${alias}: findScenes(filter: {per_page: 1}, scene_filter: {interactive: false, ${field}: {value: [${JSON.stringify(String(id))}], modifier: INCLUDES}}) { count }`;
    const q = "{\n" + perfs.map((p, i) => part(`p${i}`, "performers", p.id))
      .concat(studs.map((s, i) => part(`s${i}`, "studios", s.id))).join("\n") + "\n}";
    const c = await gqlQuery(q);
    const order = (a, b) => b.n - a.n || a.name.localeCompare(b.name);
    return {
      performers: perfs.map((p, i) => ({ id: String(p.id), name: p.name, n: c[`p${i}`].count, total: p.scene_count }))
        .filter((x) => x.n > 0).sort(order),
      studios: studs.map((s, i) => ({ id: String(s.id), name: s.name, n: c[`s${i}`].count, total: s.scene_count }))
        .filter((x) => x.n > 0).sort(order),
      groupNote: "Among the 24 performers and studios with the most scenes.",
    };
  }

  // One performer or studio: few enough scenes to read and count them all
  // (up to 3,000).
  async function scopedGroups(none) {
    const all = [];
    for (let page = 1; page <= 3; page++) {
      const d = await gqlQuery(`query ($f: SceneFilterType, $p: Int) {
        findScenes(filter: {per_page: 1000, page: $p}, scene_filter: $f) { count scenes { performers { id name } studio { id name } } }
      }`, { f: none, p: page });
      all.push(...d.findScenes.scenes);
      if (all.length >= d.findScenes.count) break;
    }
    const g = groupCounts(all);
    const sc = nofsScope;
    return {
      performers: g.performers.filter((x) => !(sc.kind === "performer" && x.id === String(sc.id))),
      studios:    g.studios.filter((x) => !(sc.kind === "studio" && x.id === String(sc.id))),
      groupNote:  "",
    };
  }

  function fmtDur(sec) {
    const s = Math.round(Number(sec) || 0);
    if (!s) return "";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h} h ${m} min` : `${m || 1} min`;
  }

  function renderNoScripts() {
    if (!nofsEl) return;
    const d = nofsData || {};
    const nf = (n) => Number(n || 0).toLocaleString();
    const chip = (kind, id, name, label, sel) =>
      `<button type="button" class="${PLUGIN_ID}-nf-chip${sel ? " is-sel" : ""}" data-nf="scope" data-kind="${kind}" ` +
      `data-id="${escHtml(id || "")}" data-name="${escHtml(name || "")}">${label}</button>`;
    const sc = nofsScope;
    const isSel = (kind, id) => sc.kind === kind && (kind === "all" || String(sc.id) === String(id));
    const chips = [chip("all", "", "", "Whole library", isSel("all"))];
    const seen = new Set();
    (currentScenePerformers || []).slice(0, 6).forEach((p) => {
      seen.add(`performer:${p.id}`);
      chips.push(chip("performer", p.id, p.name, `${escHtml(p.name)} <small>performer</small>`, isSel("performer", p.id)));
    });
    if (currentSceneStudio) {
      seen.add(`studio:${currentSceneStudio.id}`);
      chips.push(chip("studio", currentSceneStudio.id, currentSceneStudio.name,
        `${escHtml(currentSceneStudio.name)} <small>studio</small>`, isSel("studio", currentSceneStudio.id)));
    }
    // a scope picked from the counts below gets its own chip
    if (sc.kind !== "all" && !seen.has(`${sc.kind}:${sc.id}`)) {
      chips.push(chip(sc.kind, sc.id, sc.name, `${escHtml(sc.name)} <small>${sc.kind}</small>`, true));
    }

    const withScript = d.all != null && d.none != null ? Math.max(0, d.all - d.none) : null;
    const pctRaw = d.all ? withScript / d.all * 100 : 0;
    const pct = Math.round(pctRaw * 10) / 10;
    const pctTxt = withScript > 0 && pct < 0.1 ? "under 0.1%" : `${pct}%`;
    const sum = d.all == null ? "" : `
      <div class="${PLUGIN_ID}-nf-sum">
        <span><span class="${PLUGIN_ID}-nf-big">${nf(d.none)}</span> of ${nf(d.all)} scenes have no funscript</span>
        <span class="${PLUGIN_ID}-nf-bar" title="${pctTxt} have one"><i style="width:${Math.min(100, pctRaw)}%"></i></span>
        <span>${nf(withScript)} with one (${pctTxt})</span>
        <a href="${escHtml(noScriptsUrl(sc, nofsSort))}" data-nf="go">${ic("ext")}Open in Stash</a>
      </div>`;

    const groupList = (list, kind) => {
      if (!list) return d.loading ? `<div class="${PLUGIN_ID}-nf-empty">Counting…</div>` : "";
      if (!list.length) return `<div class="${PLUGIN_ID}-nf-empty">None.</div>`;
      return list.slice(0, 12).map((x) =>
        `<button type="button" class="${PLUGIN_ID}-nf-row" data-nf="scope" data-kind="${kind}" data-id="${escHtml(x.id)}" ` +
        `data-name="${escHtml(x.name)}" title="Show only ${escHtml(x.name)}">` +
        `<span class="${PLUGIN_ID}-nf-name">${escHtml(x.name)}</span>` +
        `<span class="${PLUGIN_ID}-nf-n">${nf(x.n)}${x.total ? ` of ${nf(x.total)}` : ""}</span></button>`).join("");
    };

    const scenes = d.scenes
      ? (d.scenes.length ? d.scenes.map((s) => {
          const f = (s.files && s.files[0]) || {};
          const title = s.title || f.basename || `Scene ${s.id}`;
          const who = (s.performers || []).map((p) => p.name).slice(0, 3).join(", ");
          const meta = [who, s.studio && s.studio.name, fmtDur(f.duration),
                        s.play_count ? `${nf(s.play_count)} play${s.play_count === 1 ? "" : "s"}` : ""]
            .filter(Boolean).join(" · ");
          return `<a class="${PLUGIN_ID}-nf-row" data-nf="go" href="/scenes/${encodeURIComponent(s.id)}">` +
                 `<span class="${PLUGIN_ID}-nf-name">${escHtml(title)}` +
                 `<span class="${PLUGIN_ID}-nf-meta">${escHtml(meta)}</span></span></a>`;
        }).join("") : `<div class="${PLUGIN_ID}-nf-empty">Every scene here has a funscript.</div>`)
      : `<div class="${PLUGIN_ID}-nf-empty">Reading your scenes…</div>`;

    const sortSel = `<select id="${PLUGIN_ID}-nf-sort" aria-label="Order">` +
      NOFS_SORTS.map(([v, t]) => `<option value="${v}"${v === nofsSort ? " selected" : ""}>${t}</option>`).join("") +
      "</select>";

    nofsEl.innerHTML = `
      <div class="${PLUGIN_ID}-sheet">
        <div class="${PLUGIN_ID}-nf-head">
          <span class="${PLUGIN_ID}-nf-badge">${ic("list")}</span>
          <div><div class="${PLUGIN_ID}-nf-title">Scenes without a funscript</div>
            <div class="${PLUGIN_ID}-nf-sub">Read only. Stash counts a scene as having one when a .funscript with the video's name sits next to it.</div></div>
          <button type="button" class="${PLUGIN_ID}-nf-close" data-nf="close" title="Close (Esc)" aria-label="Close">${ic("x")}</button>
        </div>
        <div class="${PLUGIN_ID}-nf-scopes">${chips.join("")}</div>
        ${d.loading ? `<div class="${PLUGIN_ID}-nf-load"><i></i></div>` : ""}
        ${d.error ? `<div class="${PLUGIN_ID}-nf-err">Could not read from Stash: ${escHtml(d.error)}</div>` : ""}
        ${sum}
        <div class="${PLUGIN_ID}-nf-grid">
          <div class="${PLUGIN_ID}-nf-col"><h4>By performer</h4>${groupList(d.performers, "performer")}</div>
          <div class="${PLUGIN_ID}-nf-col"><h4>By studio</h4>${groupList(d.studios, "studio")}</div>
          <div class="${PLUGIN_ID}-nf-col"><h4>Scenes ${sortSel}</h4>${scenes}</div>
        </div>
        ${d.groupNote ? `<div class="${PLUGIN_ID}-field-help" style="margin-top:10px">${escHtml(d.groupNote)} Click a name to see only theirs.</div>` : ""}
      </div>`;
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  // The plain keys (1.45, pure, tested). The key's place (e.code) first, so
  // they work where \ [ ] need AltGr (German, French, Nordic layouts; AltGr is
  // Ctrl+Alt on Windows and was ignored) and where E is not a Latin letter;
  // then the character, so the old keys act as before on every layout. - and
  // = (and the numpad's - +) are a second pair for the level, free of AltGr.
  // 0 is Stop in every mode (it was Manual off up to 1.44).
  const PLAIN_CODES = { KeyE: "mute", Backslash: "manual", BracketLeft: "down", BracketRight: "up",
                        Minus: "down", Equal: "up", NumpadSubtract: "down", NumpadAdd: "up",
                        Digit0: "stop", Numpad0: "stop" };
  const PLAIN_CHARS = { e: "mute", E: "mute", "\\": "manual", "[": "down", "]": "up", "-": "down", "=": "up",
                        "+": "up", "0": "stop" };
  function plainKeyAction(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey) return "";
    return PLAIN_CODES[String(e.code || "")] || PLAIN_CHARS[String(e.key || "")] || "";
  }
  function typingInAField(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function installHotkeys() {
    document.addEventListener("keydown", (e) => {
      // The no-funscript panel owns the keyboard while it is open (suite
      // rule): Esc closes it, Tab, Enter and Space work inside it, and every
      // other unmodified key stops here, above all E, \ and 0.
      if (noScriptsOpen()) {
        if (e.ctrlKey || e.metaKey || e.altKey || typingInAField(e.target)) return;
        if (e.key === "Escape") { closeNoScripts(); }
        else if (["Tab", "Enter", " "].includes(e.key) && nofsEl.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // 1.46: Esc closes an open sheet (the editor, the settings), unless a
      // field in it is being typed in (the preset name's own Esc cancels it).
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && sheetOpen() && !typingInAField(e.target)) {
        closeSheets();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!hotkeysOn || !hotkeysAllowed) return;
      // Another plugin already consumed this key (QuickTools' rating panel
      // takes digits, including 0).
      if (e.defaultPrevented) return;
      // 1.43: Alt combinations, and only these: quick slots in Manual mode,
      // the Goon keys while Goon mode runs (goonKeyAction decides, tested).
      // A plain key never reaches them, so E, \, [, ], 0 are as before.
      // 1.44: while Goon runs the digits are its pads (1..pad count).
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (!byId(`${PLUGIN_ID}-toolbar`)) return;
        const act = goonKeyAction(e, { manualOn, goonOn, typing: typingInAField(e.target),
          owned: document.documentElement.hasAttribute("data-owns-keys"), padCount: goonSet.padCount });
        if (!act) return;
        e.preventDefault();
        e.stopPropagation();
        if (act === "repeat") return;
        const m = /^(slot|assign|pad|padset):(\d)$/.exec(act);
        if (!m) goonDo(act);
        else if (m[1] === "slot") switchToSlot(+m[2]);
        else if (m[1] === "assign") assignSlot(+m[2]);
        else if (m[1] === "pad") goonPadDown(+m[2]);
        else goonPadFromPreset(+m[2]);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (typingInAField(e.target)) return;
      if (!byId(`${PLUGIN_ID}-toolbar`)) return;
      const act = plainKeyAction(e);
      if (!act) return;
      // A held key repeats. E and \ are toggles, so a held E flipped the
      // device between muted and live and could end up live; they act once.
      // [ and ] nudge, where holding is the point, and 0 only ever stops,
      // which must never be filtered.
      if (e.repeat && (act === "mute" || act === "manual")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Stop works from any tab as it is (a kill switch); the rest asks to drive.
      if (!isOwner && act !== "stop") tryTakeover("hotkey");

      switch (act) {
        case "mute":   setOutput(!outputOn);  break;
        case "manual": setManual(!manualOn);  break;
        case "down":   nudgeManual(-5);       break;
        case "up":     nudgeManual(+5);       break;
        case "stop":   stopAll();             break;
        default:       return;
      }
      e.preventDefault();
      e.stopPropagation();
    }, true);
    // 1.44: letting go of a pad's digit ends its hold (it then finishes
    // its length); losing focus lets go of every held pad.
    document.addEventListener("keyup", (e) => {
      const act = goonKeyUp(e, { goonOn });
      if (act) goonPadUp(+act.split(":")[1]);
    }, true);
    window.addEventListener("blur", () => { if (goonOn) goonReleaseAll(); });
    // 1.43: Alt + wheel anywhere while Goon mode runs, one level up or down
    // (goonWheel spaces the steps). The page does not scroll or zoom then;
    // at any other time the wheel is left alone. The pad has its own.
    window.addEventListener("wheel", (e) => {
      if (!goonOn || !e.altKey || e.ctrlKey || e.metaKey) return;
      if (!hotkeysOn || !hotkeysAllowed) return;
      if (document.documentElement.hasAttribute("data-owns-keys")) return;
      if (goonPadEl && e.target instanceof Node && goonPadEl.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      padWheel(e);
    }, { capture: true, passive: false });
    log("Hotkeys installed: E, \\ [ ] (- =), 0 Stop, Alt+1..4, Goon Alt+W/A/Q, Alt+1..8 pads and Alt + wheel", "debug");
  }

  function init() {
    initDone = true;
    installHotkeys();
    log(`Plugin initialized (backend: ${BACKEND_URL})`);
    loadSettingsFromStorage();
    scriptDefaults = readScriptValues();
    // Off in this browser: no stores, no socket, no backend task until the
    // pill turns it on (goOn). The pill itself comes from onSceneLoad.
    if (pluginOff) log("Off in this browser (the pill under the player turns it on)");
    else {
      loadStores();
      connectBackend();
    }
    watchNavigation();
    const sceneId = getSceneIdFromUrl();
    if (sceneId) {
      lastSceneId = sceneId;
      onSceneLoad(sceneId);
    }
  }

  // Pure parts for scripts/test_intifacesync.js; the page never sets this.
  if (window.__INTIFACESYNC_TEST__) {
    window.__IntifaceSyncTest = { suiteData, DATA_KEYS,
      readPrefs, offPlan, barState,
      parseFavStore, favouriteFor, rememberFav, forgetFav, cleanPattern, samePattern,
      groupCounts, scopeFilter, noScriptsUrl, NOSERVER_RETRY_MS,
      parseStore, slotNames, setSlot, renameInSlots, goonKeyAction, goonKeyUp, goonWheel, rampStep, GOON_KEYS, GOON_KEY_LABEL,
      GOON_UP_PER_S, GOON_PAD_UP_PER_S, GOON_DOWN_PER_S, GOON_TICK_MS, GOON_SEND_MS, GOON_WHEEL_MS, DEFAULT_SLOTS,
      // Goon mode 2 (1.44)
      cleanGoon2, g2PadEntry, g2PadInfo, g2SetPad, g2Peak, g2Rest, g2Init, g2Step, g2Event, g2PadPress, g2PadRelease,
      g2Restyle, g2Output, g2Sent, g2Readout, g2Preview, g2Bands, g2LearnText, g2StagePattern, g2RhythmPattern,
      g2HitsMax, g2StageAt, g2Graph, G2_FLAVOURS, G2_FLAVOUR_IDS, G2_PAD_DEFAULTS, G2_STYLES, G2_PACES, G2_TIERS,
      G2_PLAN_S, G2_EDGE_MAX_S, G2_FLOOR, G2_PAD_GAP_MS, G2_DOUBLE_MS, G2_PACE_UP_MAX, G2_BPM_MAX, G2_MAX_HITS,
      PAD_MIN, PAD_MAX, PAD_DEFAULT,
      // 1.45: the phase 1 fixes
      plainKeyAction, toastSpot, fsPillState, askInFlight, ASK_WAIT_MS,
      // 1.46: the redesign
      pillState, strengthView, strengthToLevel, macroPos, macroApply, foldDue, connRows, slotsToOrder, syncSlots, movePreset,
      versionNum, DECK_FOLD_MS, MACRO_BUILD_MAX, SLOT_COUNT, readPrefsDefaultFold: () => readPrefs(null).fold,
      // 1.47: buzzes with silence between
      g2BaseRhythm, g2BaseList, g2BaseNote, g2BuzzPattern, g2SeedFor, g2Finish, g2Gen, g2GenRun, g2Train, g2CmdBars, g2AheadBuzzes,
      depthWarning, G2_BUZZ_SPECS, G2_BASE_DEFAULT, G2_BASE_NAME, G2_BUZZ_MIN_MS, G2_BUZZ_MAX_MS, G2_BUZZ_GAP_MS,
      // 1.49: pause hold, Tidal, the pad's drag, the fold, the backend from the player
      pauseHoldDue, PAUSE_BUFFER_MS, tidalWire, tidalGap, wireShape, TIDAL, TIDAL_INNER_MS, TIDAL_HOLD_MS, G2_BASE_TIDAL, G2_TIDAL_LABEL,
      g2TidalRhythm, padDragFrom, padDragMove, PAD_DRAG_PX, foldTyping, BACKEND_ARM_MS, MANUAL_SHAPES,
      // 1.50: keys on hover only, the compact deck, the level control, the sketches
      g2Sketch, g2YMax, g2BaseShort, levelControl, G2_MOVE_TIPS, GOON_END_TIP, G2_STYLE_SHORT, G2_DECK_PAST_S,
      // for a browser harness (no socket: sendMsg returns before sending)
      dom: { loadSettingsFromStorage, saveSettingsToStorage, toggleEditor, toggleDeck, toggleSettingsPop, chooseMode, currentMode, setStrength, strengthNow, applyMacro, moveCard, goonStart, goonStop, goonDo, switchToSlot, assignSlot, installHotkeys, stopAll, nudgeManual, setOutput, goonTick, updateFsPill,
        goonPadDown, goonPadUp, goonLevel, goonSetStyle, goonSetPadCount, goonAssignPad, goonOnEcho, updateGoonUI, goonSetBase, goonSend,
        // 1.48: the SPA navigation path
        onUrlChange, routeTick, handleBackendMessage, autoManualCheck, autoManualSettle, goOff,
        // 1.49
        refreshPauseHold, backendCtl, deckFoldCheck, saveTidalPreset, sendManual, setManual, goonPersistNow: () => persistGoonSoon(),
        showPadWhole, renderDeckCards, buildToolbar, updateDeck,
        setState: (o) => {
          if ("manualOn" in o) manualOn = o.manualOn;
          if ("isOwner" in o) isOwner = o.isOwner;
          if ("backendVersion" in o) { backendStatusSeen = true; statusData = { ...statusData, version: o.backendVersion }; }
          if ("ceiling" in o) manualCeiling = o.ceiling;
          if ("manualLevel" in o) manualLevel = o.manualLevel;
          if ("scriptLevel" in o) scriptLevel = o.scriptLevel;
          if ("strokeMax" in o) strokeMax = o.strokeMax;
          if ("pattern" in o) assignPattern(cleanPattern(o.pattern));
          if ("legacy" in o) legacyBackend = o.legacy;
          if ("goonOn" in o) goonOn = o.goonOn;
          if ("outputOn" in o) outputOn = o.outputOn;
          if ("scalarStep" in o) scalarStep = o.scalarStep;
          if ("goonSt" in o) goonSt = o.goonSt;
          if (o.store) { presetStore = parseStore(o.store); goonSet = cleanGoon2(presetStore.goon2); }
          if ("ws" in o) { ws = o.ws; wsReady = !!o.ws; }
          if ("autoManualActive" in o) autoManualActive = o.autoManualActive;
          if ("sceneHasNoScript" in o) sceneHasNoScript = o.sceneHasNoScript;
          if ("lastSceneId" in o) { lastSceneId = o.lastSceneId; currentSceneId = o.lastSceneId; }
          if ("lastPath" in o) lastPath = o.lastPath;
          if ("videoEl" in o) videoEl = o.videoEl;
          if (o.status) statusData = { ...statusData, ...o.status };
          if (o.prefs) prefs = { ...prefs, ...o.prefs };
          if (o.deck) { deckEl = o.deck.el; deckOpen = !!o.deck.open; deckMoveAt = o.deck.moveAt || 0; deckPointer = o.deck.pointer || "mouse"; deckPinned = !!o.deck.pinned; }
          if ("bufferingSince" in o) bufferingSince = o.bufferingSince;
          if ("pauseZeroSent" in o) pauseZeroSent = o.pauseZeroSent;
          if ("driverInfo" in o) driverInfo = o.driverInfo;
          if ("pluginOff" in o) pluginOff = o.pluginOff;
        },
        get: () => ({ goonOn, goonSt, goonSet, ceilOverride, patternOverride, manualCeiling, presetStore, goonHist, PLUGIN_VERSION, goonSim, goonCmds,
                      manualOn, manualLevel, scriptLevel, outputOn, haltHeld, autoManualVeto, pattern: currentPattern(),
                      master: masterNow(), deckOpen, prefs, autoManualActive, padEl: goonPadEl, currentSceneId, lastSceneId,
                      pauseHold, goonSource, backendCtlStep, backendCtlArm, deckEl, goonUi }) },
    };
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
