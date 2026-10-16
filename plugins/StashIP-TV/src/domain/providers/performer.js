import { createEntityProvider } from './entityProvider.js';

// Performers are "Models" in the guide. Unlike studios, tags and groups they are
// not hierarchical: SceneFilterType.performers is a MultiCriterionInput with no
// `depth` field, so the provider must not send one.
export default createEntityProvider({
    source: 'performer',
    queryName: 'TVGuidePerformers',
    rootField: 'findPerformers',
    filterArg: 'performer_filter',
    filterType: 'PerformerFilterType',
    collectionField: 'performers',
    logoField: 'image_path',
    sceneFilterKey: 'performers',
    favoriteFilterKey: 'filter_favorites',
    supportsGender: true,
    hierarchical: false
});
