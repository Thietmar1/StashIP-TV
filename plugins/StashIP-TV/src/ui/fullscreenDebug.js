/** Opt-in local diagnostics; never records scene names, URLs, or network data. */
export function createFullscreenDebug({ stage, video, getState, doc = document }) {
    const trace = [];
    let cleanups = [];
    function record(event, extra = {}) {
        const state = getState();
        trace.push({
            time: new Date().toISOString(), event,
            mode: state.playerMode,
            fullscreen: doc.fullscreenElement === stage ? 'stage' : doc.fullscreenElement ? 'other' : 'none',
            stageConnected: stage.isConnected,
            readyState: video.readyState,
            ...extra
        });
        if (trace.length > 100) trace.shift();
    }
    function stop() {
        cleanups.splice(0).forEach((cleanup) => cleanup());
    }
    return {
        trace,
        start() {
            stop();
            trace.length = 0;
            for (const name of ['exitFullscreen', 'webkitExitFullscreen']) {
                const original = doc[name];
                if (typeof original !== 'function') continue;
                const ownDescriptor = Object.getOwnPropertyDescriptor(doc, name);
                const wrapped = function (...args) {
                    record(name, { stack: new Error('Fullscreen exit requested').stack });
                    return original.apply(this, args);
                };
                doc[name] = wrapped;
                cleanups.push(() => {
                    if (doc[name] !== wrapped) return;
                    if (ownDescriptor) Object.defineProperty(doc, name, ownDescriptor);
                    else delete doc[name];
                });
            }
            for (const [target, events] of [
                [doc, ['fullscreenchange', 'webkitfullscreenchange']],
                [video, ['loadstart', 'emptied', 'loadedmetadata', 'playing', 'error', 'webkitendfullscreen']]
            ]) {
                for (const event of events) {
                    const listener = () => record(event);
                    target.addEventListener(event, listener, true);
                    cleanups.push(() => target.removeEventListener(event, listener, true));
                }
            }
            const onKey = (event) => {
                if (['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) record(event.key);
            };
            doc.defaultView.addEventListener('keydown', onKey, true);
            cleanups.push(() => doc.defaultView.removeEventListener('keydown', onKey, true));
            record('started');
            return 'Fullscreen trace started';
        },
        stop
    };
}
