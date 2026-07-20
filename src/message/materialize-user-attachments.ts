import type { NativeAttachmentKind } from '../kernel/kernel-profile';
import { materializeFileAttachments } from '../kernel/materialize-file-attachments';

export interface PreparedUserPayload {
  content: string;
  contextContent?: string;
  attachments?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Authoritative pre-EventBus attachment boundary. The returned payload is safe
 * to enqueue and persist: inline bytes are replaced with durable path context,
 * while `content` remains the original UI projection.
 */
export function prepareUserAttachmentPayload(input: {
  content: string;
  payload?: Record<string, unknown>;
  uploadDir: string;
  nativeAttachmentKinds: readonly NativeAttachmentKind[];
}): PreparedUserPayload {
  const payload = input.payload ?? {};
  const rawAttachments = Array.isArray(payload.attachments)
    ? payload.attachments as Array<Record<string, unknown>>
    : undefined;
  const { attachments: _inlineAttachments, contextContent: _untrustedContext, ...rest } = payload;
  if (!rawAttachments?.length) return { ...rest, content: input.content };

  const materialized = materializeFileAttachments(
    rawAttachments,
    input.uploadDir,
    input.nativeAttachmentKinds,
  );
  const contextContent = materialized.note
    ? `${input.content}\n\n${materialized.note}`
    : input.content;
  return {
    ...rest,
    content: input.content,
    ...(contextContent !== input.content ? { contextContent } : {}),
    ...(materialized.attachments?.length ? { attachments: materialized.attachments } : {}),
  };
}
