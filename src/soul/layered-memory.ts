/**
 * Typed facade for the plain-Node layered-memory runtime SSOT.
 *
 * The implementation is `.mjs` so copied MCP server assets and bundled
 * TypeScript consumers execute the exact same search, classification, write,
 * and index logic.
 */
export {
  soulMemoryRoot,
  readLayeredMemory,
  readMemoryIndex,
  composeStableMemory,
  composeEpisodicRecall,
  composeReincarnationNotice,
  searchMemory,
  writeMemoryEntry,
  classifyAndWrite,
} from './layered-memory-runtime.mjs';
