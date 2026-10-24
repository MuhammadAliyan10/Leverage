import { File } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';

/** expo-sqlite exposes a native filesystem path; expo-file-system File requires a file:// URI. */
export function getSqliteFile(name: string): File {
  const directory = SQLite.defaultDatabaseDirectory;
  if (!directory) throw new Error('The local database directory is unavailable.');

  const directoryUri = directory.startsWith('file://')
    ? directory
    : directory.startsWith('/')
      ? `file://${directory.split('/').map(encodeURIComponent).join('/')}`
      : null;
  if (!directoryUri) throw new Error('The local database directory is not an absolute path.');

  return new File(directoryUri, name);
}
