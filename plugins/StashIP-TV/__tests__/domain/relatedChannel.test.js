import { relatedChannel } from '../../src/domain/relatedChannel.js';

describe('relatedChannel', () => {
    it('creates a model channel with a non-hierarchical performer filter', () => {
        expect(relatedChannel('performer', { id: '7', name: 'Avery Lane' })).toMatchObject({
            id: 'performer:7',
            source: 'performer',
            name: 'Avery Lane',
            sceneFilter: { performers: { value: ['7'], modifier: 'INCLUDES' } }
        });
    });

    it('creates a tag channel with a hierarchical tag filter', () => {
        expect(relatedChannel('tag', { id: '9', name: 'Outdoor' }).sceneFilter).toEqual({
            tags: { value: ['9'], modifier: 'INCLUDES', depth: -1 }
        });
    });

    it('uses a related entity image immediately when one is available', () => {
        expect(relatedChannel('performer', {
            id: '7', name: 'Avery Lane', image_path: '/performer/7/image?t=1'
        }).logo).toEqual({ type: 'image', url: '/performer/7/image?t=1' });
    });

    it('rejects unsupported sources and incomplete scene entities', () => {
        expect(relatedChannel('studio', { id: '1', name: 'Studio' })).toBeNull();
        expect(relatedChannel('tag', { id: '', name: 'Outdoor' })).toBeNull();
        expect(relatedChannel('performer', { id: '1', name: '   ' })).toBeNull();
    });
});
