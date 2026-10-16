/**
 * Minimal DOM helpers. Enough to build the guide declaratively without
 * pulling in a framework Stash would then have to ship.
 */

/**
 * el('div', { class: 'x', onclick: fn, 'aria-label': 'y' }, child, child)
 *
 * Keys starting with `on` bind listeners; everything else becomes an
 * attribute. `null` and `false` attribute values are skipped so callers can
 * write conditionals inline.
 */
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(props || {})) {
        if (value == null || value === false) continue;

        if (key.startsWith('on') && typeof value === 'function') {
            node.addEventListener(key.slice(2), value);
        } else if (key === 'style' && typeof value === 'object') {
            for (const [prop, propValue] of Object.entries(value)) {
                // Object.assign silently drops custom properties, so they have
                // to go through setProperty.
                if (prop.startsWith('--')) node.style.setProperty(prop, propValue);
                else node.style[prop] = propValue;
            }
        } else if (key === 'text') {
            node.textContent = value;
        } else {
            node.setAttribute(key, value === true ? '' : String(value));
        }
    }

    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }

    return node;
}

/** Replace a node's children in one go. */
export function replaceChildren(node, ...children) {
    node.textContent = '';
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
}

/** Try selectors in order, returning the first that matches. Stash's markup
 *  shifts between releases, so mount points are looked up defensively. */
export function firstMatch(selectors, root = document) {
    for (const selector of selectors) {
        const found = root.querySelector(selector);
        if (found) return found;
    }
    return null;
}

export function setToggleClass(node, className, on) {
    node.classList.toggle(className, Boolean(on));
}
