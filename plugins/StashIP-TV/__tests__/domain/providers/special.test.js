import special from '../../../src/domain/providers/special.js';

describe('special provider', () => {
    it('builds the four virtual channels from the configured time windows and duration cutoffs', async () => {
        const channels = await special.listChannels(
            { source: 'special', ids: ['new-releases', 'recently-added', 'movies', 'shorts'] },
            null,
            {
                guide_new_release_days: 30,
                guide_recently_added_days: 14,
                guide_movie_min_minutes: 60,
                guide_short_max_minutes: 5
            },
            new Date('2026-08-25T12:00:00Z')
        );

        expect(channels).toEqual([
            expect.objectContaining({
                id: 'special:new-releases',
                name: 'New releases',
                sceneFilter: { date: { value: '2026-07-26', modifier: 'GREATER_THAN' } }
            }),
            expect.objectContaining({
                id: 'special:recently-added',
                name: 'Recently added',
                sceneFilter: { created_at: { value: '2026-08-11T12:00:00.000Z', modifier: 'GREATER_THAN' } }
            }),
            expect.objectContaining({
                id: 'special:movies',
                name: 'Movies',
                sceneFilter: { duration: { value: 3600, modifier: 'GREATER_THAN' } }
            }),
            expect.objectContaining({
                id: 'special:shorts',
                name: 'Shorts',
                sceneFilter: { duration: { value: 300, modifier: 'LESS_THAN' } }
            })
        ]);
    });

    it('exposes all special channels to the manager catalogue', async () => {
        const { channels, total } = await special.listCatalogPage({}, null, {
            guide_new_release_days: 30,
            guide_recently_added_days: 14,
            guide_movie_min_minutes: 60,
            guide_short_max_minutes: 5
        }, new Date('2026-08-25T12:00:00Z'));

        expect(total).toBe(5);
        expect(channels.map((channel) => channel.id)).toEqual([
            'special:all-scenes',
            'special:new-releases',
            'special:recently-added',
            'special:movies',
            'special:shorts'
        ]);
    });

    it('offers an unfiltered All Scenes channel as an explicit pick', async () => {
        const channels = await special.listChannels({ ids: ['all-scenes'] });
        expect(channels).toEqual([expect.objectContaining({ id: 'special:all-scenes', name: 'All Scenes', sceneFilter: {} })]);
    });
});
