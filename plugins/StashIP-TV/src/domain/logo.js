/**
 * Channel badge resolution.
 *
 * Stash never returns a bare null for a missing image -- it serves a generic
 * placeholder with `?default=true` on the query string. Rendering that would
 * give half the guide the same grey square, so a default image is treated as
 * no image and the channel falls back to initials on a stable colour.
 */

import { monogram } from './format.js';

/** True for Stash's stand-in image rather than real artwork. */
export function isDefaultImage(url) {
    if (typeof url !== 'string' || url === '') return true;
    return /[?&]default=true(&|$)/.test(url);
}

/**
 * @returns {{type: 'image', url: string} | {type: 'monogram', initials: string, hue: number}}
 */
export function resolveLogo(url, name) {
    if (isDefaultImage(url)) {
        return { type: 'monogram', ...monogram(name) };
    }
    return { type: 'image', url };
}
