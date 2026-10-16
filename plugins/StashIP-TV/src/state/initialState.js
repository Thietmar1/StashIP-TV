import { DEFAULT_SETTINGS } from '../api/settings.js';
import { DEFAULT_SORT } from '../domain/channelPrefs.js';
import { KNOWN_SOURCES, DEFAULT_LINEUP } from '../domain/lineup.js';


export const PoolStatus = {
    IDLE: 'idle',
    LOADING: 'loading',
    READY: 'ready',
    ERROR: 'error'
};

export function createInitialState() {
    return {
        open: false,
        layout: 'grid',

        // Clock. `nowMs` is pushed in by TICK rather than read from Date, so
        // every time-dependent branch is reproducible in a test.
        nowMs: 0,
        dayKey: '',
        dayStartMs: 0,

        settings: { ...DEFAULT_SETTINGS },

        windowStartMs: 0,

        // The raw resolved lineup, before prefs. `channels` is the derived,
        // prefs-applied and sorted list -- and it has to be real state rather
        // than a selector, because MOVE_FOCUS walks it in the reducer.
        allChannels: [],
        // Flattened, collapse-aware visible order. MOVE_FOCUS walks this, so it
        // must match what is on screen exactly.
        channels: [],
        // The same channels as grouped rows, for rendering.
        channelGroups: [],
        channelsStatus: PoolStatus.IDLE,
        channelsError: null,
        sourceErrors: [],

        // channelId -> { status, scenes, error }
        pools: {},
        sceneMetadata: {},
        // channelId -> daySchedule, rebuilt when the broadcast day rolls over
        schedules: {},
        temporaryChannel: null,
        savedTemporaryChannelId: null,
        reloadScrollChannelId: null,
        guideScrollChannelId: null,

        tunedChannelId: null,
        recentChannelIds: [],
        // Storage is read before the lineup has resolved, so this keeps a
        // remembered channel until CHANNELS_LOADED can validate it.
        pendingRestoredChannelId: null,
        focus: null,
        liveClickCandidate: null,
        muted: true,

        // Player
        playerMode: 'corner',
        channelInfoMinimized: false,
        // The normal layout to return to when the browser leaves fullscreen.
        // This is session state, not a saved preference.
        fullscreenReturnMode: 'corner',
        viewerPaused: false,
        // Wall-clock instant the user paused at, so the player readout can
        // freeze instead of running on with the schedule. 0 when playing.
        pausedAtMs: 0,

        // Guide navigation
        guideSearch: '',
        typeFilter: 'all',
        collapsedGroups: [],
        playerWidthPx: 268,
        sourceOrder: KNOWN_SOURCES,

        // Channel manager
        lineup: DEFAULT_LINEUP,
        pinOrder: [],
        prefs: {},
        // Dialog-only: the guide itself is always alphabetical, which is what
        // makes the per-group A-Z rails mean anything.
        managerSort: DEFAULT_SORT,
        managerOpen: false,
        managerSearch: '',
        managerCatalogFavorited: false,
        managerCatalogGender: 'all',
        catalogRequests: {},
        // Keyed by source: the catalogue is fetched one type at a time.
        managerSource: 'studio',
        catalog: {},
        catalogStatus: {},
        catalogError: {},

        announcement: ''
    };
}
