const path = require('node:path');
const {
  createLocalFilesService,
  createLocalFilesReader,
  standardCache,
} = require('@librechat/api');

module.exports = createLocalFilesService({
  store: standardCache('local-files', undefined, undefined, { throwOnErrors: true }),
  read: createLocalFilesReader(
    path.join(path.dirname(require.resolve('@librechat/api')), 'filesystem/reader-worker.cjs'),
  ),
});
