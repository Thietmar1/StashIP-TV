/** Reveal edit controls on mouse hover or a tap, without touch hover echoes. */
export function revealControlsOnInteraction(scope, { ignore = () => false } = {}) {
    let start = null;
    let dragged = false;
    scope.addEventListener('pointerenter', (event) => {
        if (event.pointerType === 'mouse') scope.classList.add('is-editing');
    });
    scope.addEventListener('pointerleave', (event) => {
        if (event.pointerType === 'mouse') scope.classList.remove('is-editing');
    });
    scope.addEventListener('pointerdown', (event) => {
        start = { x: event.clientX, y: event.clientY };
        dragged = false;
    });
    scope.addEventListener('pointermove', (event) => {
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) dragged = true;
    });
    scope.addEventListener('pointerup', () => { start = null; });
    scope.addEventListener('pointercancel', () => { start = null; dragged = true; });
    scope.addEventListener('click', (event) => {
        if (dragged || ignore(event.target) || event.target.closest('button, input, select, textarea, [role="separator"]')) return;
        scope.classList.toggle('is-editing');
    });
}
