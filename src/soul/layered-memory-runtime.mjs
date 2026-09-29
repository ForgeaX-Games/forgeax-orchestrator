/**
 * Layered-memory runtime SSOT.
 *
 * Plain ESM keeps the logic importable both by bundled TypeScript consumers and
 * by the standalone Node MCP assets copied verbatim into dist/.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function isMemorySlug(value) {
  return typeof value === 'string' && SLUG_RE.test(value);
}

export function soulMemoryRoot(projectRoot, agentId) {
  const safe = SLUG_RE.test(agentId) ? agentId : 'default';
  return resolve(projectRoot, '.forgeax/souls', safe, 'memory');
}

function listMd(dir) {
  try {
    return readdirSync(dir)
      .filter((file) => file.toLowerCase().endsWith('.md') && file.toLowerCase() !== 'memory.md')
      .sort();
  } catch {
    return [];
  }
}

async function listMdAsync(dir) {
  try {
    return (await readdir(dir))
      .filter((file) => file.toLowerCase().endsWith('.md') && file.toLowerCase() !== 'memory.md')
      .sort();
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function readBody(path) {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}

async function readBodyAsync(path) {
  try {
    return (await readFile(path, 'utf-8')).trim();
  } catch (error) {
    if (isMissingPathError(error)) return '';
    throw error;
  }
}

function isMissingPathError(error) {
  return error && typeof error === 'object'
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function readTier(root, tier, game) {
  const dir = tier === 'episodes' && game ? join(root, 'episodes', game) : join(root, tier);
  if (tier === 'episodes' && !game) return [];
  const sections = [];
  for (const file of listMd(dir)) {
    const body = readBody(join(dir, file));
    if (!body) continue;
    const relative = tier === 'episodes' && game ? `episodes/${game}/${file}` : `${tier}/${file}`;
    sections.push({
      file: relative,
      body,
      tier,
      ...(tier === 'episodes' && game ? { game } : {}),
    });
  }
  return sections;
}

async function readTierAsync(root, tier, game) {
  const dir = tier === 'episodes' && game ? join(root, 'episodes', game) : join(root, tier);
  if (tier === 'episodes' && !game) return [];
  const sections = [];
  for (const file of await listMdAsync(dir)) {
    const body = await readBodyAsync(join(dir, file));
    if (!body) continue;
    const relative = tier === 'episodes' && game ? `episodes/${game}/${file}` : `${tier}/${file}`;
    sections.push({ file: relative, body, tier, ...(tier === 'episodes' && game ? { game } : {}) });
  }
  return sections;
}

export async function readLayeredMemoryAsync(ref) {
  return {
    identity: await readTierAsync(ref.root, 'identity'),
    traits: await readTierAsync(ref.root, 'traits'),
    episodes: await readTierAsync(ref.root, 'episodes', ref.game),
  };
}

export function readLayeredMemory(ref) {
  return {
    identity: readTier(ref.root, 'identity'),
    traits: readTier(ref.root, 'traits'),
    episodes: readTier(ref.root, 'episodes', ref.game),
  };
}

export function readMemoryIndex(root) {
  const path = join(root, 'MEMORY.md');
  return existsSync(path) ? readBody(path) : '';
}

export async function readMemoryIndexAsync(root) {
  return readBodyAsync(join(root, 'MEMORY.md'));
}

export function composeStableMemory(ref) {
  const { identity, traits } = readLayeredMemory(ref);
  const index = readMemoryIndex(ref.root);
  const blocks = [];
  if (index) blocks.push(`## Memory Index (MEMORY.md)\n\n${index}`);
  for (const memory of [...identity, ...traits]) {
    blocks.push(`## ${memory.file}\n\n${memory.body}`);
  }
  const caveat =
    '> These memories are point-in-time observations, not live state. Before asserting a remembered fact ' +
    '(a file/function/flag, or repo state), verify it against the current code; trust what you observe now over a stale memory.';
  return blocks.length
    ? `# Long-term Memory (identity + traits)\n\n${caveat}\n\n${blocks.join('\n\n')}`
    : '';
}

/** Async counterpart for server/runtime callers. Keep rendering byte-for-byte
 * aligned with composeStableMemory; only filesystem access differs. */
export async function composeStableMemoryAsync(ref) {
  const { identity, traits } = await readLayeredMemoryAsync(ref);
  const index = await readMemoryIndexAsync(ref.root);
  const blocks = [];
  if (index) blocks.push(`## Memory Index (MEMORY.md)\n\n${index}`);
  for (const memory of [...identity, ...traits]) {
    blocks.push(`## ${memory.file}\n\n${memory.body}`);
  }
  const caveat =
    '> These memories are point-in-time observations, not live state. Before asserting a remembered fact ' +
    '(a file/function/flag, or repo state), verify it against the current code; trust what you observe now over a stale memory.';
  return blocks.length
    ? `# Long-term Memory (identity + traits)\n\n${caveat}\n\n${blocks.join('\n\n')}`
    : '';
}

export function composeEpisodicRecall(ref) {
  if (!ref.game) return '';
  const { episodes } = readLayeredMemory(ref);
  if (!episodes.length) return '';
  const blocks = episodes.map((memory) => `## ${memory.file}\n\n${memory.body}`).join('\n\n');
  return `# Episodic Memory · this world (${ref.game})\n\n${blocks}`;
}

/** Async counterpart for server/runtime callers. */
export async function composeEpisodicRecallAsync(ref) {
  if (!ref.game) return '';
  const { episodes } = await readLayeredMemoryAsync(ref);
  if (!episodes.length) return '';
  const blocks = episodes.map((memory) => `## ${memory.file}\n\n${memory.body}`).join('\n\n');
  return `# Episodic Memory · this world (${ref.game})\n\n${blocks}`;
}

function listEpisodeWorlds(root) {
  try {
    return readdirSync(join(root, 'episodes'))
      .filter((game) => SLUG_RE.test(game) && listMd(join(root, 'episodes', game)).length > 0)
      .sort();
  } catch {
    return [];
  }
}

async function listEpisodeWorldsAsync(root) {
  try {
    const worlds = [];
    for (const game of (await readdir(join(root, 'episodes'))).sort()) {
      if (SLUG_RE.test(game) && (await listMdAsync(join(root, 'episodes', game))).length > 0) worlds.push(game);
    }
    return worlds;
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

export function composeReincarnationNotice(ref) {
  if (!ref.game) return '';
  const worlds = listEpisodeWorlds(ref.root);
  if (worlds.includes(ref.game)) return '';
  const pastWorlds = worlds.filter((game) => game !== ref.game);
  if (pastWorlds.length === 0) return '';
  const list = pastWorlds.map((game) => `- \`${game}\``).join('\n');
  return [
    `# Reincarnation · entering a new world (\`${ref.game}\`)`,
    'You carry the **same identity and traits** across every world you live in — they are stated above and apply here unchanged.',
    `But \`${ref.game}\` is **new to you**: you hold no memories *of this world* yet. You have lived in other worlds before:`,
    list,
    `Those past lives are reachable via \`memory_search\`, but they are **context from other worlds — reference them, never assert them as facts about \`${ref.game}\`**. Begin forming fresh episodic memories for this world as you work.`,
  ].join('\n\n');
}

/** Async counterpart preserving the legacy world ordering and wording. */
export async function composeReincarnationNoticeAsync(ref) {
  if (!ref.game) return '';
  const worlds = await listEpisodeWorldsAsync(ref.root);
  if (worlds.includes(ref.game)) return '';
  const pastWorlds = worlds.filter((game) => game !== ref.game);
  if (pastWorlds.length === 0) return '';
  const list = pastWorlds.map((game) => `- \`${game}\``).join('\n');
  return [
    `# Reincarnation · entering a new world (\`${ref.game}\`)`,
    'You carry the **same identity and traits** across every world you live in — they are stated above and apply here unchanged.',
    `But \`${ref.game}\` is **new to you**: you hold no memories *of this world* yet. You have lived in other worlds before:`,
    list,
    `Those past lives are reachable via \`memory_search\`, but they are **context from other worlds — reference them, never assert them as facts about \`${ref.game}\`**. Begin forming fresh episodic memories for this world as you work.`,
  ].join('\n\n');
}

/** Legacy first-past-life fallback, made async for provider request paths. */
export async function firstPastLifeMemoryAsync(ref) {
  if (!ref.game) return undefined;
  const episodes = join(ref.root, 'episodes');
  try {
    for (const game of (await readdir(episodes)).sort()) {
      if (game === ref.game || !SLUG_RE.test(game)) continue;
      const dir = join(episodes, game);
      const file = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.md')).sort()[0];
      // The legacy fallback reads the raw file rather than readTier(), so its
      // bounded text can retain the file's final newline. Keep that byte detail.
      if (file) return { text: (await readFile(join(dir, file), 'utf8')).slice(0, 400) };
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return undefined;
}

export function searchMemory(ref, query, limit = 5) {
  const all = [...readTier(ref.root, 'identity'), ...readTier(ref.root, 'traits')];
  try {
    for (const game of readdirSync(join(ref.root, 'episodes'))) {
      if (SLUG_RE.test(game)) all.push(...readTier(ref.root, 'episodes', game));
    }
  } catch {
    // No episodes directory.
  }

  const normalized = query.toLowerCase().trim();
  const tokens = normalized.split(/\s+/).filter((token) => token.length >= 2);
  const scored = all
    .map((memory) => {
      const body = memory.body.toLowerCase();
      let score = body.includes(normalized) ? 5 : 0;
      for (const token of tokens) if (body.includes(token)) score += 1;
      return { memory, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return {
    query,
    matches: scored.map(({ memory }) => ({
      tier: memory.tier,
      ...(memory.game ? { game: memory.game } : {}),
      file: memory.file,
      text: memory.body.length > 400 ? `${memory.body.slice(0, 400)}…` : memory.body,
    })),
  };
}

/** Async counterpart used by server providers; matching and ordering mirror
 * searchMemory exactly while keeping filesystem work off the event loop. */
export async function searchMemoryAsync(ref, query, limit = 5) {
  const layers = await readLayeredMemoryAsync(ref);
  const all = [...layers.identity, ...layers.traits];
  try {
    // searchMemory historically preserves the filesystem's world enumeration
    // order (unlike the reincarnation notice, which sorts worlds). Mirror it
    // here so equal-score matches remain byte-for-byte compatible.
    for (const game of await readdir(join(ref.root, 'episodes'))) {
      if (SLUG_RE.test(game)) all.push(...await readTierAsync(ref.root, 'episodes', game));
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const normalized = query.toLowerCase().trim();
  const tokens = normalized.split(/\s+/).filter((token) => token.length >= 2);
  const scored = all
    .map((memory) => {
      const body = memory.body.toLowerCase();
      let score = body.includes(normalized) ? 5 : 0;
      for (const token of tokens) if (body.includes(token)) score += 1;
      return { memory, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  return {
    query,
    matches: scored.map(({ memory }) => ({
      tier: memory.tier,
      ...(memory.game ? { game: memory.game } : {}),
      file: memory.file,
      text: memory.body.length > 400 ? `${memory.body.slice(0, 400)}…` : memory.body,
    })),
  };
}

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'entry'
  );
}

function fsyncDirectory(dir) {
  if (process.platform === 'win32') {
    // Node has no portable directory fsync on Windows; durable callers still
    // fsync each file before atomic rename. macOS/Linux use strict dir fsync.
    return;
  }
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function fsyncDirectoryAsync(dir) {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function writeTextFile(path, content, { durable = false } = {}) {
  if (!durable) {
    writeFileSync(path, content);
    return;
  }
  const dir = dirname(path);
  // Keep the temp name intentionally narrow so recovery never removes a
  // user-owned file merely because its name contains our marker.
  const temp = join(dir, `.fx-memory-tmp-${randomUUID()}`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* crash recovery removes abandoned temps */ }
    throw error;
  }
}

async function writeTextFileAsync(path, content, { durable = false } = {}) {
  if (!durable) {
    await writeFile(path, content);
    return;
  }
  const dir = dirname(path);
  const temp = join(dir, `.fx-memory-tmp-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (result.bytesWritten <= 0) throw new Error('durable memory write made no progress');
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    await fsyncDirectoryAsync(dir);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function renderMemoryIndex(root) {
  const lines = [];
  const add = (sections) => {
    for (const memory of sections) {
      const first = memory.body.split(/\r?\n/).find((line) => line.trim()) ?? '';
      const summary = first.replace(/^#+\s*/, '').slice(0, 120);
      const tag = memory.game ? `${memory.tier}:${memory.game}` : memory.tier;
      lines.push(`- [${tag}] ${memory.file} — ${summary}`);
    }
  };
  add(readTier(root, 'identity'));
  add(readTier(root, 'traits'));
  try {
    for (const game of readdirSync(join(root, 'episodes')).sort()) {
      if (SLUG_RE.test(game)) add(readTier(root, 'episodes', game));
    }
  } catch {
    // No episodes directory.
  }
  return (
    '# MEMORY index\n\n' +
    '> Persistent index: one entry per line. Select a file and use Read to recall it (filesystem only; no RAG).\n\n' +
    `${lines.join('\n')}\n`
  );
}

export function rebuildMemoryIndex(root, options = {}) {
  const content = renderMemoryIndex(root);
  mkdirSync(root, { recursive: true });
  writeTextFile(join(root, 'MEMORY.md'), content, options);
  return content;
}

async function renderMemoryIndexAsync(root) {
  const lines = [];
  const add = (sections) => {
    for (const memory of sections) {
      const first = memory.body.split(/\r?\n/).find((line) => line.trim()) ?? '';
      const summary = first.replace(/^#+\s*/, '').slice(0, 120);
      const tag = memory.game ? `${memory.tier}:${memory.game}` : memory.tier;
      lines.push(`- [${tag}] ${memory.file} — ${summary}`);
    }
  };
  add(await readTierAsync(root, 'identity'));
  add(await readTierAsync(root, 'traits'));
  for (const game of await listEpisodeWorldsAsync(root)) add(await readTierAsync(root, 'episodes', game));
  return '# MEMORY index\n\n' +
    '> Persistent index: one entry per line. Select a file and use Read to recall it (filesystem only; no RAG).\n\n' +
    `${lines.join('\n')}\n`;
}

export async function rebuildMemoryIndexAsync(root, options = {}) {
  const content = await renderMemoryIndexAsync(root);
  await mkdir(root, { recursive: true });
  await writeTextFileAsync(join(root, 'MEMORY.md'), content, options);
  return content;
}

/**
 * Freeze the legacy filename and body algorithm before any transaction IO.
 * `reservedFiles` is used by a multi-fact transaction so later facts cannot
 * observe an unmaterialized earlier suffix as available.
 */
export function planMemoryEntry(ref, entry, reservedFiles = new Set()) {
  const tier = entry.tier;
  const game = tier === 'episodes' ? entry.game ?? ref.game : undefined;
  if (tier === 'episodes' && !game) {
    throw new Error('planMemoryEntry: episodes tier requires a game');
  }
  const base = slugify(entry.title ?? entry.text);
  let name = `${base}.md`;
  let suffix = 2;
  // `file` is a portable logical path persisted in receipts, not an OS path.
  // Keep its separator stable on Windows; callers split it before filesystem IO.
  const directory = tier === 'episodes' ? `episodes/${game}` : tier;
  let relative = `${directory}/${name}`;
  while (reservedFiles.has(relative) || existsSync(join(ref.root, relative))) {
    name = `${base}-${suffix++}.md`;
    relative = `${directory}/${name}`;
  }
  const heading = entry.title ? `# ${entry.title}\n\n` : '';
  return {
    tier,
    ...(game ? { game } : {}),
    file: relative,
    body: `${heading}${entry.text.trim()}\n`,
  };
}

export async function planMemoryEntryAsync(ref, entry, reservedFiles = new Set()) {
  const tier = entry.tier;
  const game = tier === 'episodes' ? entry.game ?? ref.game : undefined;
  if (tier === 'episodes' && !game) throw new Error('planMemoryEntry: episodes tier requires a game');
  const base = slugify(entry.title ?? entry.text);
  let name = `${base}.md`;
  let suffix = 2;
  const directory = tier === 'episodes' ? `episodes/${game}` : tier;
  let relative = `${directory}/${name}`;
  while (reservedFiles.has(relative) || await access(join(ref.root, relative)).then(
    () => true,
    (error) => {
      if (isMissingPathError(error)) return false;
      throw error;
    },
  )) {
    name = `${base}-${suffix++}.md`;
    relative = `${directory}/${name}`;
  }
  const heading = entry.title ? `# ${entry.title}\n\n` : '';
  return { tier, ...(game ? { game } : {}), file: relative, body: `${heading}${entry.text.trim()}\n` };
}

export async function planClassifiedMemoryFactsAsync(ref, facts) {
  const planned = [];
  const reserved = new Set();
  for (const fact of facts) {
    if (!fact.text.trim()) continue;
    const toTraits = fact.kind === 'general' || (fact.kind !== 'game' && !ref.game);
    const tier = toTraits ? 'traits' : 'episodes';
    const game = tier === 'episodes' ? ref.game : undefined;
    if (tier === 'episodes' && !game) continue;
    const plan = await planMemoryEntryAsync(ref, { tier, game, title: fact.title, text: fact.text }, reserved);
    reserved.add(plan.file);
    planned.push(plan);
  }
  return planned;
}

/** Materialize a plan without recomputing its filename or body. */
export function materializePlannedMemoryEntry(ref, plan, options = {}) {
  const target = plannedMemoryTarget(ref, plan);
  mkdirSync(dirname(target), { recursive: true });
  writeTextFile(target, plan.body, options);
}

export async function materializePlannedMemoryEntryAsync(ref, plan, options = {}) {
  const target = plannedMemoryTarget(ref, plan);
  await mkdir(dirname(target), { recursive: true });
  await writeTextFileAsync(target, plan.body, options);
}

function plannedMemoryTarget(ref, plan) {
  if (!plan || typeof plan.file !== 'string' || plan.file.length === 0
    || isAbsolute(plan.file) || plan.file.includes('\\') || /[\u0000-\u001f\u007f]/u.test(plan.file)) {
    throw new TypeError('planned memory file must be a safe portable relative path');
  }
  const parts = plan.file.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError('planned memory file must not contain traversal segments');
  }
  const root = resolve(ref.root);
  const target = resolve(root, ...parts);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError('planned memory file escapes its memory root');
  }
  return target;
}

export function writeMemoryEntry(ref, entry) {
  if (entry.tier === 'episodes' && !(entry.game ?? ref.game)) {
    throw new Error('writeMemoryEntry: episodes tier requires a game');
  }
  const plan = planMemoryEntry(ref, entry);
  materializePlannedMemoryEntry(ref, plan);
  rebuildMemoryIndex(ref.root);
  return plan.file;
}

/** Apply the legacy classification rules, but only produce frozen plans. */
export function planClassifiedMemoryFacts(ref, facts) {
  const planned = [];
  const reserved = new Set();
  for (const fact of facts) {
    if (!fact.text.trim()) continue;
    const toTraits = fact.kind === 'general' || (fact.kind !== 'game' && !ref.game);
    const tier = toTraits ? 'traits' : 'episodes';
    const game = tier === 'episodes' ? ref.game : undefined;
    if (tier === 'episodes' && !game) continue;
    const plan = planMemoryEntry(ref, { tier, game, title: fact.title, text: fact.text }, reserved);
    reserved.add(plan.file);
    planned.push(plan);
  }
  return planned;
}

export function classifyAndWrite(ref, facts) {
  const written = [];
  for (const fact of facts) {
    if (!fact.text.trim()) continue;
    const toTraits = fact.kind === 'general' || (fact.kind !== 'game' && !ref.game);
    const tier = toTraits ? 'traits' : 'episodes';
    const game = tier === 'episodes' ? ref.game : undefined;
    if (tier === 'episodes' && !game) continue;
    const file = writeMemoryEntry(ref, {
      tier,
      game,
      title: fact.title,
      text: fact.text,
    });
    written.push({ tier, ...(game ? { game } : {}), file });
  }
  return written;
}
