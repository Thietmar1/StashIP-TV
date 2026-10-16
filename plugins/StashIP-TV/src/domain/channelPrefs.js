/**
 * Per-channel presentation preferences.
 *
 * Deliberately stored separately from the lineup. The lineup says *which*
 * sources become channels; prefs say how a channel is presented. Keying prefs
 * by channel id rather than by position means a rename survives toggling a
 * lineup rule off and back on -- which is exactly what a user expects, and what
 * an inline model would get wrong.
 *
 * Pure: no DOM, no storage, no I/O.
 */

// Channels are always grouped by source, so a "sort by source" mode would sort
// a group whose members all share one source -- it does nothing, and is gone.
// A stored 'source' migrates to 'name'.
export const SORT_MODES = ['name', 'sceneCount'];
export const DEFAULT_SORT = 'name';

export function migrateSort(stored) {
    return SORT_MODES.includes(stored) ? stored : DEFAULT_SORT;
}

const isPlainObject = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

function validatePref(pref) {
    if (!isPlainObject(pref)) return null;

    const out = {};

    if (typeof pref.name === 'string' && pref.name.trim()) out.name = pref.name.trim();
    if (typeof pref.logoUrl === 'string' && pref.logoUrl.trim()) out.logoUrl = pref.logoUrl.trim();
    if (pref.hidden === true) out.hidden = true;

    const cap = Number.parseInt(pref.poolCap, 10);
    if (Number.isFinite(cap) && cap > 0) out.poolCap = cap;


    // An entry that overrides nothing is noise; drop it so stored prefs stay
    // small and comparisons stay meaningful.
    return Object.keys(out).length > 0 ? out : null;
}

/** Drop anything malformed. This is user-editable data behind a UI. */
export function validatePrefs(prefs) {
    if (!isPlainObject(prefs)) return {};

    const out = {};
    for (const [channelId, pref] of Object.entries(prefs)) {
        const valid = validatePref(pref);
        if (valid) out[channelId] = valid;
    }
    return out;
}

export function parsePrefs(json) {
    if (typeof json !== 'string' || json === '') return {};
    try {
        return validatePrefs(JSON.parse(json));
    } catch (e) {
        // Corrupt prefs must not cost you the guide; you lose customisation,
        // not the channels.
        return {};
    }
}

export function serializePrefs(prefs) {
    return JSON.stringify(prefs);
}

/** Merge a change into one channel's prefs, dropping the entry if it empties. */
export function setPref(prefs, channelId, patch) {
    const merged = { ...(prefs[channelId] || {}), ...patch };

    // An explicit null/undefined/false clears a field rather than storing it.
    for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === false || value === '') delete merged[key];
    }

    const next = { ...prefs };
    const valid = validatePref(merged);
    if (valid) next[channelId] = valid;
    else delete next[channelId];

    return next;
}

export const isHidden = (prefs, channelId) => Boolean(prefs[channelId]?.hidden);

/**
 * Pin order.
 *
 * Membership means pinned; position means order. An ordered array is what makes
 * drag-reordering expressible at all -- the timestamp this replaces could only
 * ever produce pinned-at order.
 */
export function validatePinOrder(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const id of value) {
        if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export function parsePinOrder(json) {
    if (typeof json !== 'string' || json === '') return [];
    try {
        return validatePinOrder(JSON.parse(json));
    } catch (e) {
        return [];
    }
}

/**
 * Recover pins written by the previous release, which stamped a `pinnedAt`
 * timestamp on each pref instead of keeping an order.
 */
export function migratePinOrder(prefs) {
    return Object.entries(prefs || {})
        .filter(([, pref]) => pref && Number(pref.pinnedAt) > 0)
        .sort((a, b) => Number(a[1].pinnedAt) - Number(b[1].pinnedAt))
        .map(([channelId]) => channelId);
}

export const isPinned = (pinOrder, channelId) => pinOrder.includes(channelId);

export function togglePin(pinOrder, channelId) {
    return pinOrder.includes(channelId)
        ? pinOrder.filter((id) => id !== channelId)
        : [...pinOrder, channelId];
}

/** Move a pinned channel to a new index, clamped. */
export function movePin(pinOrder, channelId, toIndex) {
    const from = pinOrder.indexOf(channelId);
    if (from === -1) return pinOrder;

    const rest = pinOrder.filter((id) => id !== channelId);
    const target = Math.min(rest.length, Math.max(0, toIndex));
    return [...rest.slice(0, target), channelId, ...rest.slice(target)];
}

/** The scene cap for a channel: its own override, else the global setting. */
export function poolCapFor(prefs, channelId, defaultCap) {
    return prefs[channelId]?.poolCap || defaultCap;
}

/**
 * Apply renames, logo overrides and hiding.
 *
 * Returns new channel objects rather than mutating, so the raw resolved list
 * stays intact and prefs can be re-applied when they change.
 */
export function applyPrefs(channels, prefs) {
    const out = [];

    for (const channel of channels) {
        const pref = prefs[channel.id];
        if (pref?.hidden) continue;

        if (!pref || (!pref.name && !pref.logoUrl)) {
            out.push(channel);
            continue;
        }

        out.push({
            ...channel,
            name: pref.name || channel.name,
            logo: pref.logoUrl ? { type: 'image', url: pref.logoUrl } : channel.logo
        });
    }

    return out;
}

const byName = (a, b) => a.name.localeCompare(b.name);

export const COMPARATORS = {
    name: byName,
    // Most-stocked first; a saved filter has no count and sorts last.
    sceneCount: (a, b) => (b.sceneCount ?? -1) - (a.sceneCount ?? -1) || byName(a, b)
};

export const PINNED_GROUP = 'pinned';

/**
 * Group channels for the guide.
 *
 * Always grouped: pinned first in their manual order, then one group per source
 * with the chosen sort applied inside it. Scrolling from the last studio into
 * the tags is then something the guide can announce with a header rather than
 * something you have to infer.
 *
 * @param sourceOrder  the source order to emit groups in
 * @param collapsed    set/array of group keys that are collapsed
 * @returns {Array<{key, source, channels, collapsed, count}>}
 */
export function groupChannels(channels, { prefs = {}, pinOrder = [], sort = DEFAULT_SORT, sourceOrder = [], collapsed = [] } = {}) {
    const compare = COMPARATORS[sort] || COMPARATORS[DEFAULT_SORT];

    const visible = applyPrefs(channels, prefs);
    const byId = new Map(visible.map((c) => [c.id, c]));

    const groups = [];

    // Pinned, in the user's manual order, ignoring source.
    const pinned = pinOrder.map((id) => byId.get(id)).filter(Boolean);
    if (pinned.length > 0) {
        groups.push({
            key: PINNED_GROUP,
            source: null,
            channels: pinned,
            collapsed: collapsed.includes(PINNED_GROUP),
            count: pinned.length
        });
    }

    const pinnedIds = new Set(pinned.map((c) => c.id));
    const bySource = new Map();
    for (const channel of visible) {
        if (pinnedIds.has(channel.id)) continue;
        if (!bySource.has(channel.source)) bySource.set(channel.source, []);
        bySource.get(channel.source).push(channel);
    }

    // Emit in the caller's declared source order, then anything unrecognised,
    // so a new source type still appears rather than vanishing.
    const ordered = [...sourceOrder, ...[...bySource.keys()].filter((s) => !sourceOrder.includes(s))];

    for (const source of ordered) {
        const list = bySource.get(source);
        if (!list || list.length === 0) continue;
        groups.push({
            key: source,
            source,
            channels: list.slice().sort(compare),
            collapsed: collapsed.includes(source),
            count: list.length
        });
    }

    return groups;
}

/**
 * The flattened, collapse-aware order the guide actually shows.
 *
 * Keyboard navigation walks this, so it must skip collapsed groups entirely --
 * otherwise arrow-down lands on a row that is not on screen.
 */
export function flattenGroups(groups) {
    const out = [];
    for (const group of groups) {
        if (group.collapsed) continue;
        out.push(...group.channels);
    }
    return out;
}
