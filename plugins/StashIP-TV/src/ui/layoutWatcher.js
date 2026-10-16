/**
 * Layout selection.
 *
 * Deliberately a media query and not touch capability: a tablet has touch but
 * also has the width to show a real grid, and plenty of laptops report touch.
 * Phones in landscape also need the list: their width grows on rotation,
 * but their short touch viewport still cannot comfortably hold the grid.
 */

import { Events } from '../state/actions.js';

export const MOBILE_QUERY = '(max-width: 767px), (max-height: 500px) and (pointer: coarse)';

export function layoutFor(matches) {
    return matches ? 'list' : 'grid';
}

/**
 * @returns {function} teardown
 */
export function watchLayout({ store, matchMediaFn }) {
    const apply = (matches) =>
        store.dispatch({ type: Events.LAYOUT_CHANGED, layout: layoutFor(matches) });

    // Without matchMedia there is no way to tell, so assume the desktop grid
    // rather than letting one missing API stop the guide from starting at all.
    const mql = typeof matchMediaFn === 'function' ? matchMediaFn(MOBILE_QUERY) : null;
    if (!mql) {
        apply(false);
        return function stop() {};
    }

    apply(mql.matches);

    const onChange = (event) => apply(event.matches);

    // Safari below 14 only has the deprecated listener API.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);

    return function stop() {
        if (mql.removeEventListener) mql.removeEventListener('change', onChange);
        else mql.removeListener(onChange);
    };
}
