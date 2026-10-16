import {
    buildClientSchema, execute, getIntrospectionQuery, getOperationAST,
    getNamedType, isListType, isNonNullType, isEnumType, isScalarType,
    parse, validate, visit, GraphQLError
} from 'graphql';
import { endpoint } from './config.js';

export const adapterSceneId = (channelId) => `tvguide-${Buffer.from(channelId).toString('base64url')}`;

const own = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);
const fail = (message) => { throw new GraphQLError(message); };

function compare(value, criterion) {
    if (!criterion) return true;
    const { value: target, value2, modifier } = criterion;
    switch (modifier) {
        case 'EQUALS': return value === target;
        case 'NOT_EQUALS': return value !== target;
        case 'GREATER_THAN': return value > target;
        case 'LESS_THAN': return value < target;
        case 'BETWEEN': return value >= target && value <= value2;
        case 'NOT_BETWEEN': return value < target || value > value2;
        case 'IS_NULL': return value == null || value === '';
        case 'NOT_NULL': return value != null && value !== '';
        case 'INCLUDES': return String(value).toLowerCase().includes(String(target).toLowerCase());
        case 'EXCLUDES': return !String(value).toLowerCase().includes(String(target).toLowerCase());
        default: return fail('This filter modifier is not supported by the live adapter.');
    }
}

function multi(ids, criterion) {
    const wanted = (criterion.value || []).map(String);
    const excluded = (criterion.excludes || []).map(String);
    if (excluded.some((id) => ids.includes(id))) return false;
    switch (criterion.modifier) {
        case 'IS_NULL': return ids.length === 0;
        case 'NOT_NULL': return ids.length > 0;
        case 'EXCLUDES': return !wanted.some((id) => ids.includes(id));
        case 'EQUALS': return ids.length === wanted.length && wanted.every((id) => ids.includes(id));
        case 'INCLUDES_ALL': return wanted.every((id) => ids.includes(id));
        case 'INCLUDES': return !wanted.length || wanted.some((id) => ids.includes(id));
        default: return fail('This selection modifier is not supported by the live adapter.');
    }
}

function matches(scene, filter) {
    if (!filter) return true;
    return Object.entries(filter).every(([field, value]) => {
        if (value == null) return true;
        if (field === 'AND') return matches(scene, value);
        if (field === 'OR') return fail('OR groups are not supported by the live adapter.');
        if (field === 'NOT') return !matches(scene, value);
        if (field === 'organized' || field === 'interactive') return scene[field] === value;
        if (field === 'studios') return multi([scene.studio.id], value);
        if (['performers', 'tags', 'groups', 'galleries'].includes(field)) return multi([], value);
        if (field === 'duration') return compare(0, value);
        if (field === 'file_count') return compare(1, value);
        if (['tag_count', 'performer_count', 'stash_id_count'].includes(field)) return compare(0, value);
        if (['title', 'details', 'date', 'created_at', 'updated_at', 'rating100', 'o_counter', 'play_count', 'play_duration', 'resume_time'].includes(field)) return compare(scene[field], value);
        return fail(`Scene filter '${field}' is not supported by the live adapter.`);
    });
}

function pageScenes(scenes, args = {}) {
    let result = scenes.filter((scene) => matches(scene, args.scene_filter));
    if (Array.isArray(args.ids)) result = result.filter((scene) => args.ids.map(String).includes(scene.id));
    if (Array.isArray(args.scene_ids)) result = [];
    const find = args.filter || {};
    if (find.q) {
        const q = find.q.toLowerCase();
        result = result.filter((scene) => `${scene.title} ${scene.details}`.toLowerCase().includes(q));
    }
    const sort = find.sort;
    if (['title', 'date', 'created_at', 'updated_at', 'id'].includes(sort)) {
        result = [...result].sort((a, b) => String(a[sort]).localeCompare(String(b[sort]), undefined, { numeric: true }));
        if (find.direction === 'DESC') result.reverse();
    }
    const count = result.length;
    const size = find.per_page === -1 ? 10000 : Math.max(0, Math.min(500, find.per_page ?? 25));
    const start = Math.max(0, (find.page ?? 1) - 1) * size;
    return { count, duration: 0, filesize: 0, scenes: result.slice(start, start + size) };
}

function defaultValue(type, now) {
    if (isNonNullType(type)) return defaultValue(type.ofType, now);
    if (isListType(type)) return [];
    const named = getNamedType(type);
    if (isEnumType(named)) return named.getValues()[0]?.value;
    if (!isScalarType(named)) return {};
    if (['Int', 'Float', 'Int64'].includes(named.name)) return 0;
    if (named.name === 'Boolean') return false;
    if (named.name === 'Time') return new Date(now()).toISOString();
    if (['Map', 'Any', 'JSON'].includes(named.name)) return {};
    return '';
}

/** A read-only virtual Stash library. Nothing from the client's query is ever
 * forwarded upstream; only our fixed bootstrap/guide queries can reach Stash. */
export function createStashyAdapter(config, { gql, getGuide, now = Date.now, bootstrap } = {}) {
    let boot;
    const initialize = () => {
        if (!boot) {
            boot = (bootstrap ? Promise.resolve().then(bootstrap) : Promise.all([
                gql(getIntrospectionQuery()), gql('query TVGuideAdapterVersion { version { version } }')
            ]).then(([data, version]) => ({ introspection: data, version: version.version.version })))
                .then(({ introspection, version }) => ({ schema: buildClientSchema(introspection), version }));
            boot.catch(() => { boot = null; });
        }
        return boot;
    };

    async function virtualScenes() {
        const guide = await getGuide();
        const scenes = [];
        for (let offset = 0; offset < guide.channels.length; offset += 4) {
            const batch = guide.channels.slice(offset, offset + 4);
            const programs = await Promise.all(batch.map((channel) => guide.program(channel, now())));
            batch.forEach((channel, index) => {
                const program = programs[index];
                if (!program) return;
                const id = adapterSceneId(channel.id);
                const title = program.scene.title?.trim() || `Untitled scene ${program.scene.id}`;
                const stamp = new Date(program.startMs).toISOString();
                const stream = endpoint(config, `/stream/${encodeURIComponent(channel.id)}.ts`);
                const screenshot = endpoint(config, `/stashy/scene/${id}/screenshot`);
                scenes.push({
                    id, title: `${channel.number} · ${channel.name} — ${title}`,
                    code: channel.id, details: `Live channel: ${channel.number} · ${channel.name}\nNow playing: ${title}\nLive stream; seeking and library edits are not supported.`,
                    director: '', date: stamp.slice(0, 10), organized: true, interactive: false,
                    created_at: stamp, updated_at: stamp, rating100: null,
                    resume_time: 0, play_count: 0, play_duration: 0, last_played_at: null, o_counter: 0,
                    studio: { id: 'tvguide-live', name: 'TVGuide Live', scene_count: guide.channels.length, updated_at: stamp, image_path: '' },
                    performers: [], tags: [], galleries: [], groups: [], captions: [], stash_ids: [], scene_markers: [], urls: [],
                    custom_fields: { tvguide_channel: channel.name, tvguide_scene: title, tvguide_number: channel.number },
                    paths: { screenshot, stream, preview: null, webp: null, vtt: null, sprite: null, funscript: null, interactive_heatmap: null, caption: null },
                    files: [{ __typename: 'VideoFile', id: `${id}-live`, path: `TVGuide/${channel.number}.ts`, basename: `${channel.number}.ts`,
                        format: 'mpegts', duration: 0, width: 1280, height: 720, video_codec: 'h264', audio_codec: 'aac', bit_rate: 0, frame_rate: 25, size: 0,
                        created_at: stamp, updated_at: stamp, fingerprints: [] }],
                    sceneStreams: [{ url: stream, mime_type: 'video/mp2t', label: 'Live' }]
                });
            });
        }
        return scenes;
    }

    async function request(body) {
        if (!body || typeof body.query !== 'string' || body.query.length > 60000 ||
            (body.variables != null && (typeof body.variables !== 'object' || Array.isArray(body.variables)))) {
            return { errors: [{ message: 'Invalid adapter GraphQL request.' }] };
        }
        let document;
        try { document = parse(body.query, { maxTokens: 10000 }); }
        catch { return { errors: [{ message: 'Invalid GraphQL document.' }] }; }
        let depth = 0, maxDepth = 0, fields = 0;
        visit(document, { Field: { enter() { fields++; depth++; maxDepth = Math.max(maxDepth, depth); }, leave() { depth--; } } });
        if (maxDepth > 18 || fields > 1500) return { errors: [{ message: 'Adapter query exceeds limits.' }] };
        const operation = getOperationAST(document, body.operationName);
        if (!operation || operation.operation !== 'query') return { errors: [{ message: 'TVGuide adapter is read-only; mutations and subscriptions are disabled.' }] };
        const { schema, version } = await initialize();
        const errors = validate(schema, document);
        if (errors.length) return { errors: errors.map((error) => ({ message: error.message })) };
        // Count expanded fragment selections too, so small repeated fragments
        // cannot bypass the structural AST limit and amplify execution.
        const fragments = new Map(document.definitions.filter((item) => item.kind === 'FragmentDefinition').map((item) => [item.name.value, item]));
        const stack = [[operation.selectionSet, 0]];
        let expanded = 0;
        while (stack.length) {
            const [selectionSet, level] = stack.pop();
            for (const selection of selectionSet.selections) {
                if (++expanded > 3000 || level > 18) return { errors: [{ message: 'Adapter query exceeds limits.' }] };
                if (selection.kind === 'FragmentSpread') stack.push([fragments.get(selection.name.value).selectionSet, level]);
                else if (selection.selectionSet) stack.push([selection.selectionSet, level + 1]);
            }
        }
        let scenePromise;
        const all = () => (scenePromise ||= virtualScenes());
        const studio = async () => ({ id: 'tvguide-live', name: 'TVGuide Live', scene_count: (await all()).length, image_path: '' });
        const roots = {
            version: () => ({ version, hash: 'tvguide-adapter', build_time: '' }),
            systemStatus: () => ({ status: 'OK' }),
            configuration: () => ({ general: { stashes: [], stashBoxes: [] }, defaults: {}, plugins: {} }),
            stats: async () => ({ scene_count: (await all()).length, studio_count: 1 }),
            findScenes: async (args) => pageScenes(await all(), args),
            findScene: async ({ id }) => (await all()).find((scene) => scene.id === id) || null,
            allScenes: all,
            findStudios: async ({ ids }) => ({ count: ids && !ids.includes('tvguide-live') ? 0 : 1, studios: ids && !ids.includes('tvguide-live') ? [] : [await studio()] }),
            findStudio: async ({ id }) => id === 'tvguide-live' ? studio() : null,
            allStudios: async () => [await studio()],
            findSavedFilters: () => [], findSavedFilter: () => null,
            findPerformers: () => ({ count: 0, performers: [] }), findTags: () => ({ count: 0, tags: [] }),
            findGroups: () => ({ count: 0, groups: [] }), findMovies: () => ({ count: 0, movies: [] }),
            findImages: () => ({ count: 0, images: [] }), findGalleries: () => ({ count: 0, galleries: [] }),
            findSceneMarkers: () => ({ count: 0, scene_markers: [] })
        };
        const result = await execute({ schema, document, variableValues: body.variables, operationName: body.operationName,
            rootValue: roots,
            fieldResolver(source, args, _context, info) {
                if (info.parentType === schema.getQueryType() && !own(roots, info.fieldName)) return fail(`Query '${info.fieldName}' is not supported by the live adapter.`);
                if (own(source, info.fieldName)) {
                    const value = source[info.fieldName];
                    return typeof value === 'function' ? value(args) : value;
                }
                return defaultValue(info.returnType, now);
            }
        });
        if (result.errors) result.errors = result.errors.map((error) => ({ message: error.originalError instanceof GraphQLError || !error.originalError
            ? error.message : 'Live adapter request failed.', path: error.path }));
        return result;
    }

    return {
        request,
        async imageScene(id) {
            const guide = await getGuide();
            const channel = guide.channels.find((item) => adapterSceneId(item.id) === id);
            if (!channel) return null;
            const program = await guide.program(channel, now());
            return program?.scene.paths?.screenshot || (channel.logo?.type === 'image' ? channel.logo.url : null);
        }
    };
}
