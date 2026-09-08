// SSOT for "what leaves the workspace" + the fail-closed secret gate.
//
// Policy (decision 2026-07-09, product owner): upload the ENTIRE `.forgeax`
// directory — everything a user could want to restore — EXCEPT:
//   - runtime garbage that regenerates itself (playwright cache, run/lock/
//     sentinels, logs, node_modules, cache, checkpoints)
//   - secret-bearing files by name (.env / .key / .pem / dev-stack.env …)
//   - the upload feature's own local bookkeeping (upload.json / upload-log.jsonl)
// A content-level secret scan (below) remains the fail-closed safety net for
// anything the name rules can't see.
//
// One recursive predicate (isExcluded) is reused by the include-walk and any deny
// check, so exclusion is decided in ONE place. Walk semantics are deliberately
// explicit (segment / basename / suffix matching), not an unconfigured glob —
// every rule below is unit-tested against a fixture tree.

import { lstatSync, readdirSync, readlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── What may NOT be uploaded (everything else in `.forgeax` goes) ───────────

/** Path *segments* (matched against any component, at every depth) whose whole
 *  subtree is excluded — runtime state that regenerates itself. */
export const EXCLUDE_SEGMENTS: readonly string[] = [
  "logs",
  "debug",
  "node_modules",   // games/* may symlink to packages with node_modules — git chokes
  "cache",          // includes the upload staging scratch if it ever lands here
  "run",
  "run.lock",
  "sentinels",
  "playwright-mcp", // MCP browser cache, tens of MB of pure runtime garbage
  "chrome-webgpu-profile", // Chrome profile: hundreds of MB AND carries login state/cookies
  "checkpoints",    // content-addressed rewind blobs — multi-GB, regenerable, blows GitHub's 100MB blob cap
];

/** Top-level `.forgeax` entries that hold the user's own project content rather
 *  than runtime diagnostics. The feedback PRD §5 attaches the `.forgeax`
 *  directory but states "不含项目内容", so a report carries the environment,
 *  session, trajectory, log and screenshot material and leaves the games and
 *  the source workspace behind. Matched at the top level only: these are
 *  directory identities, not names that should be denied at any depth. */
export const EXCLUDE_PROJECT_CONTENT_ROOTS: readonly string[] = [
  "games",                // user projects: sources, assets, their own .git
  "ide-source-workspace",  // mounted source checkout, not diagnostics
];

/** Files excluded by exact basename — known runtime / secret-bearing files,
 *  plus the upload feature's own local bookkeeping. */
export const EXCLUDE_BASENAMES: readonly string[] = [
  ".DS_Store",
  "dev-stack.env",
  "extension-dev-ports.json",
  "plugin-dev-ports.json", // legacy name (pre ADR 0025 词汇清尾)
  "browser-localStorage.json", // regenerable UI state; a localStorage dump can hold auth tokens
  "keys.yaml",                 // cli-provider key registry (<projectRoot>/.forgeax/keys.yaml) — raw API keys
  "upload.json",
  "upload-log.jsonl",
];

/** Files excluded by suffix — secret carriers by convention. */
export const EXCLUDE_SUFFIXES: readonly string[] = [".env", ".key", ".pem"];

/** Default per-file size gate. Oversized files are skipped (and reported) so a
 *  fat cooked asset can't hard-reject the push (GitHub's 100MB limit). */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** A directory whose basename is a rollback backup snapshot, e.g.
 *  `cow-level.bak-1781237317`. Matched as a directory-name predicate (not a glob)
 *  because these are the single largest excludable payload and glob dir-segment
 *  semantics are too subtle to bet on. */
export function isBackupDir(name: string): boolean {
  return /\.bak-\d+$/.test(name);
}

/** Should this posix RELATIVE path (under `.forgeax`) be excluded? The one
 *  predicate shared by the walk and any deny check. */
export interface WorkspaceEgressPathOptions {
  /** Feedback diagnostics retain logs/debug after staging redaction; /upload does not. */
  includeDiagnosticLogs?: boolean;
  /** Feedback drops the user's own project content (PRD §5 "不含项目内容");
   *  /upload exists to carry the workspace and keeps it. */
  excludeProjectContent?: boolean;
}

export function isExcluded(relPath: string, opts: WorkspaceEgressPathOptions = {}): boolean {
  const segs = relPath.split("/").filter(Boolean);
  if (segs.length === 0) return false;
  if (opts.excludeProjectContent && EXCLUDE_PROJECT_CONTENT_ROOTS.includes(segs[0]!)) return true;
  for (const seg of segs) {
    if (EXCLUDE_SEGMENTS.includes(seg)) {
      if (opts.includeDiagnosticLogs && (seg === "logs" || seg === "debug")) continue;
      return true;
    }
    if (isBackupDir(seg)) return true;
  }
  const base = segs[segs.length - 1]!;
  if (EXCLUDE_BASENAMES.includes(base)) return true;
  for (const suf of EXCLUDE_SUFFIXES) if (base.endsWith(suf)) return true;
  return false;
}

/** Is a top-level entry name uploadable? Everything except the deny rules. */
export function isIncludedRoot(name: string): boolean {
  return !isExcluded(name);
}

// ── Tree walk ────────────────────────────────────────────────────────────────

export interface UploadFile {
  abs: string;
  /** posix path relative to the source root (`.forgeax`). */
  rel: string;
  bytes: number;
}

export interface WalkResult {
  files: UploadFile[];
  /** Symlinks encountered and NOT followed. `.forgeax/games/<slug>` sample games
   *  are symlinks into the packages/games monorepo source — dereferencing them
   *  would push engine source to a public repo, so we skip and report. */
  skippedSymlinks: { rel: string; target: string }[];
  /** Files over the size gate — not uploaded. */
  skippedLarge: { rel: string; bytes: number }[];
  totalBytes: number;
}

export interface WalkOptions extends WorkspaceEgressPathOptions {
  maxFileBytes?: number;
}

/** Walk `<srcRoot>` (= `<projectRoot>/.forgeax`) collecting uploadable regular
 *  files — the whole directory minus the deny rules. Applies isExcluded at every
 *  depth; never follows symlinks; enforces the size gate. Pure filesystem read —
 *  no git, fully unit-testable against a fixture tree. */
export function walkUploadTree(srcRoot: string, opts: WalkOptions = {}): WalkResult {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const out: WalkResult = { files: [], skippedSymlinks: [], skippedLarge: [], totalBytes: 0 };

  let topEntries: string[];
  try {
    topEntries = readdirSync(srcRoot);
  } catch {
    return out; // no .forgeax → empty result (caller decides if that's an error)
  }

  for (const name of topEntries) {
    if (isExcluded(name, opts)) continue;
    walk(join(srcRoot, name), name, out, maxBytes, opts);
  }
  return out;
}

function walk(abs: string, rel: string, out: WalkResult, maxBytes: number, opts: WalkOptions): void {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return; // dangling entry — skip, keep enumerating siblings
  }

  if (st.isSymbolicLink()) {
    let target = "";
    try {
      target = readlinkSync(abs);
    } catch {
      /* ignore */
    }
    out.skippedSymlinks.push({ rel, target });
    return;
  }

  if (st.isDirectory()) {
    let children: string[];
    try {
      children = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of children) {
      const childRel = `${rel}/${name}`;
      if (isExcluded(childRel, opts)) continue;
      walk(join(abs, name), childRel, out, maxBytes, opts);
    }
    return;
  }

  if (st.isFile()) {
    if (st.size > maxBytes) {
      out.skippedLarge.push({ rel, bytes: st.size });
      return;
    }
    out.files.push({ abs, rel, bytes: st.size });
    out.totalBytes += st.size;
  }
}

// ── Fail-closed content secret scan ──────────────────────────────────────────

/** Patterns of common credential shapes. A filename denylist alone can't catch a
 *  key pasted INTO a souls/memory note or logged inline — this scans bytes. */
const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  // sk-ant- first-class: the sk- pattern below can't match it (hyphens break the
  // run), and the env-literal scan only covers THIS machine's key — a key pasted
  // into a souls memory / transcript is exactly what this gate exists for.
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "openai-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { kind: "github-token", re: /gh[opsur]_[A-Za-z0-9]{36}/ }, // ghp_/gho_/ghu_/ghs_/ghr_
  { kind: "github-pat-fine", re: /github_pat_[A-Za-z0-9_]{40,}/ },
  { kind: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  { kind: "private-key-pem", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { kind: "jwt-bearer", re: /bearer\s+eyJ[A-Za-z0-9_-]{10,}/i },
];

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/gi;
const INLINE_SENSITIVE_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)\s*([=:])\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)/gi;
const REDACTED = "[REDACTED]";

export interface SecretHit {
  rel: string;
  kind: string;
}

/** Env vars whose literal values must never appear in an uploaded byte (the upload
 *  token itself + LLM keys). Returned values are filtered to non-trivial length so
 *  an empty/short env var can't match everything. */
export function sensitiveEnvLiterals(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = [
    "FORGEAX_UPLOAD_GITHUB_TOKEN",
    "FORGEAX_FEEDBACK_GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
  ];
  const out: string[] = [];
  for (const k of keys) {
    const v = env[k];
    if (v && v.trim().length >= 8) out.push(v.trim());
  }
  return out;
}

/** Scan one file's text for secret patterns + literal env-secret values. */
export function scanContentForSecrets(rel: string, content: string, literals: string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    if (re.test(content)) hits.push({ rel, kind });
  }
  for (const lit of literals) {
    if (content.includes(lit)) hits.push({ rel, kind: "env-secret-literal" });
  }
  INLINE_SENSITIVE_ASSIGNMENT.lastIndex = 0;
  for (const match of content.matchAll(INLINE_SENSITIVE_ASSIGNMENT)) {
    if (shouldRedactAssignedValue(match[3] ?? "", match[1] ?? "")) {
      hits.push({ rel, kind: "sensitive-assignment" });
      break;
    }
  }
  return hits;
}

export interface RedactedEgressText {
  value: string;
  kinds: string[];
}

/** Redact known credential material in a staging copy. The source file is untouched. */
export function redactSecretsInText(content: string, literals: string[]): RedactedEgressText {
  const kinds = new Set<string>();
  let value = content.replace(PRIVATE_KEY_BLOCK, () => {
    kinds.add("private-key-pem");
    return REDACTED;
  });
  for (const { kind, re } of SECRET_PATTERNS) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    value = value.replace(new RegExp(re.source, flags), () => {
      kinds.add(kind);
      return REDACTED;
    });
  }
  for (const literal of literals) {
    if (!literal || !value.includes(literal)) continue;
    kinds.add("env-secret-literal");
    value = value.split(literal).join(REDACTED);
  }
  INLINE_SENSITIVE_ASSIGNMENT.lastIndex = 0;
  value = value.replace(INLINE_SENSITIVE_ASSIGNMENT, (match, key: string, separator: string, raw: string) => {
    if (!shouldRedactAssignedValue(raw, key)) return match;
    kinds.add("sensitive-assignment");
    return `${key}${separator}${REDACTED}`;
  });
  return { value, kinds: [...kinds].sort() };
}

/**
 * Does an assigned value look like a credential?
 *
 * The key name is only a hint about intent, never proof: `credentials =
 * "include"` is a fetch option and `token: string` is a type annotation, while
 * a real key can sit behind any name at all. Judging by key name mis-redacted
 * 11 of 12 benign values and missed 5 of 12 real credentials, so the decision
 * is made on the value's own shape:
 *
 *   1. a known issuer prefix (exact, covers the mainstream services)
 *   2. bare hex, but only where the key name says it is a credential — git
 *      shas and file digests share that shape and are diagnostic signal
 *   3. an entropy fallback for house formats, with the shapes that merely look
 *      random (paths, URLs, UUIDs, versions, template literals) excluded
 */
function shouldRedactAssignedValue(raw: string, key = ""): boolean {
  const value = raw.replace(/^["']|["']$/g, "").trim();
  // Our own sentinel: redaction must converge, or a cleaned file fails the very
  // gate it was cleaned for. Prefix, not equality — minified code leaves the
  // sentinel glued to what follows (`authorization:[REDACTED]+t`).
  if (value.startsWith(REDACTED)) return false;
  for (const { re } of SECRET_PATTERNS) if (new RegExp(re.source, re.flags.replace("g", "")).test(value)) return true;
  if (BARE_HEX.test(value)) return CREDENTIAL_KEY.test(key);
  return looksHighEntropySecret(value);
}

/** Long unbroken hex: a credential when the key says so, a digest otherwise. */
const BARE_HEX = /^[0-9a-f]{32,}$/i;

/** Key names that assert the value is a credential rather than a digest. */
const CREDENTIAL_KEY = /(api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|access[_-]?key|auth)/i;

/** Shapes that are random-looking by nature and carry no secret. */
const NOT_A_SECRET = [
  /[$}{()\[\]<>]/,                                     // expressions, template literals
  /process\.env|require\(|import\s/,                    // indirection, not a literal
  /:\/\//,                                             // URLs
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
];

function looksHighEntropySecret(value: string): boolean {
  if (value.length < 24) return false;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("~") || value.startsWith("#")) return false;
  if (/^[*x.\-_\u2022\u00b7]+$/.test(value)) return false;          // placeholders
  for (const re of NOT_A_SECRET) if (re.test(value)) return false;
  if (/^[\d.\-a-z]+$/.test(value) && /\d+\.\d+/.test(value)) return false; // versions
  const words = value.split(/[-_\s.]+/);
  if (words.length >= 3 && words.every((word) => /^[a-z]{2,12}$/.test(word))) return false; // prose
  const unique = new Set(value);
  if (unique.size / value.length < 0.4) return false;
  let entropy = 0;
  for (const char of unique) {
    const p = value.split(char).length - 1;
    entropy -= (p / value.length) * Math.log2(p / value.length);
  }
  const classes = Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/\d/.test(value));
  return entropy >= 3.6 && classes >= 2;
}

/** Scan already-read bytes. Archive construction reuses this so every source file
 *  is read only once while still applying the same fail-closed policy. */
export function scanBufferForSecrets(rel: string, buf: Buffer, literals: string[]): SecretHit[] {
  if (looksBinary(buf)) return [];
  return scanContentForSecrets(rel, buf.toString("utf8"), literals);
}

/** Scan a set of files on disk. Skips files that look binary (NUL byte in the head)
 *  to avoid garbage matches; secrets are text by nature. Fail-closed: caller must
 *  abort the upload if the returned array is non-empty. */
export function scanFilesForSecrets(files: UploadFile[], literals: string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const f of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(f.abs);
    } catch {
      continue;
    }
    hits.push(...scanBufferForSecrets(f.rel, buf, literals));
  }
  return hits;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
