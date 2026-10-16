import { el } from './dom.js';

/** A channel's badge: real artwork if it has any, initials on a stable colour if not. */
export function logoBadge(channel) {
    const logo = channel.logo || { type: 'monogram', initials: '?', hue: 0 };

    if (logo.type === 'image') {
        return el('img', {
            class: 'tvguide-logo tvguide-logo-image',
            src: logo.url,
            alt: '',
            loading: 'lazy'
        });
    }

    return el(
        'span',
        {
            class: 'tvguide-logo tvguide-logo-monogram',
            'aria-hidden': 'true',
            style: { '--tvguide-logo-hue': String(logo.hue) }
        },
        logo.initials
    );
}
