import type { LocalFilesResult } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';

export const errorKeys: Record<
  Extract<LocalFilesResult, { ok: false }>['error']['code'],
  TranslationKeys
> = {
  UNAVAILABLE: 'com_fs_unavailable',
  INVALID_REQUEST: 'com_fs_invalid',
  PERMISSION_DENIED: 'com_fs_permission',
  NOT_FOUND: 'com_fs_missing',
  UNSUPPORTED_TEXT: 'com_fs_text_only',
  UNSUPPORTED_FORMAT: 'com_fs_unsupported_format',
  UNREADABLE_FILE: 'com_fs_unreadable',
  PASSWORD_REQUIRED: 'com_fs_password',
  PROCESSOR_BUSY: 'com_fs_busy',
  TOO_LARGE: 'com_fs_too_large',
  CONFLICT: 'com_fs_conflict',
  REVIEW_REQUIRED: 'com_fs_review_required',
  REVIEW_EXPIRED: 'com_fs_expired',
  CANCELLED: 'com_fs_cancelled',
  TIMEOUT: 'com_fs_timeout',
  EXECUTION_UNCERTAIN: 'com_fs_uncertain',
  COPY_RETAINED: 'com_fs_copy_retained',
  FAILED: 'com_fs_failed',
};
