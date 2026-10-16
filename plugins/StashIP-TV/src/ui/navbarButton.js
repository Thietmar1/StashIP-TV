/**
 * The navbar entry point.
 *
 * Stash is a single-page app that re-renders its navbar on navigation, so the
 * button is (re)placed by a MutationObserver rather than mounted once -- the
 * same approach as Stash's dynamic navigation surfaces.
 */

import { el, firstMatch } from './dom.js';
import { ICONS } from './icons.js';

export const BUTTON_ID = 'tvguide-navbar-button';

/** Stash's navbar markup shifts between releases; try the likely mounts in order. */
export const MOUNT_SELECTORS = [
    '.top-nav .navbar-collapse .navbar-nav',
    '#stash-navbar .navbar-collapse .navbar-nav',
    'nav .navbar-collapse .navbar-nav',
    'nav .navbar-nav:not(.navbar-buttons)'
];

export function createNavbarButton({ onActivate }) {
    const icon = ICONS.tv();
    icon.setAttribute('class', 'svg-inline--fa fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0');
    // Match Stash's SVG sizing: explicit dimensions make the hamburger tile
    // shrink to its label instead of using the native menu icon's full height.
    icon.removeAttribute('width');
    icon.removeAttribute('height');
    // Stash renders menu actions as links. A flex link fills its column;
    // a native button instead keeps its content-based width.
    const button = el(
        'a',
        {
            id: BUTTON_ID,
            class: 'tvguide-navbar-button btn btn-primary minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center',
            href: '#tvguide',
            role: 'button',
            title: 'StashIP-TV',
            'aria-label': 'Open StashIP-TV',
            onclick: (event) => {
                event.preventDefault();
                // Use Stash's own toggle so React's expanded state stays in sync.
                button.closest('nav')?.querySelector('.navbar-toggler[aria-expanded="true"]')?.click();
                onActivate();
            },
            onkeydown: (event) => {
                if (event.key === ' ') {
                    event.preventDefault();
                    if (!event.repeat) button.click();
                }
            }
        },
        icon, el('span', {}, 'StashIP-TV')
    );
    const item = el('div', { class: 'tvguide-navbar-item nav-link col-4 col-sm-3 col-md-2 col-lg-auto' }, button);

    let observer = null;

    function place() {
        const mount = firstMatch(MOUNT_SELECTORS);
        const existing = document.getElementById(BUTTON_ID);
        if (existing && existing !== button) return;
        if (mount && item.parentElement !== mount) mount.appendChild(item);
    }

    return {
        element: button,
        place,

        start() {
            place();
            observer = new MutationObserver(place);
            observer.observe(document.body, { childList: true, subtree: true });
        },

        stop() {
            if (observer) observer.disconnect();
            observer = null;
            item.remove();
        }
    };
}
