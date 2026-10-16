/**
 * Screen-reader announcements.
 *
 * Tuning a channel changes the corner video and the banner but moves no focus,
 * so without a live region the change is silent to a screen reader.
 */

import { el } from './dom.js';

export function createAnnouncer() {
    const region = el('div', {
        class: 'tvguide-sr-only',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true'
    });

    let lastMessage = null;

    return {
        element: region,

        announce(message) {
            if (!message) return;
            // Assistive tech ignores an unchanged text node, so repeat
            // announcements need a nudge to be re-read.
            region.textContent = message === lastMessage ? `${message} ` : message;
            lastMessage = message;
        }
    };
}

/**
 * Keep Tab inside the overlay while it is open.
 *
 * @returns {function} teardown
 */
export function trapFocus(container, { document: doc = document } = {}) {
    const FOCUSABLE = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'video[controls]',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    const previouslyFocused = doc.activeElement;

    function onKeydown(event) {
        if (event.key !== 'Tab') return;

        const focusable = Array.from(container.querySelectorAll(FOCUSABLE)).filter(
            (node) => node.offsetParent !== null || node === doc.activeElement
        );
        if (focusable.length === 0) {
            event.preventDefault();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && doc.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    container.addEventListener('keydown', onKeydown);

    return function release() {
        container.removeEventListener('keydown', onKeydown);
        // Returning focus is what makes the overlay feel like a dialog rather
        // than a navigation.
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
            previouslyFocused.focus();
        }
    };
}
