import './styles/index.css';
import './styles/channelManager.css';
import { createClient } from './api/client.js';
import { loadPluginConfiguration, migratePluginSettings, normalizeSettings } from './api/settings.js';
import { createPluginStorage } from './api/pluginStorage.js';
import { parseLineup } from './domain/lineup.js';
import { parsePrefs, parsePinOrder, migratePinOrder, migrateSort } from './domain/channelPrefs.js';
import { createStore } from './state/store.js';
import { createEffectRunner } from './state/effects.js';
import { Events, STORAGE_KEYS } from './state/actions.js';
import { createManager } from './ui/manager.js';
import { createNavbarButton } from './ui/navbarButton.js';
import { createAnnouncer, trapFocus } from './ui/a11y.js';

// The management surface never creates video elements or loads scene pools.
// The server remains the sole playback/scheduling consumer of the saved lineup.
const MANAGEMENT_EFFECTS = new Set(['loadChannels', 'loadCatalog', 'loadCatalogPage', 'persist', 'announce']);

export function startChannelManager({ gql = createClient() } = {}) {
    let storage, loaded = false, disposed = false, releaseFocus;
    const announcer = createAnnouncer();
    const run = createEffectRunner({ gql, getLineup: () => store.getState().lineup,
        storage: { setItem: (...args) => storage?.setItem(...args) },
        announce: (message) => announcer.announce(message)
    });
    const store = createStore({ runEffect: (effect, ...args) => {
        if (MANAGEMENT_EFFECTS.has(effect.type)) run(effect, ...args);
    } });
    const manager = createManager({ store });
    manager.element.setAttribute('aria-modal', 'true');
    const shell = document.createElement('div');
    shell.className = 'tvguide-overlay tvguide-manager-shell';
    shell.hidden = true;
    shell.append(announcer.element, manager.element);
    document.body.append(shell);
    const open = () => {
        if (!loaded) return;
        releaseFocus?.();
        releaseFocus = trapFocus(manager.element);
        const state = store.getState();
        const selected = state.allChannels.filter((channel) => state.managerView !== 'active' || !state.prefs[channel.id]?.hidden);
        const source = state.managerView !== 'all' && !selected.some((channel) => channel.source === state.managerSource)
            ? selected[0]?.source || state.managerSource : state.managerSource;
        store.dispatch({ type: Events.MANAGER_OPEN, source });
        manager.element.querySelector('input,button,select')?.focus();
    };
    const navbar = createNavbarButton({ onActivate: open });
    navbar.element.setAttribute('aria-label', 'Open StashIP-TV channel manager');
    navbar.element.title = 'StashIP-TV channels';
    const unsubscribe = store.subscribe((state) => {
        const wasOpen = !shell.hidden;
        shell.hidden = !state.managerOpen;
        manager.render(state);
        if (wasOpen && !state.managerOpen) { releaseFocus?.(); releaseFocus = null; }
    });
    const onHash = () => { if (window.location.hash === '#tvguide') open(); };
    const onKey = (event) => {
        if (event.key === 'Escape' && store.getState().managerOpen) {
            event.preventDefault(); store.dispatch({ type: Events.MANAGER_CLOSE });
        }
    };
    window.addEventListener('hashchange', onHash);
    document.addEventListener('keydown', onKey);
    const ready = loadPluginConfiguration(gql).then((config) => migratePluginSettings(gql, config)).then((config) => {
        if (disposed) return;
        const settings = normalizeSettings(config);
        storage = createPluginStorage({ gql, initialConfiguration: config });
        const get = (key) => storage.getItem(key);
        const prefs = parsePrefs(get(STORAGE_KEYS.prefs));
        let legacy = {};
        try { legacy = JSON.parse(get(STORAGE_KEYS.prefs) || '{}'); } catch { /* parsePrefs handles malformed state. */ }
        const lineup = get(STORAGE_KEYS.lineup) == null ? [
            { source: 'special', minScenes: 0, ids: ['new-releases', 'recently-added', 'movies', 'shorts'] },
            { source: 'studio', minScenes: settings.guide_min_scenes }
        ] : parseLineup(get(STORAGE_KEYS.lineup));
        store.dispatch({ type: Events.SETTINGS_LOADED, settings: { ...settings, guide_autoplay: false } });
        store.dispatch({ type: Events.PREFS_LOADED, prefs, lineup,
            pinOrder: get(STORAGE_KEYS.pinOrder) == null ? migratePinOrder(legacy) : parsePinOrder(get(STORAGE_KEYS.pinOrder)),
            sort: migrateSort(get(STORAGE_KEYS.sort)), collapsedGroups: []
        });
        const managerView = get(STORAGE_KEYS.managerView);
        store.dispatch({ type: Events.SET_MANAGER_VIEW, view: ['all', 'selected'].includes(managerView) ? managerView : 'active' });
        loaded = true;
        if (settings.guide_navbar_button) navbar.start();
        // Resolve selected channels for manager actions; no playback/pool effect
        // is allowed through MANAGEMENT_EFFECTS.
        run({ type: 'loadChannels' }, store.getState, store.dispatch);
        onHash();
    }).catch(() => { if (!disposed) announcer.announce('StashIP-TV channel settings could not be loaded. Reload Stash to retry.'); });
    return { ready, open, store, element: shell, destroy() {
        disposed = true; loaded = false; releaseFocus?.(); releaseFocus = null;
        window.removeEventListener('hashchange', onHash);
        document.removeEventListener('keydown', onKey);
        unsubscribe(); navbar.stop(); manager.destroy(); shell.remove(); store.destroy();
        announcer.element?.remove();
    } };
}
