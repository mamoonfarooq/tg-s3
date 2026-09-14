export type Lang = 'en';
export const SUPPORTED_LANGS: Lang[] = ['en'];

export function detectLang(_request: Request): Lang {
  return 'en';
}

export const shareStrings: Record<Lang, Record<string, string>> = {
  en: {
    page_title: '{0}',
    file_share: 'File share',
    filename: 'Filename',
    size: 'Size',
    type: 'Type',
    expiry: 'Expiry',
    downloads: 'Downloads',
    note: 'Note',
    download_file: 'Download file',
    copy_link: 'Copy link',
    copied: 'Copied!',
    copy_failed: 'Copy failed',
    preview_failed: 'Preview failed',
    permanent: 'Permanent',
    expired: 'Expired',
    days: 'd',
    hours: 'h',
    minutes: 'm',
    seconds: 's',
    live_photo: 'Live photo',
    loading_preview: 'Loading preview...',
    content_truncated: 'Preview truncated',
    text_too_large: 'This text file is too large to preview ({0}).',
    password_title: 'Access required',
    password_required: 'Password required',
    enter_password: 'Enter password',
    verify: 'Verify',
    wrong_password: 'Incorrect password',
    remaining_attempts: '{0} attempts remaining',
    locked_msg: 'Too many attempts. Please try again in {0} minutes.',
    share_expired: 'Share expired',
    share_expired_msg: 'This shared file is no longer available.',
    share_max_downloads: 'Download limit reached',
    share_max_downloads_msg: 'This shared file has reached its download limit.',
    share_not_found: 'Share not found',
    share_not_found_msg: 'The requested share was not found.',
    share_invalid: 'Invalid share',
    share_invalid_msg: 'This share is invalid or unavailable.',
    download_failed: 'Download failed',
    download_failed_msg: 'The file could not be downloaded.'
  }
};
