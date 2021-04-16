import { Contents as ServerContents, ServerConnection } from '@jupyterlab/services';

import { INotebookContent } from '@jupyterlab/nbformat';

import { ModelDB } from '@jupyterlab/observables';

import { PathExt } from '@jupyterlab/coreutils';

import { ISignal, Signal } from '@lumino/signaling';

import localforage from 'localforage';

import { IContents } from './tokens';

/**
 * The name of the local storage.
 */
const STORAGE_NAME = 'JupyterLite Storage';

/**
 * The number of checkpoints to save.
 */
const N_CHECKPOINTS = 5;

/**
 * A class to handle requests to /api/contents
 */
export class Contents implements IContents {
  /**
   * A signal emitted when the file has changed.
   */
  get fileChanged(): ISignal<ServerContents.IManager, ServerContents.IChangedArgs> {
    return this._fileChanged;
  }

  /**
   * Test whether the manager has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Return the server settings.
   */
  get serverSettings(): ServerConnection.ISettings {
    // TODO: placeholder
    return ServerConnection.makeSettings();
  }

  /**
   * Dispose of the resources held by the manager.
   */
  dispose(): void {
    throw new Error('Method not implemented.');
  }
  /**
   * Create a new untitled file or directory in the specified directory path.
   *
   * @param options: The options used to create the file.
   *
   * @returns A promise which resolves with the created file content when the file is created.
   */
  async newUntitled(
    options?: ServerContents.ICreateOptions
  ): Promise<ServerContents.IModel> {
    const path = options?.path ?? '';
    const type = options?.type ?? 'notebook';
    const created = new Date().toISOString();
    const prefix = path ? `${path}/` : '';

    let file: ServerContents.IModel;
    let name = '';
    switch (type) {
      case 'directory': {
        const counter = await this._incrementCounter('directory');
        name += `Untitled Folder${counter || ''}`;
        file = {
          name,
          path: `${prefix}${name}`,
          last_modified: created,
          created,
          format: 'text',
          mimetype: '',
          content: null,
          size: undefined,
          writable: true,
          type: 'directory'
        };
        break;
      }
      case 'file': {
        const ext = options?.ext ?? '.txt';
        const counter = await this._incrementCounter('file');
        name += `untitled${counter || ''}${ext}`;
        file = {
          name,
          path: `${prefix}${name}`,
          last_modified: created,
          created,
          format: 'text',
          // TODO: handle mimetypes
          mimetype: 'text/plain',
          content: '',
          size: 0,
          writable: true,
          type: 'file'
        };
        break;
      }
      default: {
        const counter = await this._incrementCounter('notebook');
        name += `Untitled${counter || ''}.ipynb`;
        file = {
          name,
          path: `${prefix}${name}`,
          last_modified: created,
          created,
          format: 'json',
          mimetype: 'application/json',
          content: Private.EMPTY_NB,
          size: JSON.stringify(Private.EMPTY_NB).length,
          writable: true,
          type: 'notebook'
        };
        break;
      }
    }

    const key = `${prefix}${name}`;
    await this._storage.setItem(key, file);
    return file;
  }

  /**
   * Copy a file into a given directory.
   *
   * @param path - The original file path.
   * @param toDir - The destination directory path.
   *
   * @returns A promise which resolves with the new contents model when the
   *  file is copied.
   *
   * #### Notes
   * The server will select the name of the copied file.
   */
  async copy(path: string, toDir: string): Promise<ServerContents.IModel> {
    let name = PathExt.basename(path);
    toDir = toDir === '' ? '' : `${toDir.slice(1)}/`;
    // TODO: better handle naming collisions with existing files
    while (await this._storage.getItem(`${toDir}${name}`)) {
      const ext = PathExt.extname(name);
      const base = name.replace(ext, '');
      name = `${base} (copy)${ext}`;
    }
    const toPath = `${toDir}${name}`;
    let item = (await this._storage.getItem(path)) as ServerContents.IModel;
    item = {
      ...item,
      name,
      path: toPath
    };
    await this._storage.setItem(toPath, item);
    return item;
  }

  /**
   * Get a file or directory.
   *
   * @param path: The path to the file.
   * @param options: The options used to fetch the file.
   *
   * @returns A promise which resolves with the file content.
   */
  async get(
    path: string,
    options?: ServerContents.IFetchOptions
  ): Promise<ServerContents.IModel> {
    // only handle flat for now
    if (path === '') {
      const content: ServerContents.IModel[] = [];
      await this._storage.iterate((item, key) => {
        if (key.includes('/')) {
          return;
        }
        const file = (item as unknown) as ServerContents.IModel;
        content.push(file);
      });
      return {
        name: '',
        path: '',
        last_modified: new Date(0).toISOString(),
        created: new Date(0).toISOString(),
        format: 'json',
        mimetype: 'application/json',
        content,
        size: undefined,
        writable: true,
        type: 'directory'
      };
    }
    // remove leading slash
    path = decodeURIComponent(path.slice(1));
    const item = await this._storage.getItem(path);
    if (!item) {
      throw Error(`Could not find file with path ${path}`);
    }
    const model = (item as unknown) as ServerContents.IModel;
    if (!options?.content) {
      return {
        ...model,
        content: null,
        size: undefined
      };
    }
    // for directories, find all files with the path as the prefix
    if (model.type === 'directory') {
      const content: ServerContents.IModel[] = [];
      await this._storage.iterate((item, key) => {
        const file = (item as unknown) as ServerContents.IModel;
        // use an additional slash to not include the directory itself
        if (key === `${path}/${file.name}`) {
          content.push(file);
        }
      });
      return {
        name: '',
        path: '',
        last_modified: model.last_modified,
        created: model.created,
        format: 'json',
        mimetype: 'application/json',
        content,
        size: undefined,
        writable: true,
        type: 'directory'
      };
    }
    return model;
  }

  /**
   * Rename a file or directory.
   *
   * @param oldLocalPath - The original file path.
   * @param newLocalPath - The new file path.
   *
   * @returns A promise which resolves with the new file content model when the file is renamed.
   */
  async rename(
    oldLocalPath: string,
    newLocalPath: string
  ): Promise<ServerContents.IModel> {
    const path = decodeURIComponent(oldLocalPath);
    const item = await this._storage.getItem(path);
    if (!item) {
      throw Error(`Could not find file with path ${path}`);
    }
    const file = (item as unknown) as ServerContents.IModel;
    const modified = new Date().toISOString();
    const name = PathExt.basename(newLocalPath);
    const newFile = {
      ...file,
      name,
      path: newLocalPath,
      last_modified: modified
    };
    await this._storage.setItem(newLocalPath, newFile);
    // remove the old file
    await this._storage.removeItem(path);
    // remove the corresponding checkpoint
    await this._checkpoints.removeItem(path);
    return newFile;
  }

  /**
   * Save a file.
   *
   * @param path - The desired file path.
   * @param options - Optional overrides to the model.
   *
   * @returns A promise which resolves with the file content model when the file is saved.
   */
  async save(
    path: string,
    options: Partial<ServerContents.IModel> = {}
  ): Promise<ServerContents.IModel> {
    let item = (await this._storage.getItem(path)) as ServerContents.IModel;
    if (!item) {
      item = await this.newUntitled({ path });
    }
    // override with the new values
    const modified = new Date().toISOString();
    item = {
      ...item,
      ...options,
      last_modified: modified
    };

    // process the file if coming from an upload
    const ext = PathExt.extname(options.name ?? '');
    if (options.content && options.format === 'base64') {
      // TODO: keep base64 if not a text file (image)
      const content = atob(options.content);
      const nb = ext === '.ipynb';
      item = {
        ...item,
        content: nb ? JSON.parse(content) : content,
        format: nb ? 'json' : 'text',
        type: nb ? 'notebook' : 'file'
      };
    }

    await this._storage.setItem(path, item);
    return item;
  }

  /**
   * Delete a file.
   *
   * @param path - The path to the file.
   */
  async delete(path: string): Promise<void> {
    path = decodeURIComponent(path);
    const toDelete: string[] = [];
    // handle deleting directories recursively
    await this._storage.iterate((item, key) => {
      if (key.startsWith(path)) {
        toDelete.push(key);
      }
    });
    await Promise.all(
      toDelete.map(async p => {
        return Promise.all([
          this._storage.removeItem(p),
          this._checkpoints.removeItem(p)
        ]);
      })
    );
  }

  /**
   * Create a checkpoint for a file.
   *
   * @param path - The path of the file.
   *
   * @returns A promise which resolves with the new checkpoint model when the
   *   checkpoint is created.
   */
  async createCheckpoint(path: string): Promise<ServerContents.ICheckpointModel> {
    const item = (await this._storage.getItem(path)) as ServerContents.IModel;
    const copies =
      ((await this._checkpoints.getItem(path)) as ServerContents.IModel[]) ?? [];
    copies.push(item);
    // keep only a certain amount of checkpoints per file
    if (copies.length > N_CHECKPOINTS) {
      copies.splice(0, copies.length - N_CHECKPOINTS);
    }
    await this._checkpoints.setItem(path, copies);
    const id = `${copies.length - 1}`;
    return {
      id,
      last_modified: (item as ServerContents.IModel).last_modified
    };
  }

  /**
   * List available checkpoints for a file.
   *
   * @param path - The path of the file.
   *
   * @returns A promise which resolves with a list of checkpoint models for
   *    the file.
   */
  async listCheckpoints(path: string): Promise<ServerContents.ICheckpointModel[]> {
    const copies = (await this._checkpoints.getItem(path)) as ServerContents.IModel[];
    if (!copies) {
      return [];
    }
    return copies.map((file, id) => {
      return {
        id: id.toString(),
        last_modified: file.last_modified
      };
    });
  }

  /**
   * Restore a file to a known checkpoint state.
   *
   * @param path - The path of the file.
   * @param checkpointID - The id of the checkpoint to restore.
   *
   * @returns A promise which resolves when the checkpoint is restored.
   */
  async restoreCheckpoint(path: string, checkpointID: string): Promise<void> {
    const copies = (await this._checkpoints.getItem(path)) as ServerContents.IModel[];
    const id = parseInt(checkpointID);
    const item = copies[id];
    await this._storage.setItem(path, item);
  }

  /**
   * Delete a checkpoint for a file.
   *
   * @param path - The path of the file.
   * @param checkpointID - The id of the checkpoint to delete.
   *
   * @returns A promise which resolves when the checkpoint is deleted.
   */
  async deleteCheckpoint(path: string, checkpointID: string): Promise<void> {
    const copies = (await this._checkpoints.getItem(path)) as ServerContents.IModel[];
    const id = parseInt(checkpointID);
    copies.splice(id, 1);
    await this._checkpoints.setItem(path, copies);
  }

  /**
   * Add an `IDrive` to the manager.
   */
  addDrive(drive: ServerContents.IDrive): void {
    throw new Error('Method not implemented.');
  }

  /**
   * Given a path of the form `drive:local/portion/of/it.txt`
   * get the local part of it.
   *
   * @param path: the path.
   *
   * @returns The local part of the path.
   */
  localPath(path: string): string {
    throw new Error('Method not implemented.');
  }

  /**
   * Normalize a global path. Reduces '..' and '.' parts, and removes
   * leading slashes from the local part of the path, while retaining
   * the drive name if it exists.
   *
   * @param path: the path.
   *
   * @returns The normalized path.
   */
  normalize(path: string): string {
    throw new Error('Method not implemented.');
  }

  /**
   * Resolve a global path, starting from the root path. Behaves like
   * posix-path.resolve, with 3 differences:
   *  - will never prepend cwd
   *  - if root has a drive name, the result is prefixed with "<drive>:"
   *  - before adding drive name, leading slashes are removed
   *
   * @param path: the path.
   *
   * @returns The normalized path.
   */
  resolvePath(root: string, path: string): string {
    throw new Error('Method not implemented.');
  }

  /**
   * Given a path of the form `drive:local/portion/of/it.txt`
   * get the name of the drive. If the path is missing
   * a drive portion, returns an empty string.
   *
   * @param path: the path.
   *
   * @returns The drive name for the path, or the empty string.
   */
  driveName(path: string): string {
    throw new Error('Method not implemented.');
  }

  /**
   * Given a path, get a ModelDB.IFactory from the
   * relevant backend. Returns `null` if the backend
   * does not provide one.
   */
  getModelDBFactory(path: string): ModelDB.IFactory | null {
    throw new Error('Method not implemented.');
  }

  /**
   * Get an encoded download url given a file path.
   *
   * @param path - An absolute POSIX file path on the server.
   *
   * #### Notes
   * It is expected that the path contains no relative paths.
   *
   * The returned URL may include a query parameter.
   */
  getDownloadUrl(path: string): Promise<string> {
    throw new Error('Method not implemented.');
  }

  /**
   * Increment the counter for a given file type.
   * Used to avoid collisions when creating new untitled files.
   *
   * @param type The file type to increment the counter for.
   */
  private async _incrementCounter(type: ServerContents.ContentType): Promise<number> {
    const current = ((await this._counters.getItem(type)) as number) ?? -1;
    const counter = current + 1;
    await this._counters.setItem(type, counter);
    return counter;
  }

  private _isDisposed = false;
  private _fileChanged = new Signal<this, ServerContents.IChangedArgs>(this);
  private _storage = localforage.createInstance({
    name: STORAGE_NAME,
    description: 'Offline Storage for Notebooks and Files',
    storeName: 'files',
    version: 1
  });
  private _counters = localforage.createInstance({
    name: STORAGE_NAME,
    description: 'Store the current file suffix counters',
    storeName: 'counters',
    version: 1
  });
  private _checkpoints = localforage.createInstance({
    name: STORAGE_NAME,
    description: 'Offline Storage for Checkpoints',
    storeName: 'checkpoints',
    version: 1
  });
}

/**
 * A namespace for private data.
 */
namespace Private {
  /**
   * The content for an empty notebook.
   */
  export const EMPTY_NB: INotebookContent = {
    metadata: {
      orig_nbformat: 4
    },
    nbformat_minor: 4,
    nbformat: 4,
    cells: []
  };
}
