/** Display formatting with explicit clock preferences, independent of locale. */

const pad = (n) => String(n).padStart(2, '0');

/** Local wall-clock time, optionally using a 12-hour clock with AM/PM. */
export function formatClock(ms, use12Hour = false) {
    const d = new Date(ms);
    const hours = d.getHours();
    if (use12Hour) return `${hours % 12 || 12}:${pad(d.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`;
    return `${pad(hours)}:${pad(d.getMinutes())}`;
}

/** Runtime as m:ss, widening to h:mm:ss only when it has to. */
export function formatDuration(seconds) {
    const total = Math.floor(Math.max(0, seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Time left in the current programme.
 *
 * Rounds up, so a programme with forty seconds to go reads "1 min left"
 * rather than "0 min left" -- which would look like a bug.
 */
export function formatRemaining(remainingMs) {
    if (remainingMs < 1000) return 'ending';
    return `${Math.ceil(remainingMs / 60000)} min left`;
}

/**
 * Fallback channel identity for sources with no artwork.
 *
 * Stash has no logo for a saved filter, and plenty of studios have no image, so
 * every channel gets initials on a colour derived from its name -- stable, so a
 * channel keeps the same badge between sessions.
 */
export function monogram(name) {
    const clean = (name || '').trim();
    const words = clean.split(/\s+/).filter(Boolean);

    let initials;
    if (words.length === 0) initials = '?';
    else if (words.length === 1) initials = words[0].slice(0, 2);
    else initials = words[0][0] + words[1][0];

    let hue = 0;
    for (let i = 0; i < clean.length; i++) {
        hue = (hue * 31 + clean.charCodeAt(i)) % 360;
    }

    return { initials: initials.toUpperCase(), hue };
}
