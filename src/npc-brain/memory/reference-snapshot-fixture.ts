/**
 * A deliberately small, neutral fixture for the reference snapshot reader.
 *
 * This is an external-source seam fixture, not an ASIW snapshot and not an
 * ASIW parity claim.  The reader validates the generic state envelope first,
 * then its own builder selects the requested owner from the state.
 */
import type { ReferenceSnapshotFixtureV1 } from '@forgeax/types/npc-memory';

export const REFERENCE_FIXTURE_ID = 'reference-npc-memory-v1';
export const REFERENCE_FIXTURE_CLOCK_DOMAIN = 'reference-clock-v1';
export const REFERENCE_FIXTURE_OWNER = Object.freeze({
  ownerNpcId: 'reference-npc-alice',
  soulId: 'reference-soul-alice',
});

/**
 * Entries are intentionally opaque at the shared ABI boundary.  The
 * reference provider owns this tiny fixture-only shape; it must not be
 * mistaken for the portable ASIW MemoryEntry schema.
 */
export interface ReferenceFixtureEntryV1 {
  readonly id: string;
  readonly ownerNpcId: string;
  readonly soulId: string;
  readonly kind: 'trait' | 'episode';
  readonly text: string;
  readonly partnerEntityId?: string;
  readonly observedAt?: number;
}

function freezeFixture<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((child) => freezeFixture(child, seen));
  else Object.values(value as Record<string, unknown>).forEach((child) => freezeFixture(child, seen));
  return Object.freeze(value);
}

export const REFERENCE_FIXTURE: ReferenceSnapshotFixtureV1 = freezeFixture({
  contractVersion: 'npc-memory-reference-fixture/v1',
  fixtureId: REFERENCE_FIXTURE_ID,
  scope: {
    authority: 'reference-fixture',
    fixtureId: REFERENCE_FIXTURE_ID,
    clockDomainId: REFERENCE_FIXTURE_CLOCK_DOMAIN,
  },
  subject: REFERENCE_FIXTURE_OWNER,
  generatedAtWallMs: 1_800_000_000_000,
  state: {
    idCounter: 4,
    entries: [
      {
        id: 'reference-entry-alice-trait',
        ownerNpcId: REFERENCE_FIXTURE_OWNER.ownerNpcId,
        soulId: REFERENCE_FIXTURE_OWNER.soulId,
        kind: 'trait',
        text: 'Alice keeps a careful ledger of promises.',
        observedAt: 10,
      },
      {
        id: 'reference-entry-alice-episode',
        ownerNpcId: REFERENCE_FIXTURE_OWNER.ownerNpcId,
        soulId: REFERENCE_FIXTURE_OWNER.soulId,
        kind: 'episode',
        text: 'Alice repaired the west gate after the morning storm.',
        observedAt: 20,
      },
      {
        id: 'reference-entry-alice-partner',
        ownerNpcId: REFERENCE_FIXTURE_OWNER.ownerNpcId,
        soulId: REFERENCE_FIXTURE_OWNER.soulId,
        kind: 'episode',
        text: 'Alice remembers meeting the visiting player at the west gate.',
        partnerEntityId: 'reference-player-1',
        observedAt: 30,
      },
      {
        id: 'reference-entry-bob-must-not-leak',
        ownerNpcId: 'reference-npc-bob',
        soulId: 'reference-soul-bob',
        kind: 'trait',
        text: 'Bob owns a fact that Alice must never receive.',
        observedAt: 40,
      },
    ],
    instantWindows: [],
    entityTable: [],
    perceptionIntakeCursors: [],
    placeGraph: [],
    placeBeliefs: [],
  },
  cases: [
    {
      caseId: 'reference-case-active',
      trigger: 'active_decision',
      at: { day: 1, hour: 9, minute: 0 },
      expectedRawBlocksHash: '73dc1207217fff9c7680b8fc7e1989bee5f95d30c8352a9ff93fc2f6e91dc034',
    },
    {
      caseId: 'reference-case-dialogue',
      trigger: 'dialogue_turn',
      at: { day: 1, hour: 9, minute: 1 },
      partnerEntityId: 'reference-player-1',
      expectedRawBlocksHash: '663404c573c19c155b44681c8afae1d649975ef79971c5c9a03ab2cc0382e852',
    },
  ],
  integrity: {
    algorithm: 'sha256',
    contentHash: '4c76d52ceeafd0758ffad8acfd3ff42bb967b2be16a383c3ed3b02e3dc17fab7',
  },
});

export const REFERENCE_FIXTURE_STORE: ReadonlyMap<string, ReferenceSnapshotFixtureV1> = new Map([
  [REFERENCE_FIXTURE.fixtureId, REFERENCE_FIXTURE],
]);
