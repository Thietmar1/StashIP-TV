import { sceneTitle } from '../api/scenes.js';
import * as sel from '../state/selectors.js';
import { demoName as alias, demoDescription as description, demoArtwork, demoStudioWordmark } from './demoContent.js';
import { mapKey, isTextEntry, Intents } from './keyboard.js';

// This is a presentation-only filter. Renderers, event closures, schedules and
// saved metadata always retain the real values. Only the mounted guide is read;
// no library scan or extra metadata fetch is needed.
const program = (text) => alias('Program', text);
const status = new Set(['Loading…', 'No programming', 'Unable to load programming', 'Nothing scheduled']);

const textRules = (channel) => [
    ['.tvguide-row-name, .tvguide-logo-name, .tvguide-banner-logo-name, .tvguide-list-channel, .tvguide-recent-name, .tvguide-manager-row-name', channel],
    ['.tvguide-block-title, .tvguide-banner-title, .tvguide-list-now, .tvguide-featuring .tvguide-related-chip', program],
    ['.tvguide-channel-info-program, .tvguide-recent-now', (text) => status.has(text) ? text : program(text)],
    ['.tvguide-banner-details, .tvguide-list-details, .tvguide-channel-info-description', description],
    ['.tvguide-logo-monogram', (text) => text.trim() ? 'TV' : text],
    ['.tvguide-related[data-source="performer"] .tvguide-related-chip', (text) => alias('Person', text)],
    ['.tvguide-related[data-source="tag"] .tvguide-related-chip', (text) => alias('Tag', text)],
    ['.tvguide-channel-info-name', (text) => text.replace(/^(CH \d+ · )([\s\S]*)$/, (_, prefix, name) => prefix + channel(name))],
    // Preserve clocks whether a renderer uses one text node or several.
    ['.tvguide-banner-meta', (text) => text.replace(/^([\s\S]*?)( · \d{1,2}:\d{2}[\s\S]*)$/, (_, name, times) => channel(name) + times)],
    ['.tvguide-list-times', (text) => text.replace(/^([\s\S]*? · Next \d{1,2}:\d{2}(?: [AP]M)?: )([\s\S]*)$/, (_, prefix, title) => prefix + program(title))],
    ['.tvguide-manager-row-meta', (text) => text.endsWith(' · ') ? channel(text.slice(0, -3)) + ' · ' : text],
    ['.tvguide-banner-empty', (text) => text.endsWith(' has nothing scheduled.') ? 'Channel has nothing scheduled.' : text]
];

/** Demo presentation, including updates outside store renders. */
export function createSfwText({ root, getState }) {
    // Keep originals outside the DOM, and preserve the player's persistent text
    // nodes. Replacing its subtree can interrupt native fullscreen playback.
    const originals = new Map();
    const mediaMute = new Map();
    const studioNames = new Map();
    const channel = (text) => studioNames.has(text)
        ? alias('Studio', studioNames.get(text)) : alias('Channel', text);
    let destroyed = false;
    const read = (node, key) => key.startsWith('@') ? node.getAttribute(key.slice(1)) : node[key];
    const write = (node, key, value) => {
        if (!key.startsWith('@')) node[key] = value;
        else if (value === null) node.removeAttribute(key.slice(1));
        else node.setAttribute(key.slice(1), value);
    };
    function replace(node, key, transform) {
        const current = read(node, key);
        const fields = originals.get(node) || new Map();
        const previous = fields.get(key);
        const original = previous && current === previous.masked ? previous.original : current;
        const masked = transform(original);
        if (masked !== current) write(node, key, masked);
        fields.set(key, { original, masked });
        originals.set(node, fields);
    }
    function texts(selector, transform) {
        for (const element of root.querySelectorAll(selector)) {
            for (const node of element.childNodes) {
                if (node.nodeType === 3) replace(node, 'data', transform);
            }
        }
    }
    function attributes(selector, name, transform) {
        for (const element of root.querySelectorAll(selector)) {
            if (element.hasAttribute(name)) replace(element, `@${name}`, transform);
        }
    }
    function restore() {
        for (const [node, fields] of originals) {
            if (!root.contains(node)) continue;
            for (const [key, { original, masked }] of fields) {
                if (read(node, key) === masked) write(node, key, original);
            }
        }
        originals.clear();
        for (const [video, muted] of mediaMute) video.muted = muted;
        mediaMute.clear();
    }
    const enforceMute = (event) => {
        if (getState().settings.guide_sfw_text && event.target.matches?.('video, audio')) {
            if (!mediaMute.has(event.target)) mediaMute.set(event.target, event.target.muted);
            if (!event.target.muted) event.target.muted = true;
        }
    };
    // Capture runs before SFW Switch reflects the media state into the store.
    for (const type of ['volumechange', 'play', 'loadedmetadata']) root.addEventListener(type, enforceMute, true);
    const preventExit = (event) => {
        if (getState().settings.guide_sfw_text && event.target.closest?.('.tvguide-watch, .tvguide-banner-logo-button, .tvguide-manager-row-name[href]')) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };
    root.addEventListener('click', preventExit, true);
    root.addEventListener('auxclick', preventExit, true);
    const onKeydown = (event) => {
        const state = getState();
        if (!state.open || !state.settings.guide_sfw_text || isTextEntry(event.target)) return;
        if ([Intents.EXPAND, Intents.MUTE].includes(mapKey(event))) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };
    // Installed before the guide's keyboard handler at the composition root.
    root.ownerDocument.addEventListener('keydown', onKeydown, true);
    const observer = new MutationObserver(refresh);
    function refresh() {
        if (destroyed) return;
        observer.disconnect();
        const enabled = Boolean(getState().settings.guide_sfw_text);
        root.classList.toggle('tvguide-demo', enabled);
        if (!enabled) {
            restore();
            return;
        }
        // Detached rows must not accumulate as the guide is scrolled/rebuilt.
        for (const node of originals.keys()) if (!root.contains(node)) originals.delete(node);
        const state = getState();
        const tuned = sel.tunedChannel(state);
        const playing = sel.tunedProgram(state);
        // Only inspect channels already loaded for the guide/manager and the
        // two visible scenes; never scan scene pools or request extra details.
        studioNames.clear();
        const studioArtwork = new Map();
        for (const item of [
            ...(state.catalog.studio || []), ...sel.catalogPage(state, 'studio').channels,
            ...state.allChannels
        ]) {
            if (item.source !== 'studio') continue;
            studioNames.set(item.name, item.name);
            const pref = state.prefs[item.id];
            if (pref?.name) studioNames.set(pref.name, item.name);
            if (item.logo?.type === 'image') studioArtwork.set(item.logo.url, item.name);
            if (pref?.logoUrl) studioArtwork.set(pref.logoUrl, item.name);
        }
        for (const studio of [playing?.scene.studio, sel.focusedProgram(state)?.scene.studio]) {
            if (studio?.name && studio.image_path) studioArtwork.set(studio.image_path, studio.name);
        }
        for (const [selector, transform] of textRules(channel)) texts(selector, transform);

        const caption = tuned ? channel(tuned.name) + (playing ? ` · ${program(sceneTitle(playing.scene))}` : '') : '';
        texts('.tvguide-player-caption', () => caption);
        texts('.tvguide-channel-info-performers', () => (playing?.scene.performers || [])
            .filter((person) => person?.name?.trim()).map((person) => alias('Person', person.name)).join(', '));
        texts('[aria-live]', (text) => text.trim() ? (caption || 'Channel changed.') + (text.endsWith(' ') ? ' ' : '') : text);

        attributes('.tvguide-block', 'aria-label', (text) => text.replace(/^([\s\S]*)(, \d{1,2}:\d{2}[^,]*)$/, (_, title, times) => program(title) + times));
        for (const name of ['title', 'aria-label']) {
            attributes('.tvguide-row-name, .tvguide-logo-button, .tvguide-banner-logo-button, .tvguide-manager-row-name, .tvguide-manager-row-actions button, .tvguide-pin', name,
                (text) => {
                    if (text.startsWith('Save temporary channel ')) return 'Save temporary ' + channel(text.slice(23));
                    if (text.endsWith(' saved')) return channel(text.slice(0, -6)) + ' saved';
                    return text.replace(/^(Watch |Open |Unpin |Pin |Hide |Show |Customise )([\s\S]*?)( in Stash| to the top)?$/, (_, action, value, suffix = '') => action + channel(value) + suffix);
                });
            attributes('.tvguide-related-chip', name, (text) => {
                if (text.startsWith('Pin ') && text.endsWith(' details')) return `Pin ${program(text.slice(4, -8))} details`;
                return text;
            });
            for (const [source, kind] of [['performer', 'Person'], ['tag', 'Tag']]) {
                attributes(`.tvguide-related[data-source="${source}"] .tvguide-related-chip`, name,
                    (text) => text.startsWith('Tune to ') ? 'Tune to ' + alias(kind, text.slice(8)) : text);
            }
        }
        attributes('img', 'alt', (text) => alias('Studio', text));

        for (const image of root.querySelectorAll('img')) {
            let studioName = null;
            replace(image, '@src', (source) => {
                const poster = image.classList.contains('tvguide-banner-poster');
                studioName = !poster && (image.classList.contains('tvguide-channel-info-studio')
                    ? playing?.scene.studio?.name : studioArtwork.get(source));
                return studioName ? demoStudioWordmark(studioName) : demoArtwork(source || '', poster);
            });
            if (studioName) {
                replace(image, '@alt', () => alias('Studio', studioName));
                replace(image, '@title', () => alias('Studio', studioName));
            }
            replace(image, '@srcset', () => null);
        }
        for (const video of root.querySelectorAll('video, audio')) {
            enforceMute({ target: video });
            replace(video, 'disablePictureInPicture', () => true);
            replace(video, 'disableRemotePlayback', () => true);
            replace(video, '@poster', () => null);
        }
        // Keep the layout, but don't let a demo click open unmasked Stash pages
        // or write an unmute preference. Channel surfing stays functional.
        for (const button of root.querySelectorAll('.tvguide-watch, .tvguide-banner-logo-button, .tvguide-mute')) {
            replace(button, 'disabled', () => true);
            replace(button, '@title', () => 'Unavailable in demo mode');
        }
        attributes('.tvguide-mute', 'aria-label', () => 'Muted in demo mode');
        attributes('.tvguide-mute', 'aria-pressed', () => 'true');
        for (const link of root.querySelectorAll('a.tvguide-manager-row-name')) {
            replace(link, '@href', () => null);
            replace(link, '@aria-disabled', () => 'true');
            replace(link, '@title', () => 'Unavailable in demo mode');
        }

        // Mask entered searches without changing their values or dispatching
        // events. Searches still operate on the real library names.
        for (const input of root.querySelectorAll('.tvguide-search, .tvguide-manager-search')) {
            replace(input, '@type', () => 'password');
        }
        for (const input of root.querySelectorAll('.tvguide-manager-editor input[type="text"], .tvguide-manager-editor input[type="url"]')) {
            replace(input, 'value', () => '');
            replace(input, '@value', () => '');
            replace(input, 'disabled', () => true);
            replace(input, '@placeholder', () => 'Hidden in demo mode');
            replace(input, '@title', () => 'Turn off demo mode to edit');
        }
        observer.observe(root, {
            subtree: true, childList: true, characterData: true, attributes: true,
            attributeFilter: ['title', 'aria-label', 'alt', 'placeholder', 'value', 'type', 'src', 'srcset', 'poster']
        });
    }
    refresh();
    return {
        refresh,
        destroy() {
            destroyed = true;
            observer.disconnect();
            for (const type of ['volumechange', 'play', 'loadedmetadata']) root.removeEventListener(type, enforceMute, true);
            root.removeEventListener('click', preventExit, true);
            root.removeEventListener('auxclick', preventExit, true);
            root.ownerDocument.removeEventListener('keydown', onKeydown, true);
            root.classList.remove('tvguide-demo');
            restore();
        }
    };
}
