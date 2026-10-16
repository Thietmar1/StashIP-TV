import { createPluginStorage, PLUGIN_STATE_KEY } from '../../src/api/pluginStorage.js';

describe('createPluginStorage', () => {
    it('preserves plugin settings while saving guide state on the server', async () => {
        const gql = jest.fn(async (query, variables) => {
            if (query.startsWith('query')) {
                return {
                    configuration: {
                        plugins: {
                            TVGuide: {
                                guide_window_hours: 6,
                                guide_autoplay: false,
                                [PLUGIN_STATE_KEY]: { tvguide_muted: 'true' }
                            }
                        }
                    }
                };
            }
            return { configurePlugin: variables.input };
        });
        const storage = createPluginStorage({ gql });

        await storage.setItem('tvguide_muted', 'false');

        expect(gql).toHaveBeenLastCalledWith(
            expect.stringContaining('configurePlugin'),
            {
                pluginId: 'TVGuide',
                input: {
                    guide_window_hours: 6,
                    guide_autoplay: false,
                    [PLUGIN_STATE_KEY]: { tvguide_muted: 'false' }
                }
            }
        );
    });

    it('merges a local change with state saved by another browser', async () => {
        const gql = jest.fn(async (query, variables) => {
            if (query.startsWith('query')) {
                return {
                    configuration: {
                        plugins: {
                            TVGuide: {
                                guide_window_hours: 3,
                                [PLUGIN_STATE_KEY]: { tvguide_muted: 'false' }
                            }
                        }
                    }
                };
            }
            return { configurePlugin: variables.input };
        });
        const storage = createPluginStorage({ gql });

        await storage.setItem('tvguide_player_width', '320');

        expect(gql).toHaveBeenLastCalledWith(
            expect.stringContaining('configurePlugin'),
            expect.objectContaining({
                input: expect.objectContaining({
                    [PLUGIN_STATE_KEY]: {
                        tvguide_muted: 'false',
                        tvguide_player_width: '320'
                    }
                })
            })
        );
    });
});
