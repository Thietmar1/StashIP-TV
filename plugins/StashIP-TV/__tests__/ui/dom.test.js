import { el, replaceChildren, firstMatch, setToggleClass } from '../../src/ui/dom.js';

describe('el', () => {
    it('builds an element with attributes and text children', () => {
        const node = el('div', { class: 'x', 'data-y': '1' }, 'hello');
        expect(node.tagName).toBe('DIV');
        expect(node.className).toBe('x');
        expect(node.dataset.y).toBe('1');
        expect(node.textContent).toBe('hello');
    });

    it('binds listeners for on* props', () => {
        const onclick = jest.fn();
        el('button', { onclick }).click();
        expect(onclick).toHaveBeenCalled();
    });

    it('renders true as a bare attribute', () => {
        expect(el('input', { disabled: true }).getAttribute('disabled')).toBe('');
    });

    it('skips null, undefined and false attributes', () => {
        const node = el('div', { a: null, b: undefined, c: false });
        expect(node.hasAttribute('a')).toBe(false);
        expect(node.hasAttribute('b')).toBe(false);
        expect(node.hasAttribute('c')).toBe(false);
    });

    it('applies a style object', () => {
        expect(el('div', { style: { width: '50%' } }).style.width).toBe('50%');
    });

    it('sets CSS custom properties, which Object.assign would drop', () => {
        const node = el('div', { style: { '--tvguide-logo-hue': '42', color: 'red' } });
        expect(node.style.getPropertyValue('--tvguide-logo-hue')).toBe('42');
        expect(node.style.color).toBe('red');
    });

    it('sets text via the text prop', () => {
        expect(el('span', { text: 'hi' }).textContent).toBe('hi');
    });

    it('appends element children and flattens arrays', () => {
        const node = el('ul', {}, [el('li', {}, 'a'), el('li', {}, 'b')], el('li', {}, 'c'));
        expect(node.querySelectorAll('li')).toHaveLength(3);
    });

    it('skips nullish children so callers can inline conditionals', () => {
        expect(el('div', {}, null, false, undefined, 'kept').textContent).toBe('kept');
    });

    it('tolerates no props at all', () => {
        expect(el('div').tagName).toBe('DIV');
        expect(el('div', null).tagName).toBe('DIV');
    });
});

describe('replaceChildren', () => {
    it('swaps all children', () => {
        const node = el('div', {}, 'old');
        replaceChildren(node, el('span', {}, 'new'));
        expect(node.textContent).toBe('new');
        expect(node.querySelectorAll('span')).toHaveLength(1);
    });

    it('empties when given nothing', () => {
        const node = el('div', {}, 'old');
        replaceChildren(node);
        expect(node.textContent).toBe('');
    });

    it('skips nullish children', () => {
        const node = el('div');
        replaceChildren(node, null, 'kept', false);
        expect(node.textContent).toBe('kept');
    });
});

describe('firstMatch', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div class="second"></div>';
    });

    it('returns the first selector that matches', () => {
        expect(firstMatch(['.missing', '.second']).className).toBe('second');
    });

    it('returns null when nothing matches', () => {
        expect(firstMatch(['.nope', '.also-nope'])).toBeNull();
    });
});

describe('setToggleClass', () => {
    it('adds and removes', () => {
        const node = el('div');
        setToggleClass(node, 'on', true);
        expect(node.classList.contains('on')).toBe(true);
        setToggleClass(node, 'on', false);
        expect(node.classList.contains('on')).toBe(false);
    });
});
