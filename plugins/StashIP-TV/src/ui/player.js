/**
 * The player panel: the video plus everything wrapped around it.
 *
 * Controls sit *on* the video rather than beside it, so the picture gets the
 * width. They reveal on hover/focus on a pointer device and stay visible on
 * touch, where there is no hover to reveal them with.
 *
 * Three sizes: corner, theater (full width with the guide scrolling below), and
 * fullscreen. When iPad Safari rejects element fullscreen, the stage fills the
 * viewport with the same pseudo-fullscreen fallback Gallery Mode uses, keeping
 * the player controls available.
 */

import { el, replaceChildren } from './dom.js';
import { Events } from '../state/actions.js';
import { formatClock, formatDuration, formatRemaining } from '../domain/format.js';
import { sceneTitle } from '../api/scenes.js';
import { isDefaultImage } from '../domain/logo.js';
import * as sel from '../state/selectors.js';
import { ICONS } from './icons.js';
import { surfChannel } from './channelSurf.js';
import { createSurfTransition } from './surfTransition.js';
import { createFullscreenDebug } from './fullscreenDebug.js';
import { revealControlsOnInteraction } from './revealControls.js';

export function createPlayer({ store, viewer }) {
    const bodyLockClass = 'stash-tvguide-active';
    let pseudoFullscreen = false;
    let fullscreenRequestGeneration = 0;
    let destroyed = false;
    let nativeFullscreenBodyLock = null;
    let nativeFullscreenPending = false;
    let fullscreenWanted = false;
    let renderedControls = null;
    const spinner = el('div', { class: 'tvguide-spinner', 'aria-hidden': 'true' });
    const playbackError = el('div', { class: 'tvguide-playback-error', role: 'status', hidden: true });
    const playbackErrorText = document.createTextNode('');
    playbackError.appendChild(playbackErrorText);

    const playPause = controlButton('tvguide-play', () =>
        store.dispatch({
            type: Events.SET_VIEWER_PAUSED,
            paused: !store.getState().viewerPaused
        }),
        ['pause', 'play']
    );

    const mute = controlButton('tvguide-mute', () =>
        store.dispatch({ type: Events.SET_MUTED, muted: !store.getState().muted }),
        ['muted', 'unmuted']
    );

    const theater = controlButton('tvguide-theater', () => cycleMode('theater'), ['theater']);
    const fullscreen = controlButton('tvguide-fullscreen', () => cycleMode('fullscreen'), ['fullscreen', 'exitFullscreen']);

    const controls = el(
        'div',
        { class: 'tvguide-player-controls' },
        playPause,
        mute,
        el('span', { class: 'tvguide-player-spacer' }),
        theater,
        fullscreen
    );

    const channelInfo = el('div', { class: 'tvguide-channel-info', hidden: true });
    revealControlsOnInteraction(channelInfo);
    let infoResize = null;
    const infoResizer = el('button', {
        class: 'tvguide-channel-info-resizer', type: 'button',
        'aria-label': 'Resize channel info',
        title: 'Drag to resize; arrow keys adjust size',
        onclick: (event) => event.stopPropagation()
    });
    const channelLabel = el('div', { class: 'tvguide-channel-info-name' });
    const programLabel = el('div', { class: 'tvguide-channel-info-program' });
    const timeLabel = el('div', { class: 'tvguide-channel-info-time', hidden: true });
    const minimize = el('button', {
        class: 'tvguide-channel-info-toggle', type: 'button',
        onclick: () => {
            store.dispatch({ type: Events.TOGGLE_CHANNEL_INFO });
            showControls();
        }
    });
    const minimizeText = document.createTextNode('');
    minimize.appendChild(minimizeText);
    const performerLabel = el('div', { class: 'tvguide-channel-info-performers', hidden: true });
    const studioLogo = el('img', { class: 'tvguide-channel-info-studio', hidden: true, alt: '' });
    studioLogo.addEventListener('error', () => { studioLogo.hidden = true; });
    const descriptionLabel = el('div', { class: 'tvguide-channel-info-description', hidden: true });
    const infoDetails = el('div', { class: 'tvguide-channel-info-details' },
        programLabel, timeLabel, performerLabel, descriptionLabel);
    channelInfo.append(
        el('div', { class: 'tvguide-channel-info-heading' }, studioLogo, channelLabel, minimize),
        infoDetails, infoResizer
    );
    // Keep descendants connected when updating text inside native fullscreen.
    const channelText = document.createTextNode('');
    const programText = document.createTextNode('');
    const descriptionText = document.createTextNode('');
    const performerText = document.createTextNode('');
    const timeText = document.createTextNode('');
    channelLabel.appendChild(channelText);
    programLabel.appendChild(programText);
    descriptionLabel.appendChild(descriptionText);
    performerLabel.appendChild(performerText);
    timeLabel.appendChild(timeText);
    // Keep the complete description so enlarging the overlay can reveal more.
    // Only the line clamp changes; fullscreen descendants stay connected.
    function fitDescription() {
        if (channelInfo.hidden || infoDetails.hidden) return;
        let lines = 3;
        if (channelInfo.style.getPropertyValue('--tvguide-info-height')) {
            const box = channelInfo.getBoundingClientRect();
            const lastMetadata = !performerLabel.hidden ? performerLabel : !timeLabel.hidden ? timeLabel : programLabel;
            const bottom = lastMetadata.getBoundingClientRect().bottom;
            const style = getComputedStyle(descriptionLabel);
            const lineHeight = parseFloat(style.lineHeight) || 25.2;
            const margin = parseFloat(style.marginTop) || 8;
            const padding = parseFloat(getComputedStyle(channelInfo).paddingBottom) || 16;
            lines = Math.max(0, Math.floor((box.bottom - padding - bottom - margin) / lineHeight));
        }
        descriptionLabel.hidden = !descriptionText.data || lines === 0;
        descriptionLabel.style.setProperty('--tvguide-description-lines', String(Math.max(1, lines)));
    }
    const infoSizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(fitDescription) : null;
    [channelInfo, channelLabel, programLabel, timeLabel, performerLabel, studioLogo].forEach((node) => infoSizeObserver?.observe(node));
    const stage = el('div', {
        class: 'tvguide-player-stage', tabindex: '0',
        'aria-label': 'Player: left and right change channels; space plays or pauses'
    }, viewer.element, spinner, controls, channelInfo, playbackError);
    const surfTransition = createSurfTransition(stage, viewer.element);
    const fullscreenDebug = createFullscreenDebug({ stage, video: viewer.element, getState: store.getState });
    // Available from DevTools only; diagnostics do nothing until start() is called.
    stage.tvguideFullscreenDebug = fullscreenDebug;
    const surfWithAnimation = (direction) => surfChannel(store, direction, { beforeTune: () => surfTransition.play(direction) });
    let infoChannelId = null;
    let infoWasFullscreen = false;
    let infoWasPaused = false;

    stage.addEventListener('pointerdown', (event) => {
        if (!event.target.closest('button, input, select, textarea')) stage.focus({ preventScroll: true });
    });

    // One wheel burst / swipe changes one channel, including trackpad momentum.
    let wheelTime = -Infinity;
    let wheelDistance = 0;
    let wheelUsed = false;
    let touch = null;
    const canSurf = () => !destroyed && !infoResize && store.getState().open
        && !store.getState().managerOpen && isFullscreenActive();
    const onWheel = (event) => {
        if (!canSurf() || event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
        event.preventDefault();
        const now = Date.now();
        if (now - wheelTime > 250) { wheelDistance = 0; wheelUsed = false; }
        wheelTime = now;
        if (wheelUsed) return;
        wheelDistance += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight || 800 : 1);
        if (Math.abs(wheelDistance) < 60) return;
        wheelUsed = true;
        surfWithAnimation(wheelDistance > 0 ? 1 : -1);
    };
    const onTouchStart = (event) => {
        touch = canSurf() && event.touches.length === 1
            && !event.target.closest('button, input, select, textarea')
            ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    };
    const onTouchMove = (event) => {
        if (!touch || !canSurf()) return;
        if (event.touches.length !== 1) { touch = null; return; }
        const dx = event.touches[0].clientX - touch.x;
        const dy = event.touches[0].clientY - touch.y;
        if (Math.abs(dy) <= Math.abs(dx) || Math.abs(dy) < 60) return;
        event.preventDefault();
        touch = null;
        surfWithAnimation(dy < 0 ? 1 : -1);
    };
    const endTouch = () => { touch = null; };
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    stage.addEventListener('touchend', endTouch);
    stage.addEventListener('touchcancel', endTouch);
    const progress = el('div', { class: 'tvguide-player-progress' });
    const caption = el('p', { class: 'tvguide-player-caption' });

    /**
     * Resize grip, at the bottom-left corner -- the only free corner, since the
     * player is anchored to the top right of the header.
     *
     * One number drives the whole box: the height follows from the width in CSS
     * so the picture keeps its shape. Dragging out along either axis grows it,
     * whichever moved further, so a diagonal drag does the obvious thing.
     */
    const resizer = el('div', {
        class: 'tvguide-player-resizer',
        role: 'separator',
        tabindex: '0',
        'aria-label': 'Resize the player',
        'aria-orientation': 'horizontal',
        onkeydown: onResizerKey
    });

    // Keep the grip outside the stage's clipping and fullscreen boundary, but
    // anchor it to the picture rather than the taller header-sized panel.
    const picture = el('div', { class: 'tvguide-player-picture' }, stage, resizer);
    revealControlsOnInteraction(picture, { ignore: (target) => Boolean(target.closest('.tvguide-channel-info')) });
    const root = el('div', { class: 'tvguide-player' }, picture, progress, caption);

    function sizeChannelInfo(width, height) {
        channelInfo.classList.add('is-resized');
        const box = channelInfo.getBoundingClientRect();
        const bounds = stage.getBoundingClientRect();
        const maxWidth = Math.max(0, bounds.right - box.left - 24);
        const maxHeight = Math.max(0, box.bottom - bounds.top - 24);
        channelInfo.style.setProperty('--tvguide-info-width', `${Math.min(maxWidth, Math.max(280, width))}px`);
        channelInfo.style.setProperty('--tvguide-info-height', `${Math.min(maxHeight, Math.max(160, height))}px`);
        fitDescription();
    }
    const moveInfoResize = (event) => {
        if (!infoResize || event.pointerId !== infoResize.pointerId) return;
        sizeChannelInfo(infoResize.width + event.clientX - infoResize.x,
            infoResize.height + infoResize.y - event.clientY);
    };
    const endInfoResize = (event) => {
        if (!infoResize || (event && event.pointerId !== infoResize.pointerId)) return;
        infoResize = null;
        window.removeEventListener('pointermove', moveInfoResize);
        window.removeEventListener('pointerup', endInfoResize);
        window.removeEventListener('pointercancel', endInfoResize);
        window.removeEventListener('blur', cancelInfoResize);
        if (!destroyed) scheduleHide();
    };
    const cancelInfoResize = () => endInfoResize();
    infoResizer.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || infoResize) return;
        event.preventDefault();
        event.stopPropagation();
        const box = channelInfo.getBoundingClientRect();
        infoResize = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: box.width, height: box.height };
        showControls();
        window.addEventListener('pointermove', moveInfoResize);
        window.addEventListener('pointerup', endInfoResize);
        window.addEventListener('pointercancel', endInfoResize);
        window.addEventListener('blur', cancelInfoResize);
    });
    infoResizer.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const box = channelInfo.getBoundingClientRect();
        const step = event.shiftKey ? 40 : 10;
        sizeChannelInfo(box.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
            box.height + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0));
        showControls();
    });

    resizer.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        const startWidth = store.getState().playerWidthPx;

        const onMove = (move) => {
            // Out is bigger on both axes, and the picture is 16:9, so a vertical
            // drag converts to the width that produces it. Whichever axis moved
            // *further* wins -- comparing the signed values instead would mean
            // a horizontal drag inwards could never shrink anything, since the
            // untouched axis always reads as zero.
            const byX = startX - move.clientX;
            const byY = (move.clientY - startY) * (16 / 9);
            const grown = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
            store.dispatch({ type: Events.SET_PLAYER_WIDTH, px: startWidth + grown });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });

    function onResizerKey(event) {
        const step = event.shiftKey ? 40 : 10;
        const current = store.getState().playerWidthPx;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            store.dispatch({ type: Events.SET_PLAYER_WIDTH, px: current + step });
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            store.dispatch({ type: Events.SET_PLAYER_WIDTH, px: current - step });
        }
    }

    viewer.subscribe((event) => {
        // The spinner is about the stream, not about being paused -- a paused
        // player is not loading.
        root.classList.toggle('is-loading', event.type === 'loading');
        if (event.type === 'error') {
            playbackErrorText.data = event.message;
            playbackError.hidden = false;
        } else if (event.type === 'loading' || event.type === 'playing') {
            playbackError.hidden = true;
        }
    });

    function controlButton(className, onclick, icons) {
        const button = el('button', { class: `tvguide-player-button ${className}`, type: 'button', onclick });
        // Mount both states once. Updating a control never removes descendants
        // from the fullscreen stage or replaces the focused button.
        for (const name of icons) {
            const svg = ICONS[name]();
            svg.dataset.icon = name;
            svg.style.display = 'none';
            button.appendChild(svg);
        }
        return button;
    }

    function setControlIcon(button, name) {
        if (button.dataset.icon === name) return;
        button.dataset.icon = name;
        for (const svg of button.children) {
            svg.style.display = svg.dataset.icon === name ? '' : 'none';
        }
    }

    /** Toggle a mode; exiting fullscreen restores the normal mode it replaced. */
    function cycleMode(mode) {
        const state = store.getState();
        const current = state.playerMode;
        const exitMode = mode === 'fullscreen' ? state.fullscreenReturnMode || 'corner' : 'corner';
        store.dispatch({ type: Events.SET_PLAYER_MODE, mode: current === mode ? exitMode : mode });
    }

    /**
     * Fullscreen targets the *stage*, not the whole panel.
     *
     * Keep this element and its ancestors connected for the whole session.
     * Fullscreen can end when its target is removed, even if reinserted later.
     */
    function fullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function isFullscreen() {
        return fullscreenElement() === stage;
    }

    function isFullscreenActive() {
        return isFullscreen() || pseudoFullscreen;
    }

    function isAppleTouchDevice() {
        const userAgent = navigator.userAgent || '';
        const platform = navigator.platform || '';
        return /iP(hone|od|ad)/.test(userAgent)
            || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function syncScrollLock() {
        // Native fullscreen owns the viewport. Changing document scrolling at
        // that transition is unnecessary and can make Safari leave fullscreen.
        if (isFullscreen() && !pseudoFullscreen) {
            [document.documentElement, document.body].filter(Boolean).forEach((element) => {
                element.classList.remove('stash-tvguide-scroll-lock', 'stash-tvguide-scroll-soft-lock');
            });
            return;
        }
        const locked = isFullscreenActive();
        const soft = locked && isAppleTouchDevice();
        [document.documentElement, document.body].filter(Boolean).forEach((element) => {
            element.classList.toggle('stash-tvguide-scroll-lock', locked && !soft);
            element.classList.toggle('stash-tvguide-scroll-soft-lock', soft);
        });
    }

    function setPseudoFullscreen(on) {
        pseudoFullscreen = on;
        stage.classList.toggle('tvguide-pseudo-fullscreen', on);
        syncScrollLock();
    }

    function releaseNativeFullscreenBodyLock() {
        if (nativeFullscreenBodyLock || !document.body) return;
        nativeFullscreenBodyLock = {
            active: document.body.classList.contains(bodyLockClass),
            top: document.body.style.top
        };
        document.body.classList.remove(bodyLockClass);
        document.body.style.top = '';
    }

    function restoreNativeFullscreenBodyLock() {
        if (!nativeFullscreenBodyLock || !document.body) return;
        document.body.classList.toggle(bodyLockClass, nativeFullscreenBodyLock.active);
        document.body.style.top = nativeFullscreenBodyLock.top;
        nativeFullscreenBodyLock = null;
    }

    /**
     * Element fullscreen, prefixed or not, with a pseudo-fullscreen fallback.
     *
     * Safari can reject fullscreening a div even though it exposes the API.
     * The video's own fullscreen would hide StashIP-TV's controls and can end
     * when the stream reloads, so use the fixed-viewport fallback instead.
     */
    function applyFullscreen(on) {
        if (!on) surfTransition.cancel();
        fullscreenWanted = on;
        if (on) {
            if (destroyed) return;
            stage.focus({ preventScroll: true });
            renderControls({ ...store.getState(), playerMode: 'fullscreen' });
            if (isFullscreen() || pseudoFullscreen || nativeFullscreenPending) return;
            const requestGeneration = ++fullscreenRequestGeneration;
            const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
            if (request) {
                nativeFullscreenPending = true;
                releaseNativeFullscreenBodyLock();
                try {
                    const result = request.call(stage);
                    if (result && typeof result.then === 'function') {
                        Promise.resolve(result).then(
                            () => {
                                // The user can close the player before the
                                // browser finishes its asynchronous request.
                                if (destroyed || !fullscreenWanted) {
                                    exitOwnedFullscreen();
                                    return;
                                }
                                if (!destroyed && requestGeneration === fullscreenRequestGeneration) {
                                    nativeFullscreenPending = false;
                                    syncScrollLock();
                                }
                            },
                            () => {
                                if (!destroyed && requestGeneration === fullscreenRequestGeneration) {
                                    nativeFullscreenPending = false;
                                    restoreNativeFullscreenBodyLock();
                                    setPseudoFullscreen(true);
                                }
                            }
                        );
                    }
                } catch (_) {
                    nativeFullscreenPending = false;
                    restoreNativeFullscreenBodyLock();
                    if (!destroyed && requestGeneration === fullscreenRequestGeneration) setPseudoFullscreen(true);
                }
            } else {
                setPseudoFullscreen(true);
            }
            return;
        }
        fullscreenRequestGeneration += 1;
        nativeFullscreenPending = false;
        restoreNativeFullscreenBodyLock();
        const state = store.getState();
        renderControls({ ...state, playerMode: state.playerMode === 'fullscreen' ? state.fullscreenReturnMode : state.playerMode });
        setPseudoFullscreen(false);
        exitOwnedFullscreen();
    }

    function exitOwnedFullscreen() {
        // Only exit what we opened -- exiting unconditionally would fight
        // anything else on the page that is fullscreen.
        if (!isFullscreen()) return;
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) {
            try {
                const result = exit.call(document);
                if (result && typeof result.catch === 'function') result.catch(() => {});
            } catch (_) {
                // Some prefixed implementations throw if exit is in progress.
            }
        }
    }

    const onFullscreenError = (event) => {
        // Older WebKit reports failure through an event instead of a Promise.
        if (event.target !== stage || !nativeFullscreenPending || !fullscreenWanted) return;
        fullscreenRequestGeneration += 1;
        nativeFullscreenPending = false;
        restoreNativeFullscreenBodyLock();
        setPseudoFullscreen(true);
    };

    // Let state follow the browser: pressing Esc, or the OS dropping out of
    // fullscreen, must not leave the button claiming we are still in it.
    // Safari fires only the prefixed event, and the video's own fullscreen
    // fires neither -- it reports itself through `webkitendfullscreen`.
    const onFullscreenChange = () => {
        if (isFullscreen()) nativeFullscreenPending = false;
        // A document-level event for another element (or a duplicate exit
        // event) does not mean our pending request has completed.
        if (nativeFullscreenPending) return;
        syncScrollLock();
        if (!isFullscreenActive() && store.getState().playerMode === 'fullscreen') {
            fullscreenWanted = false;
            fullscreenRequestGeneration += 1;
            restoreNativeFullscreenBodyLock();
            store.dispatch({
                type: Events.SET_PLAYER_MODE,
                mode: store.getState().fullscreenReturnMode || 'corner'
            });
        }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('fullscreenerror', onFullscreenError);
    document.addEventListener('webkitfullscreenerror', onFullscreenError);
    viewer.element.addEventListener('webkitendfullscreen', onFullscreenChange);

    /**
     * Control visibility is driven from JS rather than `@media (hover: hover)`.
     * The media query reported the wrong thing on at least one real machine and
     * left the controls permanently on screen; pointer events tell the truth.
     */
    let hideTimer = null;
    const hideNow = () => {
        root.classList.remove('is-showing-controls');
        channelInfo.hidden = true;
    };
    const scheduleHide = (delay = 3000) => {
        clearTimeout(hideTimer);
        if (infoResize) return;
        if (store.getState().playerMode === 'fullscreen' && store.getState().viewerPaused) return;
        hideTimer = setTimeout(hideNow, delay);
    };
    const showControls = () => {
        if (destroyed) return;
        root.classList.add('is-showing-controls');
        renderChannelInfo(store.getState());
        if (store.getState().playerMode === 'fullscreen') scheduleHide();
        else clearTimeout(hideTimer);
    };
    const hideControls = () => {
        scheduleHide(store.getState().playerMode === 'fullscreen' ? 3000 : 120);
    };

    function syncVisibility(state) {
        const inFullscreen = state.open && state.playerMode === 'fullscreen';
        const entering = inFullscreen && !infoWasFullscreen;
        const changed = infoChannelId !== state.tunedChannelId;
        if (entering || !state.open || (!inFullscreen && infoWasFullscreen)) {
            cancelInfoResize();
            clearTimeout(hideTimer);
            hideNow();
        }
        if (inFullscreen) {
            if (state.viewerPaused) {
                clearTimeout(hideTimer);
                root.classList.add('is-showing-controls');
            } else if (!entering && (changed || infoWasPaused)) {
                root.classList.add('is-showing-controls');
                scheduleHide();
            }
        }
        infoChannelId = state.tunedChannelId;
        infoWasFullscreen = inFullscreen;
        infoWasPaused = state.viewerPaused;
    }

    function renderControls(state) {
        if (!state.open || state.playerMode !== 'fullscreen') surfTransition.cancel();
        syncVisibility(state);
        renderChannelInfo(state);
        const signature = `${state.viewerPaused}:${state.muted}:${state.playerMode}:${state.layout}`;
        if (renderedControls === signature) return;
        renderedControls = signature;
        setControlIcon(playPause, state.viewerPaused ? 'play' : 'pause');
        playPause.setAttribute('aria-label', state.viewerPaused ? 'Play' : 'Pause');
        playPause.setAttribute('aria-pressed', state.viewerPaused ? 'true' : 'false');

        setControlIcon(mute, state.muted ? 'muted' : 'unmuted');
        mute.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
        mute.setAttribute('aria-pressed', state.muted ? 'true' : 'false');

        setControlIcon(theater, 'theater');
        theater.hidden = state.layout === 'list' || state.playerMode === 'fullscreen';
        theater.setAttribute('aria-label', 'Theater mode');
        theater.setAttribute('aria-pressed', state.playerMode === 'theater' ? 'true' : 'false');

        setControlIcon(fullscreen, state.playerMode === 'fullscreen' ? 'exitFullscreen' : 'fullscreen');
        fullscreen.setAttribute('aria-label', 'Fullscreen');
        fullscreen.setAttribute('aria-pressed', state.playerMode === 'fullscreen' ? 'true' : 'false');
    }

    function renderChannelInfo(state) {
        const fullscreen = state.open && state.playerMode === 'fullscreen';
        const channel = sel.tunedChannel(state);
        channelInfo.hidden = state.settings.guide_channel_info === false
            || !fullscreen || !channel || !root.classList.contains('is-showing-controls');
        if (!channelInfo.hidden && channel) {
            const minimized = state.channelInfoMinimized;
            channelInfo.classList.toggle('is-minimized', minimized);
            infoDetails.hidden = minimized;
            const toggleLabel = minimized ? 'Expand channel info' : 'Minimize channel info';
            minimize.setAttribute('aria-label', toggleLabel);
            minimize.title = toggleLabel;
            minimize.setAttribute('aria-expanded', String(!minimized));
            const symbol = minimized ? '+' : '−';
            if (minimizeText.data !== symbol) minimizeText.data = symbol;
            // Raw lineup numbering survives searches, collapsed groups and pins.
            const number = state.allChannels.findIndex((item) => item.id === channel.id) + 1;
            const label = `CH ${String(number).padStart(2, '0')} · ${channel.name}`;
            const program = sel.tunedProgram(state);
            const title = program ? sceneTitle(program.scene)
                : sel.poolStatus(state, channel.id) === 'error' ? 'Unable to load programming'
                : sel.poolStatus(state, channel.id) === 'ready' ? 'No programming' : 'Loading…';
            if (channelText.data !== label) channelText.data = label;
            if (programText.data !== title) programText.data = title;
            const times = program
                ? `${formatClock(program.startMs, state.settings.guide_12_hour_clock)} – ${formatClock(program.endMs, state.settings.guide_12_hour_clock)} · ${formatRemaining(program.endMs - sel.playbackNowMs(state))}`
                : '';
            timeLabel.hidden = !times;
            if (timeText.data !== times) timeText.data = times;
            const performers = (program?.scene?.performers || [])
                .map((performer) => performer?.name?.trim()).filter(Boolean).join(', ');
            performerLabel.hidden = !performers;
            if (performerText.data !== performers) performerText.data = performers;
            const studio = program?.scene?.studio;
            const logoUrl = isDefaultImage(studio?.image_path) ? null : studio.image_path;
            if (studioLogo.getAttribute('src') !== logoUrl) {
                studioLogo.hidden = !logoUrl;
                if (logoUrl) studioLogo.setAttribute('src', logoUrl);
                else studioLogo.removeAttribute('src');
            }
            studioLogo.alt = logoUrl ? (studio.name || 'Studio') : '';
            const details = (program?.scene?.details || '').replace(/\s+/g, ' ').trim();
            descriptionLabel.hidden = !details;
            if (descriptionText.data !== details) descriptionText.data = details;
            fitDescription();
        }
    }

    stage.addEventListener('mouseenter', () => {
        if (store.getState().playerMode !== 'fullscreen') showControls();
    });
    stage.addEventListener('mousemove', showControls);
    stage.addEventListener('mouseleave', hideControls);
    // Keyboard users need them too, and touch has no hover to reveal with.
    stage.addEventListener('focusin', (event) => {
        if (store.getState().playerMode !== 'fullscreen' || event.target !== stage) showControls();
    });
    stage.addEventListener('click', (event) => {
        if (!event.target.closest('button')) showControls();
    });
    stage.addEventListener('focusout', hideControls);
    stage.addEventListener('touchstart', showControls, { passive: true });

    return {
        element: root,

        setMode(mode) {
            applyFullscreen(mode === 'fullscreen');
        },

        renderControls,

        isNativeFullscreenActive() {
            return nativeFullscreenPending || isFullscreen();
        },

        destroy() {
            infoSizeObserver?.disconnect();
            cancelInfoResize();
            fullscreenDebug.stop();
            destroyed = true;
            document.removeEventListener('fullscreenchange', onFullscreenChange);
            document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
            document.removeEventListener('fullscreenerror', onFullscreenError);
            document.removeEventListener('webkitfullscreenerror', onFullscreenError);
            viewer.element.removeEventListener('webkitendfullscreen', onFullscreenChange);
            applyFullscreen(false);
            clearTimeout(hideTimer);
            stage.removeEventListener('wheel', onWheel);
            stage.removeEventListener('touchstart', onTouchStart);
            stage.removeEventListener('touchmove', onTouchMove);
            stage.removeEventListener('touchend', endTouch);
            stage.removeEventListener('touchcancel', endTouch);
        },

        render(state) {
            const channel = sel.tunedChannel(state);
            // The playback clock, not the wall clock: paused, it stops where it
            // was stopped rather than running on with the schedule.
            const program = channel && sel.tunedProgram(state);
            const scene = program?.scene;

            root.dataset.mode = state.playerMode;
            root.hidden = !state.settings.guide_autoplay;

            // SVG icons, not emoji: these inherit currentColor and size with
            // the button instead of rendering as platform artwork.
            renderControls(state);


            caption.textContent = channel
                ? `${channel.name}${scene ? ` · ${sceneTitle(scene)}` : ''}`
                : '';

            renderProgress(state, program);
        }
    };

    function renderProgress(state, program) {
        if (!program) {
            replaceChildren(progress);
            return;
        }

        const pct = Math.min(100, Math.max(0, (program.elapsedMs / program.durationMs) * 100));
        const nowMs = sel.playbackNowMs(state);

        replaceChildren(
            progress,
            el(
                'div',
                {
                    class: 'tvguide-progress',
                    role: 'progressbar',
                    'aria-valuemin': '0',
                    'aria-valuemax': '100',
                    'aria-valuenow': String(Math.round(pct)),
                    'aria-label': 'Programme progress'
                },
                el('div', { class: 'tvguide-progress-fill', style: { width: `${pct}%` } })
            ),
            el(
                'p',
                { class: 'tvguide-player-times' },
                `${formatDuration(program.elapsedMs / 1000)} / ${formatDuration(program.durationMs / 1000)}`,
                ` · ends ${formatClock(program.endMs, state.settings.guide_12_hour_clock)}`,
                ` · ${formatRemaining(program.endMs - nowMs)}`
            )
        );
    }
}
