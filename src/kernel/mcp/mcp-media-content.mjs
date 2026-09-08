/**
 * Normalize host-tool results at the standalone MCP boundary.
 *
 * File media is resolved by the host bridge before it reaches this process;
 * this module intentionally has no path-reading fallback. That keeps the
 * inContainer contract at the existing host/sandbox boundary rather than
 * silently interpreting a container path as a host path here.
 */

/** Keep a host image from turning into an unbounded MCP/provider payload. */
export const MAX_MCP_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MCP_IMAGE_BASE64_CHARS = Math.ceil(MAX_MCP_IMAGE_BYTES / 3) * 4;
/** Keep generated/attached audio bounded before it reaches an MCP provider. */
export const MAX_MCP_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_MCP_AUDIO_BASE64_CHARS = Math.ceil(MAX_MCP_AUDIO_BYTES / 3) * 4;

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4']);

function textPart(text) {
  return { type: 'text', text: String(text) };
}

function safeJsonText(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function imageFallback(reason) {
  return textPart(`image unavailable (${reason})`);
}

function audioFallback(reason) {
  return textPart(`audio unavailable (${reason})`);
}

function canonicalMime(mime) {
  const normalized = String(mime).trim().toLowerCase();
  if (normalized === 'image/jpg' || normalized === 'image/pjpeg') return 'image/jpeg';
  if (normalized === 'image/x-png') return 'image/png';
  return normalized;
}

function canonicalAudioMime(mime) {
  const normalized = String(mime).trim().toLowerCase();
  if (normalized === 'audio/mp3') return 'audio/mpeg';
  if (normalized === 'audio/x-wav' || normalized === 'audio/wave') return 'audio/wav';
  return normalized;
}

function startsWith(bytes, offset, signature) {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function sniffImageMime(bytes) {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return undefined;
}

function sniffAudioMime(bytes) {
  if (startsWith(bytes, 0, [0x49, 0x44, 0x33])) return 'audio/mpeg';
  if (startsWith(bytes, 0, [0xff, 0xfb])
    || startsWith(bytes, 0, [0xff, 0xf3])
    || startsWith(bytes, 0, [0xff, 0xf2])) return 'audio/mpeg';
  if (startsWith(bytes, 0, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  if (startsWith(bytes, 0, [0x66, 0x4c, 0x61, 0x43])) return 'audio/flac';
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    && startsWith(bytes, 8, [0x57, 0x41, 0x56, 0x45])) return 'audio/wav';
  if (startsWith(bytes, 4, [0x66, 0x74, 0x79, 0x70])
    && (startsWith(bytes, 8, [0x4d, 0x34, 0x41, 0x20])
      || startsWith(bytes, 8, [0x4d, 0x34, 0x42, 0x20]))) return 'audio/mp4';
  return undefined;
}

/** Strict canonical base64 plus decoded-size and magic-byte validation. */
function normalizeInlineImage(data, mimeType) {
  if (typeof data !== 'string' || typeof mimeType !== 'string' || !data) {
    return imageFallback('missing data or MIME');
  }
  // Reject an oversized encoded payload before Buffer.from can allocate it.
  if (data.length > MAX_MCP_IMAGE_BASE64_CHARS) {
    return imageFallback(`larger than ${MAX_MCP_IMAGE_BYTES} bytes`);
  }
  // Reject whitespace, URL-safe alphabets, bad padding and unpadded encodings.
  if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    return imageFallback('invalid base64');
  }
  let bytes;
  try {
    bytes = Buffer.from(data, 'base64');
  } catch {
    return imageFallback('invalid base64');
  }
  if (bytes.length === 0 || bytes.length > MAX_MCP_IMAGE_BYTES) {
    return imageFallback(`larger than ${MAX_MCP_IMAGE_BYTES} bytes or empty`);
  }
  if (bytes.toString('base64') !== data) return imageFallback('non-canonical base64');
  const sniffed = sniffImageMime(bytes);
  if (!sniffed || !IMAGE_MIMES.has(sniffed) || canonicalMime(mimeType) !== sniffed) {
    return imageFallback('MIME does not match image bytes');
  }
  return { type: 'image', data: bytes.toString('base64'), mimeType: sniffed };
}

/** Strict canonical base64 plus decoded-size and magic-byte validation. */
function normalizeInlineAudio(data, mimeType) {
  if (typeof data !== 'string' || typeof mimeType !== 'string' || !data) {
    return audioFallback('missing data or MIME');
  }
  if (data.length > MAX_MCP_AUDIO_BASE64_CHARS) {
    return audioFallback(`larger than ${MAX_MCP_AUDIO_BYTES} bytes`);
  }
  if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    return audioFallback('invalid base64');
  }
  let bytes;
  try {
    bytes = Buffer.from(data, 'base64');
  } catch {
    return audioFallback('invalid base64');
  }
  if (bytes.length === 0 || bytes.length > MAX_MCP_AUDIO_BYTES) {
    return audioFallback(`larger than ${MAX_MCP_AUDIO_BYTES} bytes or empty`);
  }
  if (bytes.toString('base64') !== data) return audioFallback('non-canonical base64');
  const sniffed = sniffAudioMime(bytes);
  if (!sniffed || !AUDIO_MIMES.has(sniffed) || canonicalAudioMime(mimeType) !== sniffed) {
    return audioFallback('MIME does not match audio bytes');
  }
  return { type: 'audio', data: bytes.toString('base64'), mimeType: sniffed };
}

function hasOnlyKeys(value, required, optional) {
  const allowed = new Set(['type', ...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** Runtime discriminator for the public ContentPart union. */
export function isStrictContentPart(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const part = value;
  if (typeof part.type !== 'string') return false;
  switch (part.type) {
    case 'text':
      return typeof part.text === 'string' && hasOnlyKeys(part, ['text'], []);
    case 'image':
    case 'video':
    case 'audio':
      return typeof part.data === 'string'
        && typeof part.mimeType === 'string'
        && hasOnlyKeys(part, ['data', 'mimeType'], ['name'])
        && (part.name === undefined || typeof part.name === 'string');
    case 'text_file':
    case 'file':
    case 'image_file':
    case 'video_file':
    case 'audio_file':
      return typeof part.path === 'string'
        && typeof part.mimeType === 'string'
        && hasOnlyKeys(part, ['path', 'mimeType'], ['inContainer'])
        && (part.inContainer === undefined || typeof part.inContainer === 'boolean');
    default:
      return false;
  }
}

function isStrictContentPartArray(value) {
  // [] is ambiguous ordinary JSON and must remain one text value.
  return Array.isArray(value) && value.length > 0 && value.every(isStrictContentPart);
}

function partToMcpContent(part) {
  if (typeof part === 'string') return textPart(part);
  if (!part || typeof part !== 'object') return textPart(safeJsonText(part));
  if (!isStrictContentPart(part)) return textPart(safeJsonText(part));
  if (part.type === 'text') return textPart(part.text);
  if (part.type === 'image') return normalizeInlineImage(part.data, part.mimeType);
  if (part.type === 'audio') return normalizeInlineAudio(part.data, part.mimeType);
  if (part.type === 'image_file') {
    // The host responseFormat=mcp-content-v1 path must have materialized this
    // before serialization. Never read a path in the MCP child.
    return imageFallback('file media was not normalized by the host bridge');
  }
  if (part.type === 'audio_file') {
    // The host responseFormat=mcp-content-v1 path must have materialized this
    // before serialization. Never read a path in the MCP child.
    return audioFallback('file media was not normalized by the host bridge');
  }
  return textPart(safeJsonText(part));
}

/**
 * Convert a host-tool result into MCP content without flattening validated
 * media into JSON text. Ordinary arrays/objects remain one JSON text block.
 */
export async function hostResultToMcpContent(result) {
  if (isStrictContentPartArray(result)) {
    const content = [];
    for (const part of result) content.push(partToMcpContent(part));
    return content;
  }
  return [partToMcpContent(result)];
}

/** Normalize already parsed legacy screenshot parts using the same checks. */
export function contentPartsToMcpContent(parts) {
  if (!isStrictContentPartArray(parts)) return undefined;
  return parts.map(partToMcpContent);
}
