/**
 * The guide reducer.
 *
 * Pure: no DOM, no timers, no network. Everything that touches the outside
 * world leaves here as an effect. That is what lets the awkward parts -- the
 * midnight rollover, auto-advancing at a programme boundary, keyboard focus
 * movement across a grid of variable-width blocks -- be tested directly.
 */

import { Events, Effects, STORAGE_KEYS } from './actions.js';
import { mergeSceneMetadata } from '../api/sceneMetadata.js';
import { ALL_SCENES_CHANNEL_ID } from '../domain/allScenes.js';
import { createInitialState, PoolStatus } from './initialState.js';
import { buildDaySchedule, dayBucket, programAt } from '../domain/schedule.js';
import { snapToStep, clampWindowStart, HALF_HOUR_MS } from '../domain/layout.js';
import {
    PINNED_GROUP,
    groupChannels,
    flattenGroups,
    setPref,
    poolCapFor,
    togglePin,
    movePin
} from '../domain/channelPrefs.js';
import { relatedChannel } from '../domain/relatedChannel.js';
import { parseChannelId } from '../domain/lineup.js';
import { CATALOG_PAGE_SIZE, catalogCapabilities, catalogRequestKey } from './selectors.js';

/** How far ahead of the current day panning is allowed to go. */
const MAX_PAN_AHEAD_MS = 24 * 3600000;

const windowMsOf = (state) => state.settings.guide_window_hours * 3600000;

function catalogLoadEffect(state, page = 1) {
    const source = state.managerSource;
    const capabilities = catalogCapabilities(source);
    return Effects.loadCatalogPage(
        source,
        catalogRequestKey(state),
        page,
        CATALOG_PAGE_SIZE,
        state.managerSearch.trim(),
        capabilities.favorite && state.managerCatalogFavorited,
        capabilities.gender ? state.managerCatalogGender : 'all',
        state.managerSort
    );
}

function requestCatalogPage(state, page = 1) {
    const requestKey = catalogRequestKey(state);
    const entry = state.catalogRequests[requestKey] || {
        channels: [], total: 0, loadedPages: [], loadingPage: null, error: null
    };
    if (entry.loadedPages.includes(page) || entry.loadingPage === page) return { state, effects: [] };
    return {
        state: { ...state, catalogRequests: { ...state.catalogRequests, [requestKey]: { ...entry, loadingPage: page, error: null } } },
        effects: [catalogLoadEffect(state, page)]
    };
}

/**
 * Recompute the visible channel list after anything that affects it.
 *
 * Kept in state rather than derived at render time because the reducer itself
 * walks it: MOVE_FOCUS across channels has to agree with the on-screen order,
 * or arrow-down lands on the wrong row.
 *
 * Focus falls back to the first visible channel when its own row leaves the
 * screen -- it is the keyboard cursor, and MOVE_FOCUS walks this same list. The
 * tuned channel does not: collapsing a group, searching, or filtering by type
 * only changes what is *shown*, and retuning underneath the user because a row
 * scrolled out of the list is not something any of those actions asked for.
 */
function withVisibleChannels(state) {
    // The guide is always grouped, so the search box and the type filter narrow
    // the candidates before grouping rather than hiding rows afterwards.
    const query = state.guideSearch.trim().toLowerCase();
    const candidates = state.allChannels.filter((channel) => {
        // Pinned is a group in the guide, so it is a filter here too -- it just
        // selects on the pin list rather than on the channel's source.
        if (state.typeFilter === PINNED_GROUP) {
            if (!state.pinOrder.includes(channel.id)) return false;
        } else if (state.typeFilter !== 'all' && channel.source !== state.typeFilter) {
            return false;
        }
        if (query && !channel.name.toLowerCase().includes(query)) return false;
        return true;
    });

    const channelGroups = groupChannels(candidates, {
        prefs: state.prefs,
        pinOrder: state.pinOrder,
        sourceOrder: state.sourceOrder,
        collapsed: state.collapsedGroups
    });

    // Collapsed groups contribute no rows, so keyboard traversal cannot enter
    // one -- the flattened list is exactly what is on screen.
    const channels = flattenGroups(channelGroups);
    const next = { ...state, channels, channelGroups };

    const stillThere = (id) => channels.some((c) => c.id === id);
    // Hiding a channel removes it from the guide for good; collapsing a group,
    // searching, or filtering by type only stops it being drawn.
    const stillExists = (id) =>
        state.allChannels.some((c) => c.id === id) && !state.prefs[id]?.hidden;

    if (next.tunedChannelId && !stillExists(next.tunedChannelId)) {
        next.tunedChannelId = channels[0]?.id || null;
    }
    if (next.focus && !stillThere(next.focus.channelId)) {
        next.focus = channels[0] ? { channelId: channels[0].id, timeMs: state.nowMs } : null;
    }

    return next;
}

function scheduleFor(state, channelId) {
    return state.schedules[channelId] || null;
}

function withoutTemporaryChannel(state) {
    const temporary = state.temporaryChannel;
    if (!temporary) return state;

    const { [temporary.id]: _pool, ...pools } = state.pools;
    const { [temporary.id]: _schedule, ...schedules } = state.schedules;
    return withVisibleChannels({
        ...state,
        temporaryChannel: null,
        allChannels: state.allChannels.filter((channel) => channel.id !== temporary.id),
        pools,
        schedules
    });
}

/** What is live on a channel at `nowMs`, or null if it has no programming. */
function liveProgram(state, channelId, nowMs) {
    const schedule = scheduleFor(state, channelId);
    if (!schedule) return null;
    return programAt(schedule, nowMs, state.dayStartMs);
}

/** Tune effects are built in one place so TICK and TUNE cannot drift apart. */
function tuneEffects(state, channelId, nowMs) {
    if (!state.settings.guide_autoplay) return [];
    // A paused viewer must stay paused -- otherwise the programme-boundary
    // watcher would restart playback underneath the user.
    if (state.viewerPaused) return [];
    const program = liveProgram(state, channelId, nowMs);
    if (!program) return [];
    if (program.scene._summary) return [{ type: 'prepareViewer' }];
    return [Effects.tuneViewer(channelId, program.scene, program.elapsedMs)];
}

export function reduce(state, event) {
    const effects = [];

    switch (event.type) {
        case Events.OPEN: {
            const { key, startMs } = dayBucket(event.nowMs);
            const next = {
                ...state,
                open: true,
                guideScrollChannelId: state.layout === 'list' ? null : state.guideScrollChannelId,
                nowMs: event.nowMs,
                dayKey: key,
                dayStartMs: startMs,
                windowStartMs: snapToStep(event.nowMs, HALF_HOUR_MS),
                channelsStatus: state.channels.length > 0 ? state.channelsStatus : PoolStatus.LOADING
            };
            if (state.channels.length === 0) effects.push(Effects.loadChannels());
            else effects.push(...tuneEffects(next, next.tunedChannelId, event.nowMs));
            return { state: next, effects };
        }

        case Events.CLOSE:
            return {
                state: { ...withoutTemporaryChannel(state), open: false, savedTemporaryChannelId: null },
                effects: [Effects.stopViewer()]
            };

        case Events.SETTINGS_LOADED:
            return { state: { ...state, settings: event.settings }, effects };

        case Events.RESTORE: {
            // Startup restores preferences before the async lineup resolves.
            // Keep the id until CHANNELS_LOADED can validate it against the
            // actual, visible channels rather than discarding it too early.
            if (state.channels.length === 0) {
                return {
                    state: {
                        ...state,
                        pendingRestoredChannelId: event.tunedChannelId || null,
                        // Browser autoplay, especially on iPad Safari, only
                        // starts reliably when inaudible. This is runtime
                        // state only; the saved preference remains untouched
                        // until the user deliberately changes it.
                        muted: event.tunedChannelId ? true : (event.muted ?? state.muted)
                    },
                    effects
                };
            }

            // Only adopt a remembered channel that still exists in the lineup.
            const tunedChannelId =
                event.tunedChannelId && state.channels.some((c) => c.id === event.tunedChannelId)
                    ? event.tunedChannelId
                    : state.tunedChannelId;
            return {
                state: { ...state, tunedChannelId, muted: event.muted ?? state.muted },
                effects
            };
        }

        case Events.TICK: {
            if (event.nowMs === state.nowMs) return { state, effects };

            const { key, startMs } = dayBucket(event.nowMs);

            // Midnight starts a new batch for capped channels. Keep the full
            // library's continuous rotation; other pools reload on demand.
            if (key !== state.dayKey) {
                const specialChannelIds = new Set(
                    state.allChannels.filter((channel) => channel.source === 'special'
                        && channel.id !== ALL_SCENES_CHANNEL_ID).map((channel) => channel.id)
                );
                const schedules = {};
                for (const [channelId, pool] of Object.entries(state.pools)) {
                    if (channelId !== ALL_SCENES_CHANNEL_ID) continue;
                    if (pool.status === PoolStatus.READY) {
                        schedules[channelId] = buildDaySchedule(channelId, pool.scenes, key);
                    }
                }
                const pools = Object.fromEntries(
                    Object.entries(state.pools).filter(([channelId]) => channelId === ALL_SCENES_CHANNEL_ID)
                );
                const rolled = {
                    ...state,
                    nowMs: event.nowMs,
                    dayKey: key,
                    dayStartMs: startMs,
                    pools,
                    schedules,
                    windowStartMs: snapToStep(event.nowMs, HALF_HOUR_MS)
                };
                const requested = rolled.tunedChannelId ? reduce(rolled, {
                    type: Events.POOL_REQUESTED, channelId: rolled.tunedChannelId
                }) : { state: rolled, effects: [] };
                return {
                    state: requested.state,
                    effects: [
                        ...requested.effects,
                        ...tuneEffects(rolled, rolled.tunedChannelId, event.nowMs),
                        ...(specialChannelIds.size > 0 ? [Effects.reloadChannels()] : [])
                    ]
                };
            }

            const next = { ...state, nowMs: event.nowMs };

            // A programme ended: retune so the viewer follows the schedule
            // rather than running past the end of its scene.
            const before = liveProgram(state, state.tunedChannelId, state.nowMs);
            const after = liveProgram(next, next.tunedChannelId, event.nowMs);
            if (after && (!before || before.scene.id !== after.scene.id || before.startMs !== after.startMs)) {
                effects.push(...tuneEffects(next, next.tunedChannelId, event.nowMs));
            }

            return { state: next, effects };
        }

        case Events.CHANNELS_LOADED: {
            const next = withVisibleChannels({
                ...state,
                allChannels: event.channels,
                channelsStatus: PoolStatus.READY,
                // A successful load must clear a previous failure, or a stale
                // error would sit in the status bar over working channels.
                channelsError: null,
                sourceErrors: event.errors || []
            });

            const restoredChannelId = state.pendingRestoredChannelId;
            const restoredChannelIsVisible = Boolean(
                restoredChannelId && next.channels.some((channel) => channel.id === restoredChannelId)
            );
            next.pendingRestoredChannelId = null;
            next.tunedChannelId = restoredChannelIsVisible
                ? restoredChannelId
                : (next.tunedChannelId || next.channels[0]?.id || null);
            if (restoredChannelIsVisible) {
                next.focus = { channelId: restoredChannelId, timeMs: state.nowMs };
                next.guideScrollChannelId = state.layout === 'list' ? null : restoredChannelId;
            } else if (!next.focus && next.channels.length > 0) {
                next.focus = { channelId: next.channels[0].id, timeMs: state.nowMs };
            }
            if (state.reloadScrollChannelId && event.channels.some((channel) => channel.id === state.reloadScrollChannelId)) {
                next.temporaryChannel = null;
                next.reloadScrollChannelId = null;
                next.guideScrollChannelId = state.reloadScrollChannelId;
            }
            // Restoring a selected channel must not rely on its row becoming
            // visible before its programming (and therefore its stream) loads.
            // Reuse the normal request transition to retain its loading and
            // duplicate-request protections.
            if (next.tunedChannelId) return reduce(next, {
                type: Events.POOL_REQUESTED,
                channelId: next.tunedChannelId
            });
            return { state: next, effects };
        }

        case Events.CHANNELS_FAILED:
            return {
                state: { ...state, channelsStatus: PoolStatus.ERROR, channelsError: event.message },
                effects
            };

        case Events.POOL_REQUESTED: {
            const existing = state.pools[event.channelId];
            // Rows re-enter the viewport constantly; only the first request counts.
            if (existing && existing.status !== PoolStatus.ERROR) return { state, effects };

            const channel = state.channels.find((c) => c.id === event.channelId)
                || (event.channelId === state.tunedChannelId && state.allChannels.find((c) => c.id === event.channelId));
            if (!channel) return { state, effects };

            return {
                state: {
                    ...state,
                    pools: {
                        ...state.pools,
                        [event.channelId]: { status: PoolStatus.LOADING, scenes: [], error: null }
                    }
                },
                effects: [
                    Effects.fetchPool(
                        channel.id,
                        channel.sceneFilter,
                        poolCapFor(state.prefs, channel.id, state.settings.guide_pool_cap)
                    )
                ]
            };
        }

        case Events.POOL_LOADED: {
            const scenes = event.scenes.map((scene) => mergeSceneMetadata(scene, state.sceneMetadata[scene.id]));
            const schedule = buildDaySchedule(event.channelId, scenes, state.dayKey);
            const next = {
                ...state,
                pools: {
                    ...state.pools,
                    [event.channelId]: { status: PoolStatus.READY, scenes, error: null }
                },
                schedules: { ...state.schedules, [event.channelId]: schedule }
            };
            // The tuned channel's pool arriving is what actually starts playback.
            if (event.channelId === state.tunedChannelId) {
                if (next.focus?.source === 'live' && next.focus.channelId === event.channelId) {
                    const program = liveProgram(next, event.channelId, state.nowMs);
                    next.focus = { ...next.focus, timeMs: program?.startMs ?? state.nowMs };
                }
                effects.push(...tuneEffects(next, event.channelId, state.nowMs));
            }
            return { state: next, effects };
        }

        case Events.SCENE_METADATA_UPDATED: {
            const metadata = { ...state.sceneMetadata };
            let changed = false;
            for (const patch of event.scenes) {
                const previous = metadata[patch.id] || { id: patch.id };
                metadata[patch.id] = mergeSceneMetadata(previous, patch);
                if (metadata[patch.id] !== previous) changed = true;
            }
            if (!changed) return { state, effects };
            const merge = (scene) => mergeSceneMetadata(scene, metadata[scene.id]);
            const pools = { ...state.pools };
            const schedules = { ...state.schedules };
            for (const [id, pool] of Object.entries(pools)) {
                const scenes = pool.scenes.map(merge);
                if (scenes.some((scene, i) => scene !== pool.scenes[i])) pools[id] = { ...pool, scenes };
            }
            for (const [id, schedule] of Object.entries(schedules)) {
                const entries = schedule.entries.map((entry) => {
                    const scene = merge(entry.scene);
                    return scene === entry.scene ? entry : { ...entry, scene };
                });
                if (entries.some((entry, i) => entry !== schedule.entries[i])) schedules[id] = { ...schedule, entries };
            }
            return { state: { ...state, sceneMetadata: metadata, pools, schedules }, effects };
        }

        case Events.SCENE_DETAILS_LOADED: {
            const channelId = ALL_SCENES_CHANNEL_ID;
            const pool = state.pools[channelId];
            const schedule = state.schedules[channelId];
            if (!pool || !schedule) return { state, effects };
            const before = liveProgram(state, channelId, state.nowMs);
            const details = mergeSceneMetadata(event.scene, state.sceneMetadata[event.scene.id]);
            const merge = (scene) => scene.id === event.scene.id
                ? { ...scene, ...details, files: scene.files, _summary: false } : scene;
            const next = {
                ...state,
                pools: { ...state.pools, [channelId]: { ...pool, scenes: pool.scenes.map(merge) } },
                schedules: { ...state.schedules, [channelId]: {
                    ...schedule, entries: schedule.entries.map((entry) => entry.scene.id === event.scene.id
                        ? { ...entry, scene: merge(entry.scene) } : entry)
                } }
            };
            // Hydrating the next scene or a hovered scene must not retune video.
            if (state.open && state.tunedChannelId === channelId && before?.scene._summary && before.scene.id === event.scene.id) {
                effects.push(...tuneEffects(next, channelId, state.nowMs));
            }
            return { state: next, effects };
        }

        case Events.SCENE_DETAILS_FAILED: {
            const current = liveProgram(state, ALL_SCENES_CHANNEL_ID, state.nowMs);
            if (state.open && !state.viewerPaused && state.tunedChannelId === ALL_SCENES_CHANNEL_ID && current?.scene.id === event.sceneId) {
                effects.push({ type: 'playbackError', message: 'Unable to load scene details. Retrying shortly.' });
            }
            return { state, effects };
        }

        case Events.POOL_FAILED:
            return {
                state: {
                    ...state,
                    pools: {
                        ...state.pools,
                        [event.channelId]: { status: PoolStatus.ERROR, scenes: [], error: event.message }
                    }
                },
                effects
            };

        case Events.TUNE: {
            let current = state;
            if (current.temporaryChannel && current.temporaryChannel.id !== event.channelId) {
                current = withoutTemporaryChannel(current);
            }
            if (current.savedTemporaryChannelId && current.savedTemporaryChannelId !== event.channelId) {
                current = { ...current, savedTemporaryChannelId: null };
            }
            if (!current.channels.some((c) => c.id === event.channelId)) return { state: current, effects };

            // Tuning always lifts a pause: the whole point is to start watching
            // something. Leaving it set meant the player never came back,
            // because tuneEffects declines to act while paused.
            const recentChannelIds = [event.channelId, ...(current.recentChannelIds || []).filter((id) => id !== event.channelId)].slice(0, 10);
            const next = {
                ...current,
                tunedChannelId: event.channelId,
                guideScrollChannelId: event.scrollIntoView === false ? null : event.channelId,
                viewerPaused: false,
                recentChannelIds
            };
            effects.push(Effects.persist(STORAGE_KEYS.tunedChannel, event.channelId));
            effects.push(Effects.persist(STORAGE_KEYS.recentChannels, JSON.stringify(recentChannelIds)));

            const channel = state.channels.find((c) => c.id === event.channelId);
            const program = liveProgram(next, event.channelId, state.nowMs);
            effects.push(
                Effects.announce(
                    program ? `${channel.name}. ${program.scene.title || 'Untitled'}` : `${channel.name}. No programming`
                )
            );
            // Move the details onto what is now playing, rather than leaving
            // them on whatever programme was last pinned there.
            // Select the destination even before its pool arrives. Keeping the
            // old focus here leaves the banner stale until a mouseleave resets it.
            next.focus = {
                channelId: event.channelId,
                timeMs: program?.startMs ?? state.nowMs,
                source: event.pinDetails === true ? 'sticky' : 'live'
            };
            next.liveClickCandidate = null;

            effects.push(...tuneEffects(next, event.channelId, state.nowMs));
            return { state: next, effects };
        }

        case Events.TUNE_RELATED: {
            const candidate = relatedChannel(event.source, event.entity);
            if (!candidate) return { state, effects };

            const existing = state.allChannels.find((channel) => channel.id === candidate.id);
            if (existing) return reduce(state, { type: Events.TUNE, channelId: existing.id });

            const cleared = withoutTemporaryChannel(state);
            const next = withVisibleChannels({
                ...cleared,
                temporaryChannel: candidate,
                guideScrollChannelId: candidate.id,
                allChannels: [...cleared.allChannels, candidate],
                pools: {
                    ...cleared.pools,
                    [candidate.id]: { status: PoolStatus.LOADING, scenes: [], error: null }
                }
            });
            const tuned = reduce(next, { type: Events.TUNE, channelId: candidate.id });
            tuned.effects.push(
                Effects.fetchPool(
                    candidate.id,
                    candidate.sceneFilter,
                    poolCapFor(next.prefs, candidate.id, next.settings.guide_pool_cap)
                )
            );
            return tuned;
        }

        case Events.SAVE_TEMPORARY_CHANNEL: {
            const temporary = state.temporaryChannel;
            const parsed = temporary && parseChannelId(temporary.id);
            if (!temporary || !parsed) return { state, effects };

            const entry = state.lineup.find((item) => item.source === parsed.source && Array.isArray(item.ids));
            const ids = new Set(entry?.ids || []);
            ids.add(parsed.id);
            const lineup = [
                ...state.lineup.filter((item) => !(item.source === parsed.source && Array.isArray(item.ids))),
                { source: parsed.source, ids: [...ids] }
            ];
            return {
                state: {
                    ...state,
                    lineup,
                    channelsStatus: PoolStatus.LOADING,
                    savedTemporaryChannelId: temporary.id,
                    reloadScrollChannelId: temporary.id
                },
                effects: [
                    Effects.persist(STORAGE_KEYS.lineup, JSON.stringify(lineup)),
                    Effects.reloadChannels()
                ]
            };
        }

        case Events.CONSUME_GUIDE_SCROLL:
            if (!state.guideScrollChannelId) return { state, effects };
            return { state: { ...state, guideScrollChannelId: null }, effects };

        case Events.EXPAND: {
            // Without a time this is "open what is on now"; with one it is
            // "open the programme the details are describing".
            const schedule = scheduleFor(state, event.channelId);
            if (!schedule) return { state, effects };
            const program = programAt(schedule, event.timeMs ?? state.nowMs, state.dayStartMs);
            if (!program) return { state, effects };

            // Only a live programme has a meaningful position to open at --
            // dropping into the middle of something scheduled for later would
            // land at an offset that means nothing yet.
            const isLive = program.startMs <= state.nowMs && program.endMs > state.nowMs;
            const offsetSeconds = isLive ? Math.floor(program.elapsedMs / 1000) : 0;
            return { state, effects: [Effects.navigateToScene(program.scene.id, offsetSeconds)] };
        }

        case Events.PAN: {
            const windowStartMs = clampWindowStart(
                state.windowStartMs + event.deltaMs,
                state.dayStartMs,
                MAX_PAN_AHEAD_MS
            );
            if (windowStartMs === state.windowStartMs) return { state, effects };
            return { state: { ...state, windowStartMs }, effects };
        }

        case Events.GO_TO_NOW:
            return {
                state: { ...state, windowStartMs: snapToStep(state.nowMs, HALF_HOUR_MS) },
                effects
            };

        case Events.FOCUS_CELL:
            if (event.source === 'hover' && state.focus?.source === 'sticky') return { state, effects };
            return {
                state: {
                    ...state,
                    focus: {
                        channelId: event.channelId,
                        timeMs: event.timeMs,
                        // Hovering is transient; clicks and keyboard focus
                        // are not. Mouse-leave only undoes a hover.
                        source: event.source || 'sticky'
                    }
                },
                effects
            };

        case Events.FOCUS_LIVE: {
            // The mouse left the grid: put the banner back on what is playing.
            // A pinned programme is a deliberate choice and survives.
            if (state.focus?.source === 'sticky') return { state, effects };
            const live = liveProgram(state, state.tunedChannelId, state.nowMs);
            // Nothing playing to fall back to: an empty banner is honest, where
            // leaving the hovered scene up would claim it is on.
            if (!live) return { state: { ...state, focus: null }, effects };
            return {
                state: {
                    ...state,
                    focus: {
                        channelId: state.tunedChannelId,
                        timeMs: live.startMs,
                        source: 'live'
                    }
                },
                effects
            };
        }

        case Events.MOVE_FOCUS:
            return moveFocus(state, event);

        case Events.LAYOUT_CHANGED:
            if (event.layout === state.layout) return { state, effects };
            return { state: { ...state, layout: event.layout }, effects };

        case Events.PREFS_LOADED:
            return {
                state: withVisibleChannels({
                    ...state,
                    prefs: event.prefs,
                    managerSort: event.sort || state.managerSort,
                    lineup: event.lineup || state.lineup,
                    pinOrder: event.pinOrder || state.pinOrder,
                    collapsedGroups: event.collapsedGroups || state.collapsedGroups,
                    playerWidthPx: event.playerWidthPx || state.playerWidthPx,
                    channelInfoMinimized: typeof event.channelInfoMinimized === 'boolean'
                        ? event.channelInfoMinimized : state.channelInfoMinimized,
                    playerMode: event.playerMode || state.playerMode
                    ,recentChannelIds: event.recentChannelIds || state.recentChannelIds
                }),
                effects
            };

        case Events.SET_CHANNEL_PREF: {
            const prefs = setPref(state.prefs, event.channelId, event.patch);
            return {
                state: withVisibleChannels({ ...state, prefs }),
                effects: [Effects.persist(STORAGE_KEYS.prefs, JSON.stringify(prefs))]
            };
        }

        case Events.TOGGLE_PIN: {
            const pinOrder = togglePin(state.pinOrder, event.channelId);
            return {
                state: withVisibleChannels({ ...state, pinOrder }),
                effects: [Effects.persist(STORAGE_KEYS.pinOrder, JSON.stringify(pinOrder))]
            };
        }

        case Events.MOVE_PIN: {
            const pinOrder = movePin(state.pinOrder, event.channelId, event.toIndex);
            if (pinOrder === state.pinOrder) return { state, effects };
            return {
                state: withVisibleChannels({ ...state, pinOrder }),
                effects: [Effects.persist(STORAGE_KEYS.pinOrder, JSON.stringify(pinOrder))]
            };
        }

        case Events.TOGGLE_GROUP: {
            const collapsedGroups = state.collapsedGroups.includes(event.key)
                ? state.collapsedGroups.filter((k) => k !== event.key)
                : [...state.collapsedGroups, event.key];
            return {
                state: withVisibleChannels({ ...state, collapsedGroups }),
                effects: [Effects.persist(STORAGE_KEYS.collapsed, JSON.stringify(collapsedGroups))]
            };
        }

        case Events.GUIDE_SEARCH:
            if (event.query === state.guideSearch) return { state, effects };
            return { state: withVisibleChannels({ ...state, guideSearch: event.query }), effects };

        case Events.SET_TYPE_FILTER:
            if (event.typeFilter === state.typeFilter) return { state, effects };
            return { state: withVisibleChannels({ ...state, typeFilter: event.typeFilter }), effects };

        case Events.TOGGLE_CHANNEL_INFO: {
            const channelInfoMinimized = !state.channelInfoMinimized;
            return {
                state: { ...state, channelInfoMinimized },
                effects: [Effects.persist(STORAGE_KEYS.channelInfoMinimized, String(channelInfoMinimized))]
            };
        }

        case Events.SET_PLAYER_WIDTH: {
            // Clamped so a stray drag cannot leave the player a sliver or push
            // the guide off the bottom of the screen. Height follows from the
            // width in CSS, so one number describes the whole box.
            const playerWidthPx = Math.min(640, Math.max(200, Math.round(event.px)));
            if (playerWidthPx === state.playerWidthPx) return { state, effects };
            return {
                state: { ...state, playerWidthPx },
                effects: [Effects.persist(STORAGE_KEYS.playerWidth, String(playerWidthPx))]
            };
        }

        case Events.TOGGLE_HIDDEN: {
            const hidden = Boolean(state.prefs[event.channelId]?.hidden);
            const prefs = setPref(state.prefs, event.channelId, { hidden: !hidden });
            return {
                state: withVisibleChannels({ ...state, prefs }),
                effects: [Effects.persist(STORAGE_KEYS.prefs, JSON.stringify(prefs))]
            };
        }

        // Dialog-only: this orders the channel manager's own list and nothing
        // else, so it deliberately does not recompute the visible channels.
        case Events.SET_MANAGER_SORT:
            if (event.sort === state.managerSort) return { state, effects };
            const next = { ...state, managerSort: event.sort };
            const requested = state.managerOpen ? requestCatalogPage(next, 1) : { state: next, effects: [] };
            return {
                state: requested.state,
                effects: [Effects.persist(STORAGE_KEYS.sort, event.sort), ...requested.effects]
            };

        case Events.SET_LINEUP:
            // Changing which sources are included means re-resolving from the
            // server; prefs and schedules for surviving channels are untouched.
            return {
                state: { ...state, lineup: event.lineup, channelsStatus: PoolStatus.LOADING },
                effects: [
                    Effects.persist(STORAGE_KEYS.lineup, JSON.stringify(event.lineup)),
                    Effects.reloadChannels()
                ]
            };

        case Events.MANAGER_OPEN: {
            const next = { ...state, managerOpen: true };
            const source = event.source || state.managerSource;
            next.managerSource = source;
            return requestCatalogPage(next, 1);
        }

        case Events.SET_MANAGER_SOURCE: {
            if (event.source === state.managerSource) return { state, effects };
            return requestCatalogPage({ ...state, managerSource: event.source }, 1);
        }

        case Events.MANAGER_CLOSE:
            return { state: { ...state, managerOpen: false }, effects };

        case Events.MANAGER_SEARCH:
            if (event.query === state.managerSearch) return { state, effects };
            return requestCatalogPage({ ...state, managerSearch: event.query }, 1);

        case Events.SET_MANAGER_CATALOG_FAVORITED:
            if (Boolean(event.favorited) === state.managerCatalogFavorited) return { state, effects };
            return requestCatalogPage({ ...state, managerCatalogFavorited: Boolean(event.favorited) }, 1);

        case Events.SET_MANAGER_CATALOG_GENDER: {
            const gender = ['male', 'female'].includes(event.gender) ? event.gender : 'all';
            if (gender === state.managerCatalogGender) return { state, effects };
            return requestCatalogPage({ ...state, managerCatalogGender: gender }, 1);
        }

        case Events.LOAD_MANAGER_CATALOG_PAGE:
            return requestCatalogPage(state, event.page);

        case Events.CATALOG_PAGE_LOADED: {
            if (event.requestKey !== catalogRequestKey(state)) return { state, effects };
            const current = state.catalogRequests[event.requestKey];
            if (!current || current.loadingPage !== event.page) return { state, effects };
            const channels = event.page === 1 ? event.channels : [...current.channels, ...event.channels];
            return {
                state: {
                    ...state,
                    catalogRequests: {
                        ...state.catalogRequests,
                        [event.requestKey]: {
                            ...current, channels, total: event.total,
                            loadedPages: [...current.loadedPages, event.page], loadingPage: null, error: null
                        }
                    }
                },
                effects
            };
        }

        case Events.CATALOG_PAGE_FAILED: {
            if (event.requestKey !== catalogRequestKey(state)) return { state, effects };
            const current = state.catalogRequests[event.requestKey];
            if (!current || current.loadingPage !== event.page) return { state, effects };
            return {
                state: { ...state, catalogRequests: { ...state.catalogRequests, [event.requestKey]: { ...current, loadingPage: null, error: event.message } } },
                effects
            };
        }

        case Events.MANAGER_CHANNEL_INCLUDED: {
            const alreadyIncluded = state.allChannels.some((channel) => channel.id === event.channel.id);
            const allChannels = alreadyIncluded
                ? state.allChannels : [...state.allChannels, event.channel];
            const next = withVisibleChannels({ ...state, lineup: event.lineup, allChannels });
            return {
                state: next,
                effects: [
                    Effects.persist(STORAGE_KEYS.lineup, JSON.stringify(event.lineup)),
                    ...(!alreadyIncluded ? [Effects.fetchPool(event.channel.id, event.channel.sceneFilter, poolCapFor(next.prefs, event.channel.id, next.settings.guide_pool_cap))] : [])
                ]
            };
        }

        case Events.MANAGER_CHANNEL_REMOVED: {
            const { [event.channel.id]: _pool, ...pools } = state.pools;
            const { [event.channel.id]: _schedule, ...schedules } = state.schedules;
            const next = withVisibleChannels({
                ...state, lineup: event.lineup,
                allChannels: state.allChannels.filter((channel) => channel.id !== event.channel.id), pools, schedules
            });
            return { state: next, effects: [Effects.persist(STORAGE_KEYS.lineup, JSON.stringify(event.lineup))] };
        }

        case Events.CATALOG_LOADED: {
            const source = event.source || state.managerSource;
            return {
                state: {
                    ...state,
                    catalog: { ...state.catalog, ...event.catalog },
                    catalogStatus: { ...state.catalogStatus, [source]: PoolStatus.READY },
                    catalogError: { ...state.catalogError, [source]: null }
                },
                effects
            };
        }

        case Events.CATALOG_FAILED: {
            const source = event.source || state.managerSource;
            return {
                state: {
                    ...state,
                    catalogStatus: { ...state.catalogStatus, [source]: PoolStatus.ERROR },
                    catalogError: { ...state.catalogError, [source]: event.message }
                },
                effects
            };
        }

        case Events.SET_PLAYER_MODE:
            if (event.mode === state.playerMode) return { state, effects };
            return {
                state: {
                    ...state,
                    playerMode: event.mode,
                    fullscreenReturnMode:
                        event.mode === 'fullscreen' ? state.playerMode : state.fullscreenReturnMode
                },
                effects: [
                    Effects.setPlayerMode(event.mode),
                    Effects.persist(STORAGE_KEYS.playerMode, event.mode)
                ]
            };

        case Events.SET_VIEWER_PAUSED: {
            if (event.paused === state.viewerPaused) return { state, effects };
            // Remember when the pause started so the player can freeze its
            // readout there. The schedule keeps running -- the now-line and the
            // grid still track real time -- but the panel describing a stopped
            // picture must not claim to be advancing through it.
            const next = { ...state, viewerPaused: event.paused, pausedAtMs: event.paused ? state.nowMs : 0 };
            if (event.paused) return { state: next, effects: [Effects.setPaused(true)] };
            // Resuming re-syncs to live rather than continuing from where it
            // stopped: a paused channel has fallen behind its own schedule.
            return { state: next, effects: tuneEffects(next, next.tunedChannelId, state.nowMs) };
        }

        /**
         * Clicking a block.
         *
         * Something already on is a request to watch it. Anything else is a
         * request to *read* about it: the details pin to that programme and the
         * player is left strictly alone. It used to stop the stream and put the
         * scene up as a still, which meant idly clicking through the schedule
         * killed whatever you were watching.
         */
        case Events.PIN_DETAILS: {
            const schedule = state.schedules[event.channelId];
            if (!schedule) return { state, effects };
            const program = programAt(schedule, event.timeMs, state.dayStartMs);
            if (!program) return { state, effects };

            const isLive = program.startMs <= state.nowMs && program.endMs > state.nowMs;
            if (event.forcePin) {
                return { state: { ...state, liveClickCandidate: null, focus: { channelId: event.channelId, timeMs: program.startMs, source: 'sticky' } }, effects };
            }
            if (isLive) {
                const repeat = state.liveClickCandidate?.channelId === event.channelId && state.liveClickCandidate?.startMs === program.startMs;
                if (repeat) return { state: { ...state, liveClickCandidate: null, focus: { channelId: event.channelId, timeMs: program.startMs, source: 'sticky' } }, effects };
                const tuned = reduce(state, {
                    type: Events.TUNE,
                    channelId: event.channelId,
                    scrollIntoView: false
                });
                return {
                    ...tuned,
                    state: {
                        ...tuned.state,
                        liveClickCandidate: { channelId: event.channelId, startMs: program.startMs },
                        focus: { channelId: event.channelId, timeMs: program.startMs, source: 'live' }
                    }
                };
            }

            return {
                state: {
                    ...state,
                    liveClickCandidate: null,
                    focus: { channelId: event.channelId, timeMs: program.startMs, source: 'sticky' }
                },
                effects
            };
        }

        case Events.UNPIN_DETAILS:
            return reduce({ ...state, liveClickCandidate: null, focus: { ...state.focus, source: 'hover' } }, { type: Events.FOCUS_LIVE });

        case Events.RESUME_AFTER_HIDDEN: {
            // Returning from another app leaves the element paused with no event
            // that drift correction can act on, so playback is re-established
            // explicitly.
            if (!state.open || state.viewerPaused) return { state, effects };
            return { state, effects: tuneEffects(state, state.tunedChannelId, state.nowMs) };
        }

        case Events.SET_MUTED:
            return {
                state: { ...state, muted: event.muted },
                effects: [Effects.setMuted(event.muted), Effects.persist(STORAGE_KEYS.muted, String(event.muted))]
            };

        case Events.VIEWER_MUTED:
            return { state: state.muted === event.muted ? state : { ...state, muted: event.muted }, effects };

        default:
            return { state, effects };
    }
}

/**
 * Keyboard focus movement across the grid.
 *
 * Blocks have no fixed width, so "next" means the next programme in time on the
 * focused channel, and moving between channels keeps the current time position
 * rather than a column index -- which is how a real guide behaves.
 */
function moveFocus(state, event) {
    const effects = [];
    if (!state.focus || state.channels.length === 0) return { state, effects };

    const { channelId, timeMs } = state.focus;

    if (event.axis === 'channel') {
        const index = state.channels.findIndex((c) => c.id === channelId);
        const nextIndex = Math.min(state.channels.length - 1, Math.max(0, index + event.delta));
        if (nextIndex === index) return { state, effects };
        return {
            state: {
                ...state,
                focus: { channelId: state.channels[nextIndex].id, timeMs, source: 'keyboard' }
            },
            effects
        };
    }

    const schedule = scheduleFor(state, channelId);
    if (!schedule) return { state, effects };

    const current = programAt(schedule, timeMs, state.dayStartMs);
    if (!current) return { state, effects };

    // Step just inside the neighbouring programme rather than onto its edge,
    // so the following lookup cannot land back on the current block.
    const target = event.delta > 0 ? current.endMs : current.startMs - 1;
    // Non-null: `current` existing proves the schedule has programming, and the
    // schedule loops, so every instant maps to some programme.
    const neighbour = programAt(schedule, target, state.dayStartMs);

    const next = { ...state, focus: { channelId, timeMs: neighbour.startMs, source: 'keyboard' } };

    // Follow the focus if it walked off the visible window.
    const windowMs = windowMsOf(state);
    if (neighbour.startMs < state.windowStartMs) {
        next.windowStartMs = clampWindowStart(
            snapToStep(neighbour.startMs, HALF_HOUR_MS),
            state.dayStartMs,
            MAX_PAN_AHEAD_MS
        );
    } else if (neighbour.startMs >= state.windowStartMs + windowMs) {
        next.windowStartMs = clampWindowStart(
            snapToStep(neighbour.startMs, HALF_HOUR_MS),
            state.dayStartMs,
            MAX_PAN_AHEAD_MS
        );
    }

    return { state: next, effects };
}

export { createInitialState };
