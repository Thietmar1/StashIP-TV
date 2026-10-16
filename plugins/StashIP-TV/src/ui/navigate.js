/**
 * Leaving the guide for a scene.
 *
 * Stash's player reads `?t=` on the scene page, so handing it the live offset
 * is what makes "Watch" continue from where the channel had got to rather than
 * restarting the scene.
 *
 * `location` is a parameter so this is reachable from tests -- jsdom refuses to
 * implement navigation.
 */
export function navigateToScene(sceneId, offsetSeconds, location = window.location) {
    location.assign(`/scenes/${sceneId}?t=${Math.max(0, Math.floor(offsetSeconds))}`);
}
