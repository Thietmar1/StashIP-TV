import { createEntityProvider } from './entityProvider.js';

export default createEntityProvider({
    source: 'group',
    queryName: 'TVGuideGroups',
    rootField: 'findGroups',
    filterArg: 'group_filter',
    filterType: 'GroupFilterType',
    collectionField: 'groups',
    logoField: 'front_image_path',
    sceneFilterKey: 'groups'
});
