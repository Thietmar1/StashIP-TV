import { startChannelManager } from '../../src/channelManager.js';
import { Events, STORAGE_KEYS } from '../../src/state/actions.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('channel-management-only browser entry', () => {
    let app;
    afterEach(() => { app?.destroy(); app = null; document.body.innerHTML = ''; window.location.hash = ''; });

    function client() {
        let configuration = { guide_05_navbar_button: true, iptv_04_token: 'keep-private-token', unknown_setting: 'keep', tvguide_state: {
            tvguide_lineup: JSON.stringify([{ source: 'studio', ids: ['1'] }]),
            tvguide_channel_prefs: JSON.stringify({ 'studio:1': { name: 'My channel' } }),
            tvguide_pin_order: JSON.stringify(['studio:1']), unknown_state: 'keep too'
        } };
        const gql = jest.fn(async (query, variables) => {
            if (query.includes('ConfigureTVGuide')) { configuration = variables.input; return { configurePlugin: configuration }; }
            if (query.includes('Configuration')) return { configuration: { plugins: { TVGuide: configuration } } };
            if (query.includes('TVGuideStudios')) return { findStudios: { count: 1, studios: [{ id: '1', name: 'Studio One', scene_count: 5 }] } };
            throw new Error('Unexpected browser request');
        });
        return { gql, config: () => configuration };
    }

    it('loads the existing lineup, opens the manager, and never creates or loads a browser player', async () => {
        document.body.innerHTML = '<nav><div class="navbar-nav"></div></nav><button id="before">Before</button>';
        const { gql } = client();
        app = startChannelManager({ gql });
        document.querySelector('#before').focus();
        await app.ready; await flush();
        app.open(); await flush();
        expect(app.element.hidden).toBe(false);
        expect(app.store.getState().prefs['studio:1'].name).toBe('My channel');
        expect(app.store.getState().pinOrder).toEqual(['studio:1']);
        expect(app.store.getState().managerView).toBe('active');
        expect(gql.mock.calls.some(([, args]) => args?.find?.per_page === 50)).toBe(false);
        expect(document.querySelector('.tvguide-manager')).not.toBeNull();
        expect(document.querySelector('video')).toBeNull();
        expect(document.querySelector('.tvguide-player')).toBeNull();
        expect(document.querySelector('.tvguide-grid')).toBeNull();
        expect(gql.mock.calls.some(([query]) => /TVGuideScene(?:Pool|Count|Index)/.test(query))).toBe(false);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(app.element.hidden).toBe(true);
        expect(document.activeElement.id).toBe('before');
    });

    it('persists channel changes without replacing IPTV settings or unknown stored values', async () => {
        const { gql, config } = client();
        app = startChannelManager({ gql });
        await app.ready; await flush();
        const lineup = [{ source: 'tag', ids: ['7'] }];
        app.store.dispatch({ type: Events.SET_LINEUP, lineup });
        await flush();
        expect(config().tvguide_state[STORAGE_KEYS.lineup]).toBe(JSON.stringify(lineup));
        expect(config().iptv_04_token).toBe('keep-private-token');
        expect(config().unknown_setting).toBe('keep');
        expect(config().tvguide_state.unknown_state).toBe('keep too');
    });

    it('restores the selected view after reopening the plugin', async () => {
        const { gql, config } = client();
        app = startChannelManager({ gql });
        await app.ready; await flush();
        app.store.dispatch({ type: Events.SET_MANAGER_VIEW, view: 'selected' });
        await flush();
        expect(config().tvguide_state[STORAGE_KEYS.managerView]).toBe('selected');
        app.destroy(); app = startChannelManager({ gql });
        await app.ready; await flush();
        expect(app.store.getState().managerView).toBe('selected');
    });

    it('opens a populated channel type when the previous type has no active channels', async () => {
        const { gql } = client();
        app = startChannelManager({ gql });
        await app.ready; await flush();
        app.store.dispatch({ type: Events.CHANNELS_LOADED, channels: [{ id: 'tag:7', source: 'tag', name: 'Live tag', sceneFilter: {}, sceneCount: 5 }] });
        app.open();
        expect(app.store.getState().managerSource).toBe('tag');
        expect(app.element.querySelector('[data-channel-id="tag:7"]')).not.toBeNull();
    });

    it('offers an explicit rename action, saves it without changing the source and resets to the source name', async () => {
        const { gql, config } = client();
        app = startChannelManager({ gql });
        await app.ready; await flush();
        app.open(); await flush();
        let row = app.element.querySelector('[data-channel-id="studio:1"]');
        row.querySelector('.tvguide-manager-rename').click();
        let form = row.querySelector('form');
        // Opening the editor rebuilds the catalogue rows.
        row = app.element.querySelector('[data-channel-id="studio:1"]');
        form = row.querySelector('form');
        const input = form.querySelector('input');
        expect(document.activeElement).toBe(input);
        input.value = '  My live channel & more  ';
        expect(config().tvguide_state.tvguide_channel_prefs).not.toContain('live channel');
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await flush();
        expect(JSON.parse(config().tvguide_state.tvguide_channel_prefs)['studio:1'].name).toBe('My live channel & more');
        expect(app.store.getState().allChannels[0].name).toBe('Studio One');
        expect(JSON.parse(config().tvguide_state.tvguide_lineup)).toEqual([{ source: 'studio', ids: ['1'] }]);
        expect(config().iptv_04_token).toBe('keep-private-token');
        row = app.element.querySelector('[data-channel-id="studio:1"]');
        expect(row.querySelector('.tvguide-manager-row-name').textContent).toBe('My live channel & more');
        [...row.querySelectorAll('button')].find((button) => button.textContent === 'Reset name').click();
        await flush();
        expect(app.element.querySelector('[data-channel-id="studio:1"] .tvguide-manager-row-name').textContent).toBe('Studio One');
        expect(JSON.parse(config().tvguide_state.tvguide_channel_prefs)['studio:1']).toBeUndefined();
    });

    it('does not resurrect the browser UI when destroyed during settings loading', async () => {
        let resolve;
        const pending = new Promise((done) => { resolve = done; });
        app = startChannelManager({ gql: () => pending });
        app.destroy();
        resolve({ configuration: { plugins: { TVGuide: {} } } });
        await app.ready;
        expect(document.querySelector('.tvguide-manager-shell')).toBeNull();
        expect(document.querySelector('#tvguide-navbar-button')).toBeNull();
    });
});
