/**
 * Keyboard control for the guide.
 *
 * Key handling is split in two: `mapKey` is a pure key -> intent lookup, and
 * the handler turns an intent into dispatches. That keeps the keymap itself
 * trivially testable and free of store wiring.
 *
 * Follows the WAI-ARIA grid pattern: arrows move a roving focus, Enter acts on
 * the focused cell, Escape leaves.
 */

import { Events } from '../state/actions.js';
import { windowMs, windowEndMs } from '../state/selectors.js';
import { surfChannel } from './channelSurf.js';

export const Intents = {
    TIME_PREV: 'TIME_PREV',
    TIME_NEXT: 'TIME_NEXT',
    CHANNEL_PREV: 'CHANNEL_PREV',
    CHANNEL_NEXT: 'CHANNEL_NEXT',
    PAGE_PREV: 'PAGE_PREV',
    PAGE_NEXT: 'PAGE_NEXT',
    WINDOW_START: 'WINDOW_START',
    WINDOW_END: 'WINDOW_END',
    GO_NOW: 'GO_NOW',
    TUNE: 'TUNE',
    EXPAND: 'EXPAND',
    MUTE: 'MUTE',
    MANAGE: 'MANAGE',
    CLOSE: 'CLOSE',
    HELP: 'HELP'
};

/** @returns {string|null} the intent for a key event, or null to let it pass. */
export function mapKey(event) {
    switch (event.key) {
        case 'ArrowLeft':
            return Intents.TIME_PREV;
        case 'ArrowRight':
            return Intents.TIME_NEXT;
        case 'ArrowUp':
            return Intents.CHANNEL_PREV;
        case 'ArrowDown':
            return Intents.CHANNEL_NEXT;
        case 'PageUp':
            return Intents.PAGE_PREV;
        case 'PageDown':
            return Intents.PAGE_NEXT;
        case 'Home':
            return Intents.WINDOW_START;
        case 'End':
            return Intents.WINDOW_END;
        case 'Enter':
            return event.shiftKey ? Intents.EXPAND : Intents.TUNE;
        case ' ':
        case 'Spacebar':
            return Intents.TUNE;
        case 'Escape':
            return Intents.CLOSE;
        default:
            break;
    }

    switch (event.key.toLowerCase()) {
        case 'n':
            return Intents.GO_NOW;
        case 'e':
            return Intents.EXPAND;
        case 'm':
            return Intents.MUTE;
        case 'c':
            return Intents.MANAGE;
        case '?':
            return Intents.HELP;
        default:
            return null;
    }
}

/** Typing in a field must never be swallowed as a guide shortcut. */
export function isTextEntry(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Controls that interpret arrow keys themselves.
 *
 * This handler runs in the capture phase and stops propagation on the keys it
 * owns, so without this check it swallows arrows before a focused separator or
 * slider can act on them -- which is exactly what stopped the channel-column
 * resizer from working.
 */
const SELF_MANAGED_ROLES = ['separator', 'slider', 'spinbutton', 'textbox'];

export function handlesOwnKeys(target) {
    if (!target) return false;
    if (isTextEntry(target)) return true;
    const role = typeof target.getAttribute === 'function' ? target.getAttribute('role') : null;
    return SELF_MANAGED_ROLES.includes(role);
}

export function createKeyboardHandler({ store, onClose, onHelp }) {
    return function handleKeydown(event) {
        const state = store.getState();
        if (!state.open) return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (handlesOwnKeys(event.target)) return;

        const intent = mapKey(event);
        if (!intent) return;
        // Let the disclosure button retain native Enter/Space activation.
        if (event.target?.closest?.('.tvguide-show-more') && ['Enter', ' ', 'Spacebar'].includes(event.key)) return;

        // While the manager is open it owns the keyboard: it is full of text
        // fields, and guide shortcuts would fight them. Escape steps back out.
        if (state.managerOpen) {
            if (intent !== Intents.CLOSE) return;
            event.preventDefault();
            store.dispatch({ type: Events.MANAGER_CLOSE });
            return;
        }

        if (state.playerMode === 'fullscreen' || event.target?.closest?.('.tvguide-player-stage')) {
            if (['ArrowLeft', 'ArrowRight', ' ', 'Spacebar'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                // Host shortcuts can also listen on document in capture phase.
                event.stopImmediatePropagation?.();
                if (event.repeat) return;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    surfChannel(store, event.key === 'ArrowRight' ? 1 : -1, { scrollIntoView: true });
                } else {
                    store.dispatch({ type: Events.SET_VIEWER_PAUSED, paused: !state.viewerPaused });
                }
                return;
            }
            // Enter still activates focused player buttons.
            if (intent !== Intents.CLOSE && intent !== Intents.MUTE) return;
        }

        // Only claim keys we actually acted on, so browser shortcuts survive.
        event.preventDefault();
        event.stopPropagation();

        const focusedChannelId = state.focus?.channelId;

        switch (intent) {
            case Intents.TIME_PREV:
                store.dispatch({ type: Events.MOVE_FOCUS, axis: 'time', delta: -1 });
                return;
            case Intents.TIME_NEXT:
                store.dispatch({ type: Events.MOVE_FOCUS, axis: 'time', delta: 1 });
                return;
            case Intents.CHANNEL_PREV:
                store.dispatch({ type: Events.MOVE_FOCUS, axis: 'channel', delta: -1 });
                return;
            case Intents.CHANNEL_NEXT:
                store.dispatch({ type: Events.MOVE_FOCUS, axis: 'channel', delta: 1 });
                return;
            case Intents.PAGE_PREV:
                store.dispatch({ type: Events.PAN, deltaMs: -windowMs(state) });
                return;
            case Intents.PAGE_NEXT:
                store.dispatch({ type: Events.PAN, deltaMs: windowMs(state) });
                return;
            case Intents.WINDOW_START:
                if (focusedChannelId) {
                    store.dispatch({
                        type: Events.FOCUS_CELL,
                        channelId: focusedChannelId,
                        timeMs: state.windowStartMs
                    });
                }
                return;
            case Intents.WINDOW_END:
                if (focusedChannelId) {
                    store.dispatch({
                        type: Events.FOCUS_CELL,
                        channelId: focusedChannelId,
                        timeMs: windowEndMs(state) - 1
                    });
                }
                return;
            case Intents.GO_NOW:
                store.dispatch({ type: Events.GO_TO_NOW });
                if (focusedChannelId) {
                    store.dispatch({
                        type: Events.FOCUS_CELL,
                        channelId: focusedChannelId,
                        timeMs: state.nowMs
                    });
                }
                return;
            case Intents.TUNE:
                if (focusedChannelId) store.dispatch({ type: Events.TUNE, channelId: focusedChannelId });
                return;
            case Intents.EXPAND:
                // Opens the programme the details are describing, which is what
                // the Watch button on the banner does too.
                if (focusedChannelId) {
                    store.dispatch({
                        type: Events.EXPAND,
                        channelId: focusedChannelId,
                        timeMs: state.focus.timeMs
                    });
                }
                return;
            case Intents.MUTE:
                store.dispatch({ type: Events.SET_MUTED, muted: !state.muted });
                return;
            case Intents.MANAGE:
                store.dispatch({ type: Events.MANAGER_OPEN });
                return;
            case Intents.HELP:
                if (onHelp) onHelp();
                return;
            default:
                // Escape steps back out one level at a time: an enlarged player
                // returns to the corner before the guide itself closes.
                if (state.playerMode !== 'corner') {
                    store.dispatch({ type: Events.SET_PLAYER_MODE, mode: 'corner' });
                    return;
                }
                if (onClose) onClose();
        }
    };
}
