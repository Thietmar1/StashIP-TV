import { sourceUrl, openSource } from '../../src/ui/sourceLink.js';

const chan = (id, source) => ({ id, source, name: 'X' });

describe('sourceUrl', () => {
    it.each([
        ['studio:42', 'studio', '/studios/42'],
        ['performer:9', 'performer', '/performers/9'],
        ['tag:12', 'tag', '/tags/12'],
        ['group:3', 'group', '/groups/3']
    ])('maps %s to its Stash page', (id, source, expected) => {
        expect(sourceUrl(chan(id, source))).toBe(expected);
    });

    it('has no page for a saved filter, so it links nowhere', () => {
        // Saved filters have no detail route; guessing one would 404.
        expect(sourceUrl(chan('savedFilter:1', 'savedFilter'))).toBeNull();
    });

    it('keeps the id intact when it contains a colon', () => {
        expect(sourceUrl(chan('tag:a:b', 'tag'))).toBe('/tags/a:b');
    });
});

describe('openSource', () => {
    it('opens the page in a new tab, so the guide keeps playing', () => {
        const open = jest.fn();
        openSource(chan('studio:42', 'studio'), open);
        expect(open).toHaveBeenCalledWith('/studios/42');
    });

    it('does nothing for a source with no page', () => {
        const open = jest.fn();
        expect(openSource(chan('savedFilter:1', 'savedFilter'), open)).toBeNull();
        expect(open).not.toHaveBeenCalled();
    });
});
