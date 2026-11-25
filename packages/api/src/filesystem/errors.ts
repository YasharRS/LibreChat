import { ErrorTypes } from 'librechat-data-provider';

export class LocalFilesUnavailableError extends Error {
  readonly code = ErrorTypes.LOCAL_FILES_UNAVAILABLE;
  readonly status = 409;
  readonly statusCode = 409;
  constructor() {
    super('The selected local folder is unavailable.');
  }
}
