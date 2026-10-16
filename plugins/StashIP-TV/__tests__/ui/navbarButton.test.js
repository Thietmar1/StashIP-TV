import { createNavbarButton, BUTTON_ID } from '../../src/ui/navbarButton.js';

const navbar = () => `<nav class="navbar top-nav">
    <div class="navbar-collapse collapse"><div class="navbar-nav menu-items"></div><div class="navbar-nav utilities"></div></div>
    <div class="navbar-buttons"><button class="navbar-toggler" aria-expanded="true"></button></div>
</nav>`;

describe('createNavbarButton', () => {
    let button;
    beforeEach(() => { document.body.innerHTML = navbar(); });
    afterEach(() => { button?.stop(); button = null; });

    it('uses a labelled SVG button inside the collapsible menu, not the utility buttons', () => {
        button = createNavbarButton({ onActivate: jest.fn() });
        button.place();
        expect(button.element.getAttribute('aria-label')).toBe('Open StashIP-TV');
        expect(button.element.textContent).toBe('StashIP-TV');
        expect(button.element.querySelector('svg')).not.toBeNull();
        expect(document.querySelector('.menu-items').contains(button.element)).toBe(true);
        expect(document.querySelector('.navbar-buttons').contains(button.element)).toBe(false);
        expect(button.element.parentElement.classList.contains('nav-link')).toBe(true);
    });

    it('closes the hamburger menu through the native toggle before opening the guide', () => {
        const actions = [];
        document.querySelector('.navbar-toggler').addEventListener('click', () => actions.push('collapse'));
        button = createNavbarButton({ onActivate: () => actions.push('open') });
        button.place();
        button.element.click();
        expect(actions).toEqual(['collapse', 'open']);
    });

    it('does not toggle an already collapsed menu', () => {
        const toggle = document.querySelector('.navbar-toggler');
        toggle.setAttribute('aria-expanded', 'false');
        const clicked = jest.fn();
        toggle.addEventListener('click', clicked);
        button = createNavbarButton({ onActivate: jest.fn() });
        button.place();
        button.element.click();
        expect(clicked).not.toHaveBeenCalled();
    });

    it('opens without navigating and supports Space activation on the menu link', () => {
        const onActivate = jest.fn();
        button = createNavbarButton({ onActivate });
        button.place();
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        button.element.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
        expect(onActivate).toHaveBeenCalledTimes(1);

        const space = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
        button.element.dispatchEvent(space);
        expect(space.defaultPrevented).toBe(true);
        expect(onActivate).toHaveBeenCalledTimes(2);
        button.element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true }));
        expect(onActivate).toHaveBeenCalledTimes(2);
    });

    it('waits for a menu instead of mounting inside a utility link', () => {
        document.body.innerHTML = '<nav><a class="nav-utility"></a><div class="navbar-buttons"></div></nav>';
        button = createNavbarButton({ onActivate: jest.fn() });
        button.place();
        expect(document.getElementById(BUTTON_ID)).toBeNull();
    });

    it('does not mount twice and recovers when the SPA replaces the navbar', async () => {
        button = createNavbarButton({ onActivate: jest.fn() });
        button.start();
        button.place();
        expect(document.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
        document.body.innerHTML = navbar();
        await Promise.resolve();
        expect(document.querySelector('.menu-items').contains(button.element)).toBe(true);
        expect(document.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
    });

    it('removes the entire menu item and stops observing', async () => {
        button = createNavbarButton({ onActivate: jest.fn() });
        button.start();
        button.stop();
        expect(document.querySelector('.tvguide-navbar-item')).toBeNull();
        document.body.innerHTML = navbar();
        await Promise.resolve();
        expect(document.getElementById(BUTTON_ID)).toBeNull();
    });
});
