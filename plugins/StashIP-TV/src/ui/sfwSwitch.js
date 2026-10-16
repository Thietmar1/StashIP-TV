import { Events } from '../state/actions.js';

/** Follow SFW Switch's actual stylesheet state, including same-tab toggles. */
export function watchSfwSwitch({ root, video, store, doc = document }) {
    function sync() {
        const sheet = Array.from(doc.styleSheets).find((item) =>
            item.href?.includes('/plugin/sfwswitch/css'));
        const active = Boolean(sheet && !sheet.disabled);
        root.classList.toggle('tvguide-sfw', active);
        root.classList.toggle('tvguide-sfw-locked', active && Boolean(doc.getElementById('sfw-never-unblur')));
    }
    const onClick = (event) => {
        if (event.target.closest?.('#plugin_sfw')) sync();
    };
    // SFW Switch already enforces its optional audio mute on all video elements.
    // Reflect external volume changes without saving over the user's preference.
    const onVolume = () => store.dispatch({ type: Events.VIEWER_MUTED, muted: video.muted });
    video.addEventListener('volumechange', onVolume);
    doc.addEventListener('click', onClick);
    const observer = new MutationObserver(sync);
    if (doc.head) observer.observe(doc.head, { childList: true, subtree: true, attributes: true });
    // CSSStyleSheet.disabled need not mutate the link element's attributes.
    const timer = setInterval(sync, 200);
    sync();
    return () => {
        clearInterval(timer);
        observer.disconnect();
        doc.removeEventListener('click', onClick);
        video.removeEventListener('volumechange', onVolume);
        root.classList.remove('tvguide-sfw', 'tvguide-sfw-locked');
    };
}
