/**
 * Layered-memory runtime SSOT.
 *
 * Plain ESM keeps the logic importable both by bundled TypeScript consumers and
 * by the standalone Node MCP assets copied verbatim into dist/.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

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

function readBody(path) {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
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

export function composeEpisodicRecall(ref) {
  if (!ref.game) return '';
  const { episodes } = readLayeredMemory(ref);
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

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'entry'
  );
}

function rebuildIndex(root) {
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
  const content =
    '# MEMORY index\n\n' +
    '> Persistent index: one entry per line. Select a file and use Read to recall it (filesystem only; no RAG).\n\n' +
    `${lines.join('\n')}\n`;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'MEMORY.md'), content);
}

export function writeMemoryEntry(ref, entry) {
  const tier = entry.tier;
  const game = tier === 'episodes' ? entry.game ?? ref.game : undefined;
  if (tier === 'episodes' && !game) {
    throw new Error('writeMemoryEntry: episodes tier requires a game');
  }
  const dir = tier === 'episodes' ? join(ref.root, 'episodes', game) : join(ref.root, tier);
  mkdirSync(dir, { recursive: true });

  const base = slugify(entry.title ?? entry.text);
  let name = `${base}.md`;
  let suffix = 2;
  while (existsSync(join(dir, name))) name = `${base}-${suffix++}.md`;

  const heading = entry.title ? `# ${entry.title}\n\n` : '';
  writeFileSync(join(dir, name), `${heading}${entry.text.trim()}\n`);
  const relative = tier === 'episodes' ? `episodes/${game}/${name}` : `${tier}/${name}`;
  rebuildIndex(ref.root);
  return relative;
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
