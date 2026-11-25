import type { LocalFilesRoot } from 'librechat-data-provider';
import type { Folder, Journal, JournalEntry } from './engine';

interface Remembered {
  root: LocalFilesRoot;
  folder: Folder;
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('librechat-local-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Local file storage is unavailable'));
  });
}
async function read<T>(key: string): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction('records', 'readonly');
      const request: IDBRequest<T | undefined> = transaction.objectStore('records').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Local file storage is unavailable'));
    });
  } finally {
    db.close();
  }
}
async function put(key: string, value: Remembered | JournalEntry): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('records', 'readwrite');
      transaction.objectStore('records').put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(new Error('Local file storage is unavailable'));
    });
  } finally {
    db.close();
  }
}
export const recallFolder = (owner: string) => read<Remembered>(`${owner}:folder`);
export const rememberFolder = (owner: string, value: Remembered) => put(`${owner}:folder`, value);
/** A shared registry gives the same physical folder one write lock across tabs. */
export async function registerFolder(owner: string, folder: Folder): Promise<LocalFilesRoot> {
  return navigator.locks.request(`librechat-local-folders:${owner}`, async () => {
    const db = await open();
    let roots: Remembered[];
    try {
      roots = await new Promise<Remembered[]>((resolve, reject) => {
        const transaction = db.transaction('records', 'readonly');
        const prefix = `${owner}:root:`;
        const request: IDBRequest<Remembered[]> = transaction
          .objectStore('records')
          .getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Local file storage is unavailable'));
      });
    } finally {
      db.close();
    }
    for (const entry of roots) {
      if (await folder.isSameEntry(entry.folder)) {
        const root = { ...entry.root, access: 'read' as const };
        await rememberFolder(owner, { root, folder });
        return root;
      }
    }
    const root: LocalFilesRoot = { id: crypto.randomUUID(), name: folder.name, access: 'read' };
    await put(`${owner}:root:${root.id}`, { root, folder });
    await rememberFolder(owner, { root, folder });
    return root;
  });
}
export const localJournal = (owner: string): Journal => ({
  get: (id) => read<JournalEntry>(`${owner}:operation:${id}`),
  put: (id, value) => put(`${owner}:operation:${id}`, value),
});
export async function forgetFolders(owner: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('records', 'readwrite');
      const request = transaction.objectStore('records').openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (typeof cursor.key === 'string' && cursor.key.startsWith(`${owner}:`))
          transaction.objectStore('records').delete(cursor.key);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(new Error('Local file storage is unavailable'));
    });
  } finally {
    db.close();
  }
}
