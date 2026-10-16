import { sceneMetadata, mergeSceneMetadata, watchSceneMetadata } from '../../src/api/sceneMetadata.js';

function harness(onScenes = jest.fn()) {
    class Link {
        constructor(request) { this.request = request; }
        concat(next) { return new Link((op) => this.request(op, (o) => next.request(o))); }
    }
    const original = new Link((op) => ({ map: (fn) => fn(op.response) }));
    const client = { link: original, setLink(link) { this.link = link; } };
    const messages = [];
    class Channel {
        constructor() { messages.push(this); }
        postMessage = jest.fn();
        close = jest.fn();
    }
    const stop = watchSceneMetadata({ onScenes, BroadcastChannelClass: Channel,
        pluginApi: { utils: { StashService: { getClient: () => client } }, libraries: { Apollo: { ApolloLink: Link } } } });
    const send = (response, operation = 'mutation') => client.link.request({ query: { definitions: [{ operation }] }, response });
    return { client, original, messages, onScenes, stop, send };
}

it('reuses single and bulk edit responses and broadcasts only presentation metadata', () => {
    const h = harness();
    const response = { data: { bulkSceneUpdate: [
        { __typename: 'Scene', id: '1', title: 'Edited', details: '', tags: [], files: [{ duration: 3 }], paths: { screenshot: '/new.jpg', stream: '/new.mp4' } },
        { __typename: 'Scene', id: '2', title: 'Also edited' }
    ] } };
    expect(h.send(response)).toBe(response);
    const patches = [{ id: '1', title: 'Edited', details: '', tags: [], paths: { screenshot: '/new.jpg' } }, { id: '2', title: 'Also edited' }];
    expect(h.onScenes).toHaveBeenCalledWith(patches);
    expect(h.messages[0].postMessage).toHaveBeenCalledWith(patches);
    h.stop();
    expect(h.client.link).toBe(h.original);
    expect(h.messages[0].close).toHaveBeenCalled();
});

it('does not intercept ordinary queries or failed mutations', () => {
    const h = harness();
    const response = { data: { sceneUpdate: { __typename: 'Scene', id: '1', title: 'Edited' } } };
    h.send(response, 'query');
    h.send({ ...response, errors: [{ message: 'Failed' }] });
    expect(h.onScenes).not.toHaveBeenCalled();
    h.stop();
});

it('receives edits from another tab without rebroadcasting them', () => {
    const h = harness();
    h.messages[0].onmessage({ data: [{ id: '1', title: 'From another tab' }] });
    expect(h.onScenes).toHaveBeenCalledWith([{ id: '1', title: 'From another tab' }]);
    expect(h.messages[0].postMessage).not.toHaveBeenCalled();
    h.stop();
});

it('leaves Stash responses intact if a plugin callback fails', () => {
    const h = harness(() => { throw new Error('View failed'); });
    const response = { data: { sceneUpdate: { __typename: 'Scene', id: '1', title: 'Edited' } } };
    expect(h.send(response)).toBe(response);
    h.stop();
});

it('does not remove another plugin link on teardown', () => {
    const h = harness();
    const other = { request: h.client.link.request };
    h.client.setLink(other);
    h.stop();
    expect(h.client.link).toBe(other);
    h.send({ data: { sceneUpdate: { __typename: 'Scene', id: '1', title: 'Edited' } } });
    expect(h.onScenes).not.toHaveBeenCalled();
});

it('degrades to a no-op without the Stash plugin API', () => {
    expect(() => watchSceneMetadata({ pluginApi: null })()).not.toThrow();
});

it('merges partial edits, including cleared fields, without changing streams or timing', () => {
    const scene = { id: '1', title: 'Before', details: 'Before', files: [{ duration: 1800 }], paths: { stream: '/playing', screenshot: '/old' } };
    const next = mergeSceneMetadata(scene, sceneMetadata({ id: '1', details: '', tags: [], paths: { screenshot: '/new', stream: '/other' }, files: [] }));
    expect(next).toEqual({ ...scene, details: '', tags: [], paths: { stream: '/playing', screenshot: '/new' } });
    expect(next.files).toBe(scene.files);
    expect(mergeSceneMetadata(next, sceneMetadata(next))).toBe(next);
});

it('does not apply an older edit over a newer server result', () => {
    const scene = { id: '1', title: 'Latest', updated_at: '2026-10-03T13:00:00Z' };
    expect(mergeSceneMetadata(scene, { id: '1', title: 'Older', updated_at: '2026-10-03T12:00:00Z' })).toBe(scene);
});
