import type { Attachment } from '../shared/types';
import type { CalledParticipant } from '../shared/participants';
import {
  externalAgentCatalog,
  externalAgentIds,
  externalInvocation,
  externalMention,
  type ExternalAgentId,
  type ExternalAgentView,
} from '../shared/external-agents';

import { attachmentLimits } from '../shared/attachments';
export { attachmentLimits } from '../shared/attachments';
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const extensionTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
};
export type DraftAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
  uploaded?: { conversationId: string; attachment: Attachment };
};

/**
 * The external agents (text only) this message would reach without its attachments, picked the way the server picks
 * them (routeTypedMessage, ExternalAgents.intercept): the chat's bound agent, the ones called by name, or one the text
 * calls with `@@` or a leading request to a ready agent. `mixed`: other called participants still get the files.
 */
export function textOnlyRecipients(
  count: number,
  called: readonly CalledParticipant[],
  text: string,
  agents: readonly Pick<ExternalAgentView, 'id' | 'name' | 'enabled' | 'available' | 'added'>[],
  boundAgentId?: ExternalAgentId,
) {
  if (!count) return undefined;
  if (boundAgentId) return { names: [externalAgentCatalog[boundAgentId].name], mixed: false };
  const typed = text.includes('@@')
    ? externalMention(
        text,
        externalAgentIds.map((id) => ({ id, name: externalAgentCatalog[id].name })),
      )
    : externalInvocation(
        text,
        agents.filter((agent) => agent.enabled && agent.available && agent.added),
      );
  const named =
    called.length > 1 || called[0]?.kind === 'external' || called[0]?.kind === 'device'
      ? called.filter((item) => item.kind === 'external')
      : typed
        ? [typed]
        : [];
  return named.length ? { names: named.map((agent) => agent.name), mixed: named.length < called.length } : undefined;
}

export function attachmentMimeType(file: Pick<File, 'name' | 'type'>) {
  return file.type || extensionTypes[file.name.split('.').at(-1)?.toLowerCase() ?? ''] || 'application/octet-stream';
}
export function isAttachmentImage(file: Pick<File, 'name' | 'type'>) {
  return imageTypes.has(attachmentMimeType(file));
}
export function attachmentSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Validate before reading file bytes or creating previews. Existing drafts remain unchanged. */
export function selectAttachmentFiles(existing: readonly DraftAttachment[], incoming: readonly File[]) {
  const accepted: File[] = [],
    errors: string[] = [];
  let total = existing.reduce((sum, item) => sum + item.file.size, 0);
  for (const file of incoming) {
    const name = file.name || '未命名文件';
    if (!file.name || file.name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(file.name)) {
      errors.push(`${name}：文件名不可包含路径或控制字符，且最多 200 个字符。`);
      continue;
    }
    if (existing.length + accepted.length >= attachmentLimits.count) {
      errors.push('每条消息最多添加 8 个附件。');
      continue;
    }
    if (!file.size) {
      errors.push(`${name}：这个文件是空的，请重新复制或改用拖入`);
      continue;
    }
    const limit = isAttachmentImage(file) ? attachmentLimits.imageBytes : attachmentLimits.fileBytes;
    if (file.size > limit) {
      errors.push(`${name}：文件最大 50 MB。`);
      continue;
    }
    if (total + file.size > attachmentLimits.totalBytes) {
      errors.push('每条消息的附件总大小不能超过 200 MB。');
      continue;
    }
    accepted.push(file);
    total += file.size;
  }
  return { accepted, errors: [...new Set(errors)] };
}

export function filesFromTransfer(transfer: Pick<DataTransfer, 'files' | 'items'>): File[] {
  const files = Array.from(transfer.files ?? []);
  if (files.length) return files;
  return Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** Clipboard apps sometimes expose an empty placeholder alongside the real image. */
export async function pastedAttachmentFiles(files: readonly File[]): Promise<File[]> {
  if (!files.some((file) => !file.size && isAttachmentImage(file))) return [...files];
  let images: Blob[] = [];
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((type) => imageTypes.has(type));
      if (type) {
        const blob = await item.getType(type);
        if (blob.size) images.push(blob);
      }
    }
  } catch {
    /* Intake reports the empty file if clipboard access is unavailable. */
  }
  let next = 0;
  return files.flatMap((file) => {
    if (file.size || !isAttachmentImage(file)) return [file];
    if (files.some((other) => other.size && isAttachmentImage(other))) return [];
    const blob = images[next++];
    return [blob ? new File([blob], file.name, { type: blob.type }) : file];
  });
}

let thumbnailQueue: Promise<unknown> = Promise.resolve();
export function attachmentThumbnail(file: Blob, size: 'draft' | 'message' = 'draft'): Promise<Blob> {
  const result = thumbnailQueue.then(async () => {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const scale = Math.min(
        1,
        size === 'draft' ? 112 / Math.min(bitmap.width, bitmap.height) : 600 / Math.max(bitmap.width, bitmap.height),
      );
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
      );
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await canvas.convertToBlob({ type: 'image/png' });
    } finally {
      bitmap.close();
    }
  });
  thumbnailQueue = result.catch(() => {});
  return result;
}

export async function fittedAttachment(file: File): Promise<File | undefined> {
  if (!isAttachmentImage(file) || attachmentMimeType(file) === 'image/gif') return;
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const edge = Math.max(bitmap.width, bitmap.height);
    if (file.size <= attachmentLimits.fittedBytes && edge <= attachmentLimits.imageLongEdge) return;
    const scale = Math.min(1, attachmentLimits.fittedLongEdge / edge);
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (attachmentMimeType(file) === 'image/png') {
      const png = await canvas.convertToBlob({ type: 'image/png' });
      if (png.size <= attachmentLimits.fittedBytes) return new File([png], 'fitted.png', { type: png.type });
    }
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: attachmentMimeType(file) === 'image/png' ? 0.9 : 0.85,
    });
    if (jpeg.size <= attachmentLimits.fittedBytes) return new File([jpeg], 'fitted.jpg', { type: jpeg.type });
  } finally {
    bitmap.close();
  }
}

export class AttachmentScopeChanged extends Error {
  constructor() {
    super('已切换会话，本次消息未发送；原会话的附件草稿仍然保留。');
  }
}

/** Keep each upload attached to its captured conversation; preserve uploaded IDs for retries. */
export async function uploadDraftAttachments(
  api: <T>(path: string, body?: unknown, method?: string) => Promise<T>,
  conversationId: string,
  attachments: readonly DraftAttachment[],
  isCurrent: () => boolean,
  onUploaded: (draftId: string, attachment: Attachment) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (const item of attachments) {
    if (!isCurrent()) throw new AttachmentScopeChanged();
    if (item.uploaded?.conversationId === conversationId) {
      ids.push(item.uploaded.attachment.id);
      continue;
    }
    const fitted = await fittedAttachment(item.file).catch(() => undefined);
    if (!isCurrent()) throw new AttachmentScopeChanged();
    const path = `/api/conversations/${encodeURIComponent(conversationId)}/attachments`;
    const attachment = await api<Attachment>(path, item.file);
    if (fitted) {
      try {
        await api<Attachment>(`${path}?original=${encodeURIComponent(attachment.id)}`, fitted);
      } catch {
        /* The executor emits a clear note if the fitted copy could not be saved. */
      }
    }
    onUploaded(item.id, attachment);
    if (!isCurrent()) throw new AttachmentScopeChanged();
    ids.push(attachment.id);
  }
  if (!isCurrent()) throw new AttachmentScopeChanged();
  return ids;
}

export function attachmentContentUrl(conversationId: string, attachmentId: string) {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}

async function clipboardPng(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('无法读取这张图片，请重试或下载原图。');
  const original = await response.blob();
  if (original.type === 'image/png') return original;
  if (!imageTypes.has(original.type)) throw new Error('此附件不支持复制为图片，请下载原文件。');
  const bitmap = await createImageBitmap(original);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 32 * 1024 * 1024)
      throw new Error('图片尺寸过大，无法放入剪贴板，请下载原图。');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前环境无法转换剪贴板图片，请下载原图。');
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('图片复制转换失败，请下载原图。'))),
        'image/png',
      ),
    );
  } finally {
    bitmap.close();
  }
}

/** Invoke write synchronously from the click; asynchronous PNG loading retains the user gesture. */
export function copyAttachmentImage(conversationId: string, attachment: Attachment): Promise<void> {
  if (attachment.kind !== 'image') return Promise.reject(new Error('此附件不是图片，请使用下载。'));
  if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    return Promise.reject(new Error('当前环境不支持复制图片，请点击图片下载原图。'));
  const png = clipboardPng(attachmentContentUrl(conversationId, attachment.id));
  // A clipboard permission rejection may occur before it begins reading the image promise.
  void png.catch(() => {});
  try {
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).catch((error) => {
      if (error instanceof Error && error.name === 'NotAllowedError')
        throw new Error('未获得剪贴板写入权限，请重试；也可以点击图片下载原图。');
      throw new Error('无法复制图片，请重试或点击图片下载原图。');
    });
  } catch {
    return Promise.reject(new Error('当前环境无法复制图片，请点击图片下载原图。'));
  }
}
