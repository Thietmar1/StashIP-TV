/**
 * The lineup: which sources become channels.
 *
 * A lineup is a list of entries, each expanding into zero or more channels via
 * its provider. Entries from different sources sit side by side, so one guide
 * can mix studio channels with tag channels and saved-filter channels.
 *
 * This is the structure the Phase 2 channel manager will read and write, so it
 * is validated defensively -- it is user-editable data that must never be able
 * to break the guide.
 */

export const KNOWN_SOURCES = ['special', 'studio', 'performer', 'tag', 'group', 'savedFilter'];

/** What each source is called in the UI. Performers are shown as "Models". */
export const SOURCE_LABELS = {
    studio: 'Studios',
    performer: 'Models',
    tag: 'Tags',
    group: 'Groups',
    savedFilter: 'Filters',
    special: 'Special'
};

/** A fresh guide starts with the four virtual channels plus every established studio. */
export const DEFAULT_LINEUP = [
    { source: 'special', minScenes: 0, ids: ['new-releases', 'recently-added', 'movies', 'shorts'] },
    { source: 'studio', minScenes: 5 }
];

function toStringList(value) {
    if (!Array.isArray(value)) return undefined;
    const out = value.map((v) => (v == null ? '' : String(v))).filter(Boolean);
    return out.length > 0 ? out : undefined;
}

function toCount(value) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Drop anything unrecognised and normalise the rest into a predictable shape. */
export function validateLineup(entries) {
    if (!Array.isArray(entries)) return [];

    return entries.reduce((out, entry) => {
        if (!entry || typeof entry !== 'object') return out;
        if (!KNOWN_SOURCES.includes(entry.source)) return out;

        const normalised = { source: entry.source, minScenes: toCount(entry.minScenes) };

        const ids = toStringList(entry.ids);
        if (ids) normalised.ids = ids;

        const names = toStringList(entry.names);
        if (names) normalised.names = names;

        out.push(normalised);
        return out;
    }, []);
}

/**
 * Read a stored lineup, falling back to the default rather than failing.
 *
 * A corrupt setting should leave the user with a working guide they can fix,
 * not an empty screen.
 */
export function parseLineup(json) {
    if (typeof json !== 'string' || json === '') return DEFAULT_LINEUP;

    let parsed;
    try {
        parsed = JSON.parse(json);
    } catch (e) {
        return DEFAULT_LINEUP;
    }

    const valid = validateLineup(parsed);
    return valid.length > 0 ? valid : DEFAULT_LINEUP;
}

export function serializeLineup(entries) {
    return JSON.stringify(entries);
}

/**
 * Channel ids are namespaced by source.
 *
 * They double as schedule seeds, so studio 12 and tag 12 must not hash to the
 * same programming.
 */
export function makeChannelId(source, id) {
    return `${source}:${id}`;
}

export function parseChannelId(channelId) {
    if (typeof channelId !== 'string') return null;
    const at = channelId.indexOf(':');
    if (at <= 0 || at === channelId.length - 1) return null;
    return { source: channelId.slice(0, at), id: channelId.slice(at + 1) };
}
