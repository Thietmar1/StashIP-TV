/**
 * Server-backed storage for guide preferences.
 *
 * Stash's configurePlugin mutation replaces a plugin's entire configuration,
 * so each write first fetches the current config and merges our state into it.
 */

import { PLUGIN_ID } from './settings.js';

export const PLUGIN_STATE_KEY = 'tvguide_state';

const CONFIGURATION_QUERY = `query TVGuideConfiguration { configuration { plugins } }`;
const CONFIGURE_PLUGIN_MUTATION = `
    mutation ConfigureTVGuide($pluginId: ID!, $input: Map!) {
        configurePlugin(plugin_id: $pluginId, input: $input)
    }
`;

function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function createPluginStorage({ gql, initialConfiguration } = {}) {
    let state = { ...objectOrEmpty(initialConfiguration?.[PLUGIN_STATE_KEY]) };
    let pending = Promise.resolve();

    async function save(changes) {
        const data = await gql(CONFIGURATION_QUERY);
        const configuration = objectOrEmpty(data?.configuration?.plugins?.[PLUGIN_ID]);
        const remoteState = objectOrEmpty(configuration[PLUGIN_STATE_KEY]);
        await gql(CONFIGURE_PLUGIN_MUTATION, {
            pluginId: PLUGIN_ID,
            input: { ...configuration, [PLUGIN_STATE_KEY]: { ...remoteState, ...changes } }
        });
    }

    return {
        getItem(key) {
            return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
        },

        setItem(key, value) {
            state = { ...state, [key]: String(value) };
            const changes = { [key]: String(value) };
            // A rapid sequence of UI changes must retain its order. Errors are
            // intentionally swallowed: a temporary persistence failure must
            // not interrupt playback or block later saves.
            pending = pending.catch(() => undefined).then(() => save(changes));
            return pending.catch(() => undefined);
        }
    };
}
