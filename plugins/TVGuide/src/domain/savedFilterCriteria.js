/**
 * Translating a saved filter into a scene filter.
 *
 * A SavedFilter's `object_filter` looks like it is already a SceneFilterType,
 * but it is not: it is the shape the Stash *UI* uses. Multi-value criteria
 * carry
 *
 *     { modifier, value: { items: [{id, label}], excluded: [...], depth } }
 *
 * where the API wants
 *
 *     { modifier, value: [id], excludes: [id], depth }
 *
 * Forwarding the raw filter fails validation with "cannot use map as ID", so
 * this module does the conversion. Stash-ID criteria store their endpoint and
 * ID inside `value`, while the API expects endpoint/stash_id beside modifier.
 * API-shaped criteria pass through untouched.
 */

/** Nested boolean groups are themselves SceneFilterTypes. */
const NESTED_FIELDS = ['AND', 'OR', 'NOT'];

const idsOf = (list) =>
    (Array.isArray(list) ? list : [])
        .map((item) => (item && typeof item === 'object' ? item.id : item))
        .filter((id) => id != null)
        .map(String);

/** A UI multi-criterion is recognisable by its object-shaped `value`. */
function isMultiCriterion(criterion) {
    return (
        criterion &&
        typeof criterion === 'object' &&
        criterion.value &&
        typeof criterion.value === 'object' &&
        !Array.isArray(criterion.value)
    );
}

function convertCriterion(criterion) {
    const { items, excluded, depth } = criterion.value;

    const converted = { modifier: criterion.modifier, value: idsOf(items) };

    const excludes = idsOf(excluded);
    if (excludes.length > 0) converted.excludes = excludes;

    // Only non-zero depth is worth sending. Depth 0 is the default, and
    // omitting it means this never trips over a criterion that has no depth
    // (performers, for instance, are not hierarchical).
    if (depth) converted.depth = depth;

    return converted;
}

/**
 * @param objectFilter a SavedFilter.object_filter
 * @returns {object} a SceneFilterType safe to hand to findScenes
 */
export function savedFilterToSceneFilter(objectFilter) {
    if (!objectFilter || typeof objectFilter !== 'object') return {};

    const out = {};

    for (const [field, criterion] of Object.entries(objectFilter)) {
        if (NESTED_FIELDS.includes(field)) {
            out[field] = Array.isArray(criterion)
                ? criterion.map(savedFilterToSceneFilter)
                : savedFilterToSceneFilter(criterion);
            continue;
        }

        if (field === 'stash_id_endpoint' && criterion && Object.prototype.hasOwnProperty.call(criterion, 'value')) {
            const value = criterion.value;
            out[field] = {
                modifier: criterion.modifier,
                endpoint: typeof value === 'string' ? '' : value?.endpoint ?? '',
                stash_id: typeof value === 'string' ? value : value?.stashID ?? value?.stash_id ?? ''
            };
            continue;
        }

        out[field] = isMultiCriterion(criterion) ? convertCriterion(criterion) : criterion;
    }

    return out;
}

