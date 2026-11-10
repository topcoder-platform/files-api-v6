import { BadRequestException } from '@nestjs/common';

export const MAX_SUPPORT_ATTACHMENT_BYTES = 2 * 1024 * 1024;

// Preserve the existing Support attachment contract for direct API callers too.
const ALLOWED_MIME_TYPES_BY_EXTENSION: Readonly<
  Record<string, readonly string[]>
> = {
  '.7z': ['application/x-7z-compressed'],
  '.bmp': ['image/bmp'],
  '.csv': ['text/csv'],
  '.doc': ['application/msword'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  '.gif': ['image/gif'],
  '.gz': ['application/gzip', 'application/x-gzip'],
  '.jpeg': ['image/jpeg'],
  '.jpg': ['image/jpeg'],
  '.json': ['application/json'],
  '.log': ['text/plain'],
  '.pdf': ['application/pdf'],
  '.png': ['image/png'],
  '.ppt': ['application/vnd.ms-powerpoint'],
  '.pptx': [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  '.rar': ['application/vnd.rar', 'application/x-rar-compressed'],
  '.tar': ['application/x-tar'],
  '.tgz': ['application/gzip', 'application/x-gzip'],
  '.tif': ['image/tiff'],
  '.tiff': ['image/tiff'],
  '.txt': ['text/plain'],
  '.webp': ['image/webp'],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  '.xml': ['application/xml', 'text/xml'],
  '.zip': ['application/zip', 'application/x-zip-compressed'],
};

export function validateSupportFile(
  filename: string,
  contentType: string,
): void {
  const name = filename.trim();
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (
    !ALLOWED_MIME_TYPES_BY_EXTENSION[extension]?.includes(
      contentType.trim().toLowerCase(),
    )
  ) {
    throw new BadRequestException(
      'This file type is not allowed for support attachments.',
    );
  }
}
