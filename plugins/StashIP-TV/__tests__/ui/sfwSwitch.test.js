import { readFileSync } from 'node:fs';
import { watchSfwSwitch } from '../../src/ui/sfwSwitch.js';
import { createStore } from '../../src/state/store.js';
import { createInitialState } from '../../src/state/initialState.js';

describe('SFW Switch compatibility', () => {
    let stop;
    let sheets;
    let descriptor;
    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        descriptor = Object.getOwnPropertyDescriptor(document, 'styleSheets');
        sheets = [];
        Object.defineProperty(document, 'styleSheets', { configurable: true, get: () => sheets });
    });
    afterEach(() => {
        stop?.();
        stop = null;
        if (descriptor) Object.defineProperty(document, 'styleSheets', descriptor);
        else delete document.styleSheets;
        jest.useRealTimers();
    });
    function setup() {
        const root = document.createElement('div');
        const video = document.createElement('video');
        root.appendChild(video);
        document.body.appendChild(root);
        const effects = jest.fn();
        const store = createStore({ runEffect: effects, initialState: { ...createInitialState(), muted: false } });
        stop = watchSfwSwitch({ root, video, store });
        return { root, video, store, effects };
    }

    it('leaves the guide unchanged without the plugin, and detects a late-loaded stylesheet', () => {
        const { root } = setup();
        expect(root.classList.contains('tvguide-sfw')).toBe(false);
        sheets.push({ href: '/plugin/sfwswitch/css', disabled: false });
        jest.advanceTimersByTime(200);
        expect(root.classList.contains('tvguide-sfw')).toBe(true);
        sheets[0].disabled = true;
        jest.advanceTimersByTime(200);
        expect(root.classList.contains('tvguide-sfw')).toBe(false);
    });

    it('follows the live switch click immediately and honors never-unblur', async () => {
        sheets.push({ href: '/plugin/sfwswitch/css', disabled: true });
        const { root } = setup();
        const button = document.createElement('button');
        button.id = 'plugin_sfw';
        button.addEventListener('click', () => { sheets[0].disabled = !sheets[0].disabled; });
        document.body.appendChild(button);
        button.click();
        expect(root.classList.contains('tvguide-sfw')).toBe(true);
        expect(root.classList.contains('tvguide-sfw-locked')).toBe(false);
        const locked = document.createElement('style');
        locked.id = 'sfw-never-unblur';
        document.head.appendChild(locked);
        await Promise.resolve();
        expect(root.classList.contains('tvguide-sfw-locked')).toBe(true);
        locked.remove();
        await Promise.resolve();
        expect(root.classList.contains('tvguide-sfw-locked')).toBe(false);
        button.click();
        expect(root.classList.contains('tvguide-sfw')).toBe(false);
    });

    it('reflects external muting without persisting it or issuing another volume command', () => {
        const { video, store, effects } = setup();
        video.muted = true;
        video.dispatchEvent(new Event('volumechange'));
        expect(store.getState().muted).toBe(true);
        expect(effects).not.toHaveBeenCalled();
        video.muted = false;
        video.dispatchEvent(new Event('volumechange'));
        expect(store.getState().muted).toBe(false);
        expect(effects).not.toHaveBeenCalled();
    });

    it('cleans up its observers and volume synchronization', () => {
        sheets.push({ href: '/plugin/sfwswitch/css', disabled: false });
        const { root, video, store } = setup();
        stop();
        video.muted = true;
        video.dispatchEvent(new Event('volumechange'));
        jest.advanceTimersByTime(1000);
        expect(root.classList.contains('tvguide-sfw')).toBe(false);
        expect(store.getState().muted).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });
});

it('blurs media and scene text without blurring the fullscreen stage or its controls', () => {
    document.head.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = readFileSync('src/styles/sfwSwitch.css', 'utf8');
    document.head.appendChild(style);
    document.body.innerHTML = `<div class="tvguide-sfw tvguide-sfw-locked">
        <div class="tvguide-player-stage"><video></video><canvas></canvas><button>Mute</button></div>
        <img><span class="tvguide-channel-info-program">Scene title</span>
    </div>`;
    for (const selector of ['video', 'canvas', 'img']) {
        expect(getComputedStyle(document.querySelector(selector)).filter).toBe('blur(30px)');
    }
    expect(getComputedStyle(document.querySelector('span')).filter).toBe('blur(2px)');
    expect(getComputedStyle(document.querySelector('button')).filter).toBe('');
    expect(getComputedStyle(document.querySelector('.tvguide-player-stage')).filter).toBe('');
    style.remove();
    document.body.innerHTML = '';
});
