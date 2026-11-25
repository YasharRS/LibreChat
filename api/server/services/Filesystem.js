const { createLocalFilesService, standardCache } = require('@librechat/api');

module.exports = createLocalFilesService({
  store: standardCache('local-files', undefined, undefined, { throwOnErrors: true }),
});
