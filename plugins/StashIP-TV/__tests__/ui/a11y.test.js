import { createAnnouncer, trapFocus } from '../../src/ui/a11y.js';

describe('createAnnouncer', () => {
    it('exposes a polite live region', () => {
        const { element } = createAnnouncer();
        expect(element.getAttribute('aria-live')).toBe('polite');
        expect(element.getAttribute('role')).toBe('status');
        expect(element.getAttribute('aria-atomic')).toBe('true');
    });

    it('announces a message', () => {
        const a = createAnnouncer();
        a.announce('Studio A. Scene One');
        expect(a.element.textContent).toBe('Studio A. Scene One');
    });

    it('changes the text so a repeated message is read again', () => {
        const a = createAnnouncer();
        a.announce('Same');
        const first = a.element.textContent;
        a.announce('Same');
        expect(a.element.textContent).not.toBe(first);
        expect(a.element.textContent.trim()).toBe('Same');
    });

    it('ignores an empty message', () => {
        const a = createAnnouncer();
        a.announce('Something');
        a.announce('');
        expect(a.element.textContent).toBe('Something');
    });
});

describe('trapFocus', () => {
    let container;
    let outside;

    beforeEach(() => {
        document.body.innerHTML = '';
        outside = document.createElement('button');
        outside.textContent = 'outside';
        document.body.appendChild(outside);

        container = document.createElement('div');
        container.innerHTML = `
            <button id="first">first</button>
            <button id="middle">middle</button>
            <button id="last">last</button>
        `;
        document.body.appendChild(container);

        // jsdom reports offsetParent as null for everything, so make the
        // visibility check in trapFocus see these as rendered.
        for (const node of container.querySelectorAll('button')) {
            Object.defineProperty(node, 'offsetParent', { value: container, configurable: true });
        }
    });

    const tab = (shiftKey = false) => {
        const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
        container.dispatchEvent(event);
        return event;
    };

    it('wraps forward from the last element to the first', () => {
        trapFocus(container);
        document.getElementById('last').focus();

        tab();

        expect(document.activeElement.id).toBe('first');
    });

    it('wraps backward from the first element to the last', () => {
        trapFocus(container);
        document.getElementById('first').focus();

        tab(true);

        expect(document.activeElement.id).toBe('last');
    });

    it('leaves interior tabbing to the browser', () => {
        trapFocus(container);
        document.getElementById('middle').focus();

        const event = tab();

        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement.id).toBe('middle');
    });

    it('ignores keys other than Tab', () => {
        trapFocus(container);
        document.getElementById('last').focus();

        container.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

        expect(document.activeElement.id).toBe('last');
    });

    it('swallows Tab when there is nothing focusable inside', () => {
        const empty = document.createElement('div');
        document.body.appendChild(empty);
        trapFocus(empty);

        const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        empty.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
    });

    it('restores the previously focused element on release', () => {
        outside.focus();
        const release = trapFocus(container);
        document.getElementById('first').focus();

        release();

        expect(document.activeElement).toBe(outside);
    });

    it('stops trapping after release', () => {
        const release = trapFocus(container);
        release();

        document.getElementById('last').focus();
        tab();

        expect(document.activeElement.id).toBe('last');
    });
});
