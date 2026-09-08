import { createHash } from "node:crypto";

/** Recursively freeze JSON-like runtime contracts at the producer boundary. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

/** Clone before freezing so callers cannot mutate a registered snapshot by alias. */
export function cloneAndFreeze<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

/** Stable JSON hash used for opaque ids and immutable revision tokens. */
export function stableHash(value: unknown, length = 32): string {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, length);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}
