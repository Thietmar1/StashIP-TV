/**
 * Thin GraphQL client for the Stash API.
 *
 * The guide runs inside the Stash page, so session cookies authenticate us and
 * there is no key to manage. Errors are surfaced rather than swallowed: a
 * channel that cannot load should say so, not sit empty and look broken.
 */

export class StashApiError extends Error {
    constructor(message, { query, status } = {}) {
        super(message);
        this.name = 'StashApiError';
        this.query = query;
        this.status = status;
    }
}

/** Pull a readable operation name out of a query for error messages. */
function operationName(query) {
    const match = /(?:query|mutation)\s+(\w+)/.exec(query || '');
    return match ? match[1] : 'anonymous';
}

export function createClient({ fetchFn, endpoint = '/graphql' } = {}) {
    const doFetch = fetchFn || ((...args) => globalThis.fetch(...args));

    return async function gql(query, variables) {
        let response;
        try {
            response = await doFetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ query, variables })
            });
        } catch (cause) {
            throw new StashApiError(
                `${operationName(query)}: network request failed (${cause.message})`,
                { query }
            );
        }

        if (!response.ok) {
            throw new StashApiError(`${operationName(query)}: HTTP ${response.status}`, {
                query,
                status: response.status
            });
        }

        const json = await response.json();

        if (json.errors && json.errors.length > 0) {
            throw new StashApiError(`${operationName(query)}: ${json.errors[0].message}`, { query });
        }

        return json.data;
    };
}
