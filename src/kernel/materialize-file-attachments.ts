import { mkdirSync, writeFileSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { join, basename, extname, isAbsolute, resolve, relative, sep } from 'node:path';
import type { NativeAttachmentKind } from './kernel-profile';

type Attachment = Record<string, unknown>;

export interface MaterializedUploads {
  /** Native attachments retained as durable path references; empty means undefined. */
  attachments: Attachment[] | undefined;
  /** Durable model context appended to the turn text and canonical history. */
  note: string;
}

function sanitizeFileName(raw: unknown, kind: unknown): string {
  const name = typeof raw === 'string' && raw.trim() ? basename(raw.trim()) : '';
  const clean = name.replace(/[<>:"|?*\\/]/g, '_').replace(/[\x00-\x1f]/g, '_').replace(/^\.+$/, '');
  if (clean) return clean;
  if (kind === 'image') return 'image.bin';
  if (kind === 'document') return 'document.pdf';
  return 'upload.bin';
}

function uniquePath(dir: string, fileName: string): string {
  const ext = extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = join(dir, fileName);
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

type RelativePath = (from: string, to: string) => string;
type AbsolutePathCheck = (path: string) => boolean;

/** Path-semantics-aware strict containment (equal and outside are both false). */
export function isPathInside(
  parent: string,
  candidate: string,
  pathRelative: RelativePath = relative,
  separator: string = sep,
  pathIsAbsolute: AbsolutePathCheck = isAbsolute,
): boolean {
  const rel = pathRelative(parent, candidate);
  return rel !== ''
    && rel !== '..'
    && !rel.startsWith(`..${separator}`)
    && !pathIsAbsolute(rel);
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

const GUIDANCE =
  'The user attached the file(s) above. Read or parse them from the given absolute path(s) with your tools. If a file cannot be processed, tell the user clearly why.';

function saveAttachment(att: Attachment, uploadDir: string): { path: string; bytes: number } {
  mkdirSync(uploadDir, { recursive: true });
  const path = uniquePath(uploadDir, sanitizeFileName(att.name, att.kind));
  if (typeof att.data === 'string' && att.data) {
    const base64 = att.data.replace(/^data:[^,]*,/, '');
    const bytes = Buffer.from(base64, 'base64');
    writeFileSync(path, bytes);
    return { path: resolve(path), bytes: bytes.length };
  }
  if (typeof att.path === 'string' && att.path) {
    const source = resolve(isAbsolute(att.path) ? att.path : resolve(att.path));
    const durableDir = resolve(uploadDir);
    // Native ingress may already have materialized this attachment in the
    // authoritative session uploads directory. Reuse it idempotently.
    if (isPathInside(durableDir, source)) {
      return { path: source, bytes: statSync(source).size };
    }
    copyFileSync(source, path);
    return { path: resolve(path), bytes: statSync(path).size };
  }
  throw new Error('attachment had no data or path');
}

/**
 * Materialize every attachment. Kinds declared native are retained as path-only
 * references; every other kind becomes durable text context only.
 */
export function materializeFileAttachments(
  attachments: Attachment[] | undefined,
  uploadDir: string,
  nativeKinds: readonly NativeAttachmentKind[] = [],
): MaterializedUploads {
  if (!attachments?.length) return { attachments, note: '' };
  const native = new Set<string>(nativeKinds);
  const retained: Attachment[] = [];
  const lines: string[] = [];
  let saved = 0;

  for (const att of attachments) {
    const kind = typeof att.kind === 'string' ? att.kind : 'file';
    const name = sanitizeFileName(att.name, kind);
    try {
      const stored = saveAttachment(att, uploadDir);
      const mediaType = typeof att.mediaType === 'string' && att.mediaType ? att.mediaType : 'unknown type';
      lines.push(`[Attached ${kind}: ${stored.path} (${mediaType}, ${humanSize(stored.bytes)})]`);
      saved++;
      if (native.has(kind)) {
        retained.push({ kind, path: stored.path, ...(mediaType !== 'unknown type' ? { mediaType } : {}) });
      }
    } catch (err) {
      lines.push(`[Attached ${kind} "${name}" could not be saved: ${err instanceof Error ? err.message : String(err)}]`);
    }
  }

  if (saved > 0) lines.push(GUIDANCE);
  return { attachments: retained.length ? retained : undefined, note: lines.join('\n') };
}
