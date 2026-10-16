import { createClient, StashApiError } from '../../src/api/client.js';

const QUERY = 'query FindThings { findThings { id } }';

function mockFetch(impl) {
    return jest.fn(impl);
}

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });

describe('createClient', () => {
    it('posts the query and variables to /graphql', async () => {
        const fetchFn = mockFetch(async () => ok({ findThings: [] }));
        const gql = createClient({ fetchFn });

        await gql(QUERY, { a: 1 });

        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe('/graphql');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('same-origin');
        expect(JSON.parse(init.body)).toEqual({ query: QUERY, variables: { a: 1 } });
    });

    it('returns the data payload', async () => {
        const gql = createClient({ fetchFn: mockFetch(async () => ok({ findThings: [{ id: '1' }] })) });
        expect(await gql(QUERY)).toEqual({ findThings: [{ id: '1' }] });
    });

    it('honours a custom endpoint', async () => {
        const fetchFn = mockFetch(async () => ok({}));
        await createClient({ fetchFn, endpoint: '/sub/graphql' })(QUERY);
        expect(fetchFn.mock.calls[0][0]).toBe('/sub/graphql');
    });

    it('names the failing operation when the network fails', async () => {
        const gql = createClient({
            fetchFn: mockFetch(async () => {
                throw new Error('offline');
            })
        });
        await expect(gql(QUERY)).rejects.toThrow(/FindThings: network request failed \(offline\)/);
        await expect(gql(QUERY)).rejects.toBeInstanceOf(StashApiError);
    });

    it('reports a non-ok HTTP status', async () => {
        const gql = createClient({ fetchFn: mockFetch(async () => ({ ok: false, status: 401 })) });
        await expect(gql(QUERY)).rejects.toThrow(/FindThings: HTTP 401/);
    });

    it('surfaces the first GraphQL error', async () => {
        const gql = createClient({
            fetchFn: mockFetch(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ errors: [{ message: 'unknown field' }] })
            }))
        });
        await expect(gql(QUERY)).rejects.toThrow(/FindThings: unknown field/);
    });

    it('falls back to "anonymous" for an unnamed operation', async () => {
        const gql = createClient({ fetchFn: mockFetch(async () => ({ ok: false, status: 500 })) });
        await expect(gql('{ findThings { id } }')).rejects.toThrow(/anonymous: HTTP 500/);
    });

    it('uses global fetch when none is injected', async () => {
        const original = globalThis.fetch;
        globalThis.fetch = mockFetch(async () => ok({ ping: true }));
        try {
            expect(await createClient()(QUERY)).toEqual({ ping: true });
        } finally {
            globalThis.fetch = original;
        }
    });
});
