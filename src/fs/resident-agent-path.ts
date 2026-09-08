import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export type ResidentLogicalPath = string;

const RESERVED_SEGMENT = "agents";
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The only codec between the resident definition tree on disk and the logical
 * runtime tree. Physical `agents` segments are structure, never Agent nodes.
 */
export class ResidentPathCodec {
  normalizeLogicalPath(raw: string): ResidentLogicalPath {
    if (
      !raw ||
      raw === "." ||
      isAbsolute(raw) ||
      raw.includes("\\") ||
      raw.includes("//")
    ) {
      throw new Error(`invalid resident logical path: ${JSON.stringify(raw)}`);
    }
    const segments = raw.split("/");
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment === RESERVED_SEGMENT ||
          !SEGMENT_RE.test(segment),
      )
    ) {
      throw new Error(`invalid resident logical path: ${JSON.stringify(raw)}`);
    }
    return segments.join("/");
  }

  toPhysicalRelativePath(raw: ResidentLogicalPath): string {
    const logical = this.normalizeLogicalPath(raw);
    return logical.split("/").join(`/${RESERVED_SEGMENT}/`);
  }

  fromPhysicalRelativePath(raw: string): ResidentLogicalPath {
    if (!raw || isAbsolute(raw) || raw.includes("\\") || raw.includes("//")) {
      throw new Error(`invalid resident physical path: ${JSON.stringify(raw)}`);
    }
    const segments = raw.split("/");
    const logical: string[] = [];
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      if (index % 2 === 1) {
        if (segment !== RESERVED_SEGMENT) {
          throw new Error(`invalid resident physical path: ${JSON.stringify(raw)}`);
        }
        continue;
      }
      logical.push(segment);
    }
    return this.normalizeLogicalPath(logical.join("/"));
  }

  parent(raw: ResidentLogicalPath): ResidentLogicalPath | null {
    const logical = this.normalizeLogicalPath(raw);
    const index = logical.lastIndexOf("/");
    return index < 0 ? null : logical.slice(0, index);
  }
}

/** Stable inside one Session; a renamed resident is intentionally a new identity. */
export function deriveResidentInstanceId(
  sid: string,
  rawLogicalPath: ResidentLogicalPath,
): string {
  if (!sid.trim()) throw new Error("resident sid may not be empty");
  const logicalPath = new ResidentPathCodec().normalizeLogicalPath(rawLogicalPath);
  const digest = createHash("sha256")
    .update("forgeax:resident-instance:v1\0")
    .update(sid)
    .update("\0")
    .update(logicalPath)
    .digest("hex")
    .slice(0, 32);
  return `res_${digest}`;
}
