import type { FileHandle, Folder, Writable } from '../src/components/Filesystem/engine';

export class DiskFile implements FileHandle {
  readonly kind = 'file';
  writes = 0;
  constructor(
    readonly name: string,
    public content: string | Uint8Array<ArrayBuffer> = '',
  ) {}

  async getFile(): Promise<File> {
    return new File([this.content], this.name);
  }

  async isSameEntry(other: FileHandle): Promise<boolean> {
    return this === other;
  }

  async createWritable(): Promise<Writable> {
    let pending: string | Blob = '';
    return {
      write: async (value) => {
        pending = value;
      },
      close: async () => {
        this.content =
          typeof pending === 'string' ? pending : new Uint8Array(await pending.arrayBuffer());
        this.writes++;
      },
      abort: async () => undefined,
    };
  }
}
export class DiskFolder implements Folder {
  readonly kind = 'directory';
  readonly files = new Map<string, DiskFile>();
  readonly folders = new Map<string, DiskFolder>();
  allowed: PermissionState = 'granted';
  denyRemoval = false;
  constructor(readonly name = 'workspace') {}
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<DiskFile> {
    if (this.folders.has(name)) throw new DOMException('', 'TypeMismatchError');
    let file = this.files.get(name);
    if (!file && options?.create) {
      file = new DiskFile(name);
      this.files.set(name, file);
    }
    if (!file) throw new DOMException('', 'NotFoundError');
    return file;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DiskFolder> {
    if (this.files.has(name)) throw new DOMException('', 'TypeMismatchError');
    let folder = this.folders.get(name);
    if (!folder && options?.create) {
      folder = new DiskFolder(name);
      this.folders.set(name, folder);
    }
    if (!folder) throw new DOMException('', 'NotFoundError');
    return folder;
  }

  async removeEntry(name: string): Promise<void> {
    if (this.denyRemoval) throw new DOMException('', 'NotAllowedError');
    this.files.delete(name);
  }

  async *values() {
    yield* this.folders.values();
    yield* this.files.values();
  }

  async queryPermission() {
    return this.allowed;
  }

  async requestPermission() {
    return this.allowed;
  }

  async isSameEntry(other: Folder) {
    return other === this;
  }
}
