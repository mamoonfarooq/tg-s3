import { TelegramClient, MemoryStorage, InputMedia, Document } from '@mtcute/node';
import fs from 'fs';
import path from 'path';

let clientInstance: TelegramClient | null = null;

export function getAppCredentials(): { appId: number; appHash: string; sessionStr: string; groupId: string } {
  const appId = parseInt(process.env.TG_APP_ID || '0', 10);
  const appHash = process.env.TG_APP_HASH || '';
  const sessionStr = process.env.TG_SESSION || '';
  const groupId = process.env.TG_GROUP_ID || '';

  if (!appId || !appHash) {
    throw new Error('TG_APP_ID and TG_APP_HASH must be set in environment variables');
  }

  return { appId, appHash, sessionStr, groupId };
}

export async function getTelegramClient(): Promise<TelegramClient> {
  if (clientInstance) {
    return clientInstance;
  }

  const { appId, appHash, sessionStr } = getAppCredentials();
  if (!sessionStr) {
    throw new Error('TG_SESSION is empty. Please run "npm run login" to authenticate with your Telegram account.');
  }

  const client = new TelegramClient({
    apiId: appId,
    apiHash: appHash,
    storage: new MemoryStorage(),
  });

  await client.importSession(sessionStr);
  await client.start();

  clientInstance = client;
  return clientInstance;
}

/**
 * Upload a chunk file to the target Telegram supergroup/channel.
 * Returns the Telegram message ID and file ID.
 */
export async function uploadChunkToTelegram(
  filePath: string,
  filename: string
): Promise<{ tgMsgId: number; tgFileId: string }> {
  const client = await getTelegramClient();
  const { groupId } = getAppCredentials();

  if (!groupId) {
    throw new Error('TG_GROUP_ID must be set in environment variables');
  }

  const targetGroup = parseInt(groupId, 10) || groupId;

  const message = await client.sendMedia(targetGroup, InputMedia.document(`file:${path.resolve(filePath)}`, {
    caption: `TG-S3 Chunk: ${filename}`,
  }));

  if (message.media?.type !== 'document') {
    throw new Error('Failed to obtain document media from sent Telegram message');
  }

  const doc = message.media as Document;
  const tgFileId = `${doc.raw.id.toString()}:${doc.raw.accessHash.toString()}`;

  return {
    tgMsgId: message.id,
    tgFileId,
  };
}

/**
 * Download a chunk file from Telegram using message ID / media.
 */
export async function downloadChunkFromTelegram(
  tgMsgId: number,
  destPath: string
): Promise<void> {
  const client = await getTelegramClient();
  const { groupId } = getAppCredentials();

  if (!groupId) {
    throw new Error('TG_GROUP_ID must be set in environment variables');
  }

  const targetGroup = parseInt(groupId, 10) || groupId;
  const messages = await client.getMessages(targetGroup, [tgMsgId]);

  if (!messages || messages.length === 0 || !messages[0] || !messages[0].media) {
    throw new Error(`Message ${tgMsgId} not found or contains no media in Telegram entity ${groupId}`);
  }

  const message = messages[0];

  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  await client.downloadToFile(destPath, message.media! as any);
}

/**
 * Delete a chunk message from the target Telegram supergroup/channel.
 */
export async function deleteChunkFromTelegram(tgMsgId: number): Promise<void> {
  const client = await getTelegramClient();
  const { groupId } = getAppCredentials();

  if (!groupId) {
    throw new Error('TG_GROUP_ID must be set in environment variables');
  }

  const targetGroup = parseInt(groupId, 10) || groupId;
  await client.deleteMessagesById(targetGroup, [tgMsgId], { revoke: true });
}

export const MTProtoManager = {
  init: async (config: { appId: string | number; appHash: string; session: string; groupId: string; chunkSize?: string | number }) => {
    process.env.TG_APP_ID = String(config.appId);
    process.env.TG_APP_HASH = config.appHash;
    process.env.TG_SESSION = config.session;
    process.env.TG_GROUP_ID = config.groupId;
    if (config.chunkSize) process.env.CHUNK_SIZE = String(config.chunkSize);
    return await getTelegramClient();
  },
  getClient: getTelegramClient,
  uploadChunk: uploadChunkToTelegram,
  downloadChunk: downloadChunkFromTelegram,
};
