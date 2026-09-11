/**
 * ORBIT Trading Terminal — Safe DOM Helpers
 */

/**
 * Safely sets the textContent of a DOM element if present.
 */
export function safeText(el: HTMLElement | null, val: string | number): void {
    if (el) el.textContent = String(val);
}

/**
 * Safely sets the className of a DOM element if present.
 */
export function safeClass(el: HTMLElement | null, val: string): void {
    if (el) el.className = val;
}

/**
 * Safely sets an inline CSS style property on a DOM element.
 */
export function safeStyle<K extends keyof CSSStyleDeclaration>(
    el: HTMLElement | null,
    prop: K,
    val: CSSStyleDeclaration[K]
): void {
    if (el && el.style) {
        el.style[prop] = val;
    }
}

/**
 * Safely sets innerHTML on a DOM element.
 */
export function safeHTML(el: HTMLElement | null, val: string): void {
    if (el) el.innerHTML = val;
}

/**
 * Helper to retrieve an element by ID with a specific HTMLElement subtype.
 */
export function getElement<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

/**
 * Helper to query multiple elements.
 */
export function getAllElements<T extends HTMLElement = HTMLElement>(selector: string): NodeListOf<T> {
    return document.querySelectorAll<T>(selector);
}
