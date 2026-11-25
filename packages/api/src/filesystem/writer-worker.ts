import type { LocalFilesRender } from './writer';
import { generateLocalDocument } from './generate';

process.once('message', (request: Omit<LocalFilesRender, 'signal'>) => {
  void generateLocalDocument(request).then((result) => {
    process.send?.(result, () => process.disconnect());
  });
});
