import { createPoolCache } from '../../src/api/cache.js';

/** Minimal Storage stand-in with the bits the cache actually uses. */
function memoryStorage(overrides = {}) {
    const map = new Map();
    return {
        get length() {
            return map.size;
        },
        key: (i) => Array.from(map.keys())[i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
        removeItem: (k) => map.delete(k),
        _map: map,
        ...overrides
    };
}

const scenes = [{ id: '1' }, { id: '2' }];

describe('createPoolCache', () => {
    it('keeps edited metadata across reloads without rewriting or refetching scene pools', () => {
        const storage = memoryStorage();
        const cache = createPoolCache({ storage });
        const scenes = [{ id: '1', title: 'Before', files: [{ duration: 1800 }] }];
        cache.set('studio:1', 'day', scenes);
        cache.updateMetadata([{ id: '1', title: 'After' }]);
        expect(JSON.parse(storage.getItem('tvguide:pool:studio:1:day'))).toEqual(scenes);
        const reloaded = createPoolCache({ storage });
        expect(reloaded.get('studio:1', 'day')).toEqual([{ ...scenes[0], title: 'After' }]);
        expect(reloaded.getMetadata()).toEqual({ '1': { id: '1', title: 'After' } });
    });

    it('round-trips a pool', () => {
        const cache = createPoolCache({ storage: memoryStorage() });
        cache.set('studio:1', '2026-08-22', scenes);
        expect(cache.get('studio:1', '2026-08-22')).toEqual(scenes);
    });

    it('misses for a different channel or a different day', () => {
        const cache = createPoolCache({ storage: memoryStorage() });
        cache.set('studio:1', '2026-08-22', scenes);
        expect(cache.get('studio:2', '2026-08-22')).toBeNull();
        expect(cache.get('studio:1', '2026-08-23')).toBeNull();
    });

    it('returns null on a miss', () => {
        expect(createPoolCache({ storage: memoryStorage() }).get('nope', 'x')).toBeNull();
    });

    it('clears only its own keys', () => {
        const storage = memoryStorage();
        storage.setItem('unrelated', 'keep me');
        const cache = createPoolCache({ storage });
        cache.set('studio:1', '2026-08-22', scenes);

        cache.clear();

        expect(cache.get('studio:1', '2026-08-22')).toBeNull();
        expect(storage.getItem('unrelated')).toBe('keep me');
    });

    it('drops the cache instead of throwing when storage is full', () => {
        const storage = memoryStorage();
        const cache = createPoolCache({ storage });
        cache.set('studio:1', '2026-08-22', scenes);

        storage.setItem = () => {
            throw new Error('QuotaExceededError');
        };

        expect(() => cache.set('studio:2', '2026-08-22', scenes)).not.toThrow();
        expect(cache.get('studio:1', '2026-08-22')).toBeNull();
    });

    it('survives unreadable or corrupt entries', () => {
        const storage = memoryStorage();
        const cache = createPoolCache({ storage });
        storage.setItem('tvguide:pool:studio:1:2026-08-22', 'not json');
        expect(cache.get('studio:1', '2026-08-22')).toBeNull();
    });

    it('survives a storage that throws on clear', () => {
        const cache = createPoolCache({
            storage: memoryStorage({
                key: () => {
                    throw new Error('denied');
                }
            })
        });
        expect(() => cache.clear()).not.toThrow();
    });

    it('degrades to a no-op cache when storage is unavailable', () => {
        const cache = createPoolCache({ storage: null });
        expect(() => cache.set('studio:1', '2026-08-22', scenes)).not.toThrow();
        expect(cache.get('studio:1', '2026-08-22')).toBeNull();
        expect(() => cache.clear()).not.toThrow();
    });

    it('uses sessionStorage by default', () => {
        const cache = createPoolCache();
        cache.set('studio:9', '2026-08-22', scenes);
        expect(cache.get('studio:9', '2026-08-22')).toEqual(scenes);
        cache.clear();
    });
});
