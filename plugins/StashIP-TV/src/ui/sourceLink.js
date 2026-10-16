/**
 * Where a channel's source lives in the Stash UI.
 *
 * Confirmed against Stash v0.31.1. Saved filters have no detail page of their
 * own, so they get no link rather than a route that 404s.
 */

const ROUTES = {
    studio: 'studios',
    performer: 'performers',
    tag: 'tags',
    group: 'groups'
};

export function sourceUrl(channel) {
    const route = ROUTES[channel.source];
    if (!route) return null;
    const localId = channel.id.slice(channel.source.length + 1);
    return `/${route}/${localId}`;
}

/** Opens in a new tab so the guide keeps playing and keeps your place. */
export function openSource(channel, openFn = (url) => window.open(url, '_blank', 'noopener')) {
    const url = sourceUrl(channel);
    if (url) openFn(url);
    return url;
}
