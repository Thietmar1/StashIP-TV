/**
 * Event and effect vocabularies.
 *
 * Events are things that happened; effects are things that must happen. The
 * reducer only ever produces effects -- it never performs them -- which is what
 * keeps the ticking clock, the lazy loads and the video element testable
 * without a browser.
 */

export const Events = {
    OPEN: 'OPEN',
    CLOSE: 'CLOSE',
    SETTINGS_LOADED: 'SETTINGS_LOADED',
    RESTORE: 'RESTORE',
    TICK: 'TICK',
    CHANNELS_LOADED: 'CHANNELS_LOADED',
    CHANNELS_FAILED: 'CHANNELS_FAILED',
    POOL_REQUESTED: 'POOL_REQUESTED',
    POOL_LOADED: 'POOL_LOADED',
    SCENE_DETAILS_LOADED: 'SCENE_DETAILS_LOADED',
    SCENE_METADATA_UPDATED: 'SCENE_METADATA_UPDATED',
    SCENE_DETAILS_FAILED: 'SCENE_DETAILS_FAILED',
    POOL_FAILED: 'POOL_FAILED',
    TUNE: 'TUNE',
    TUNE_RELATED: 'TUNE_RELATED',
    SAVE_TEMPORARY_CHANNEL: 'SAVE_TEMPORARY_CHANNEL',
    CONSUME_GUIDE_SCROLL: 'CONSUME_GUIDE_SCROLL',
    EXPAND: 'EXPAND',
    PAN: 'PAN',
    GO_TO_NOW: 'GO_TO_NOW',
    FOCUS_CELL: 'FOCUS_CELL',
    FOCUS_LIVE: 'FOCUS_LIVE',
    MOVE_FOCUS: 'MOVE_FOCUS',
    LAYOUT_CHANGED: 'LAYOUT_CHANGED',
    SET_MUTED: 'SET_MUTED',
    VIEWER_MUTED: 'VIEWER_MUTED',

    // Channel manager
    PREFS_LOADED: 'PREFS_LOADED',
    SET_CHANNEL_PREF: 'SET_CHANNEL_PREF',
    TOGGLE_PIN: 'TOGGLE_PIN',
    MOVE_PIN: 'MOVE_PIN',
    TOGGLE_GROUP: 'TOGGLE_GROUP',
    TOGGLE_HIDDEN: 'TOGGLE_HIDDEN',
    SET_MANAGER_SORT: 'SET_MANAGER_SORT',
    SET_LINEUP: 'SET_LINEUP',
    MANAGER_OPEN: 'MANAGER_OPEN',
    MANAGER_CLOSE: 'MANAGER_CLOSE',
    MANAGER_SEARCH: 'MANAGER_SEARCH',
    SET_MANAGER_SOURCE: 'SET_MANAGER_SOURCE',
    SET_MANAGER_CATALOG_FAVORITED: 'SET_MANAGER_CATALOG_FAVORITED',
    SET_MANAGER_CATALOG_GENDER: 'SET_MANAGER_CATALOG_GENDER',
    LOAD_MANAGER_CATALOG_PAGE: 'LOAD_MANAGER_CATALOG_PAGE',
    CATALOG_PAGE_LOADED: 'CATALOG_PAGE_LOADED',
    CATALOG_PAGE_FAILED: 'CATALOG_PAGE_FAILED',
    MANAGER_CHANNEL_INCLUDED: 'MANAGER_CHANNEL_INCLUDED',
    MANAGER_CHANNEL_REMOVED: 'MANAGER_CHANNEL_REMOVED',
    CATALOG_LOADED: 'CATALOG_LOADED',
    CATALOG_FAILED: 'CATALOG_FAILED',

    // Player
    SET_PLAYER_MODE: 'SET_PLAYER_MODE',
    TOGGLE_CHANNEL_INFO: 'TOGGLE_CHANNEL_INFO',
    SET_VIEWER_PAUSED: 'SET_VIEWER_PAUSED',
    PIN_DETAILS: 'PIN_DETAILS',
    UNPIN_DETAILS: 'UNPIN_DETAILS',
    RESUME_AFTER_HIDDEN: 'RESUME_AFTER_HIDDEN',

    // Guide navigation
    GUIDE_SEARCH: 'GUIDE_SEARCH',
    SET_TYPE_FILTER: 'SET_TYPE_FILTER',
    SET_PLAYER_WIDTH: 'SET_PLAYER_WIDTH'
};

export const Effects = {
    loadChannels: () => ({ type: 'loadChannels' }),
    fetchPool: (channelId, sceneFilter, poolCap) => ({
        type: 'fetchPool',
        channelId,
        sceneFilter,
        poolCap
    }),
    loadCatalog: (source) => ({ type: 'loadCatalog', source }),
    loadCatalogPage: (source, requestKey, page, perPage, query, favorited, gender, sort) => ({
        type: 'loadCatalogPage', source, requestKey, page, perPage, query, favorited, gender, sort
    }),
    setPlayerMode: (mode) => ({ type: 'setPlayerMode', mode }),
    setPaused: (paused) => ({ type: 'setPaused', paused }),
    reloadChannels: () => ({ type: 'loadChannels' }),
    /** Point the viewer at whatever is live on this channel right now. */
    tuneViewer: (channelId, scene, offsetMs) => ({ type: 'tuneViewer', channelId, scene, offsetMs }),
    stopViewer: () => ({ type: 'stopViewer' }),
    setMuted: (muted) => ({ type: 'setMuted', muted }),
    navigateToScene: (sceneId, offsetSeconds) => ({ type: 'navigateToScene', sceneId, offsetSeconds }),
    persist: (key, value) => ({ type: 'persist', key, value }),
    announce: (message) => ({ type: 'announce', message })
};

export const STORAGE_KEYS = {
    channelInfoMinimized: 'tvguide_channel_info_minimized',
    tunedChannel: 'tvguide_last_channel',
    muted: 'tvguide_muted',
    lineup: 'tvguide_lineup',
    prefs: 'tvguide_channel_prefs',
    sort: 'tvguide_sort',
    pinOrder: 'tvguide_pin_order',
    collapsed: 'tvguide_collapsed_groups',
    playerWidth: 'tvguide_player_width',
    playerMode: 'tvguide_player_mode'
    ,recentChannels: 'tvguide_recent_channels'
};
