import type { LocalFilesRead } from './reader';
import { readLocalDocument } from './parse';

process.once('message', (request: Omit<LocalFilesRead, 'signal'>) => {
  void readLocalDocument(request).then((result) => {
    process.send?.(result, () => process.disconnect());
  });
});
