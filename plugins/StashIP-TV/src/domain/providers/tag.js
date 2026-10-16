import { createEntityProvider } from './entityProvider.js';

// TagFilterType.scene_count is a HierarchicalCountInput rather than an
// IntCriterionInput, but it is a superset -- the extra `depth` is optional, so
// the shared {value, modifier} shape is valid here too.
export default createEntityProvider({
    source: 'tag',
    queryName: 'TVGuideTags',
    rootField: 'findTags',
    filterArg: 'tag_filter',
    filterType: 'TagFilterType',
    collectionField: 'tags',
    logoField: 'image_path',
    sceneFilterKey: 'tags',
    favoriteFilterKey: 'favorite'
});
