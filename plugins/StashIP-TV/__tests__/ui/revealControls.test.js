import { revealControlsOnInteraction } from '../../src/ui/revealControls.js';

function pointer(node, type, pointerType = 'touch', x = 0, y = 0) {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    node.dispatchEvent(event);
}

it('reveals on mouse hover and hides on exit', () => {
    const scope = document.createElement('div');
    revealControlsOnInteraction(scope);
    pointer(scope, 'pointerenter', 'mouse');
    expect(scope.classList.contains('is-editing')).toBe(true);
    pointer(scope, 'pointerleave', 'mouse');
    expect(scope.classList.contains('is-editing')).toBe(false);
});

it('toggles on taps without treating touch entry as hover', () => {
    const scope = document.createElement('div');
    revealControlsOnInteraction(scope);
    pointer(scope, 'pointerenter');
    expect(scope.classList.contains('is-editing')).toBe(false);
    scope.click();
    expect(scope.classList.contains('is-editing')).toBe(true);
    scope.click();
    expect(scope.classList.contains('is-editing')).toBe(false);
});

it('allows a click to hide controls even while the mouse remains inside', () => {
    const scope = document.createElement('div');
    revealControlsOnInteraction(scope);
    pointer(scope, 'pointerenter', 'mouse');
    scope.click();
    expect(scope.classList.contains('is-editing')).toBe(false);
});

it('does not toggle after a drag or when a control is activated', () => {
    const scope = document.createElement('div');
    const button = document.createElement('button');
    scope.appendChild(button);
    revealControlsOnInteraction(scope);
    scope.click();
    button.click();
    pointer(scope, 'pointerdown');
    pointer(scope, 'pointermove', 'touch', 0, 40);
    pointer(scope, 'pointerup', 'touch', 0, 40);
    scope.click();
    expect(scope.classList.contains('is-editing')).toBe(true);
    pointer(scope, 'pointerdown');
    pointer(scope, 'pointerup');
    scope.click();
    expect(scope.classList.contains('is-editing')).toBe(false);
});

it('keeps nested overlay taps separate from the miniplayer', () => {
    const picture = document.createElement('div');
    const overlay = document.createElement('div');
    picture.appendChild(overlay);
    revealControlsOnInteraction(overlay);
    revealControlsOnInteraction(picture, { ignore: (target) => overlay.contains(target) });
    overlay.click();
    expect(overlay.classList.contains('is-editing')).toBe(true);
    expect(picture.classList.contains('is-editing')).toBe(false);
});
