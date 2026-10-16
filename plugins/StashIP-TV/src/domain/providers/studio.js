import { createEntityProvider } from './entityProvider.js';

export default createEntityProvider({
    source: 'studio',
    queryName: 'TVGuideStudios',
    rootField: 'findStudios',
    filterArg: 'studio_filter',
    filterType: 'StudioFilterType',
    collectionField: 'studios',
    logoField: 'image_path',
    sceneFilterKey: 'studios',
    favoriteFilterKey: 'favorite'
});
