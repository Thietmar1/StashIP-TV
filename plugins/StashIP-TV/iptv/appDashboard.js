import { createHash } from 'node:crypto';

// Numeric IDs also work with Stash's legacy frontPageContent.savedFilterId.
// Hash the channel identity, never its mutable name/number/current programme.
export const channelFilterId = (id) => (BigInt(`0x${createHash('sha256').update(id).digest('hex').slice(0, 12)}`) + 2n).toString();
export const LIVE_FILTER_ID = '1';

function savedFilter(id, name, objectFilter, criteria) {
    return { id, name, mode: 'SCENES', object_filter: objectFilter,
        find_filter: { sort: 'title', direction: 'ASC' }, ui_options: {},
        filter: JSON.stringify({ sortby: 'title', sortdir: 'ASC', c: criteria }) };
}

// Virtual only: these are returned by the adapter and never written into the
// real Stash library. The code criterion selects a channel across programme
// changes, even when two channels have the same custom display name.
export function dashboardFilters(scenes) {
    return [savedFilter(LIVE_FILTER_ID, 'StashIP-TV Live', {}, []), ...scenes.map((scene) =>
        savedFilter(channelFilterId(scene.code), `${scene.custom_fields.tvguide_number} · ${scene.custom_fields.tvguide_channel}`,
            { code: { value: scene.code, modifier: 'EQUALS' } },
            [{ id: 'code', value: scene.code, modifier: 'EQUALS' }]))];
}

export const dashboardConfiguration = () => ({
    frontPageContent: [{ __typename: 'SavedFilter', savedFilterId: Number(LIVE_FILTER_ID) }]
});
