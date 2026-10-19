// src/services/engagement/party.service.js — counterparties (visitor, lead,
// client, author, publishing user, partner) and their identity links.
//
// A party is the engine's anchor: every event, fact, profile, document and
// project link hangs off one. Identity links (system + externalId) connect it
// to the Sales lead/customer, the Communication thread party, a mailbox, a
// phone number, etc. so events arriving from any channel resolve to one party.
import { z } from "zod";

import {
  IDENTITY_SYSTEMS, PARTY_KINDS, PARTY_ROLES, PARTY_STAGES,
  asArray, fail, normalizeEmail, normalizePhone, uniq,
} from "./base.js";

export const IdentitySchema = z.object({
  system: z.enum(IDENTITY_SYSTEMS),
  externalId: z.string().trim().min(1).max(300),
}).strict();

export const PartyInputSchema = z.object({
  kind: z.enum(PARTY_KINDS).default("PERSON"),
  role: z.enum(PARTY_ROLES).default("LEAD"),
  stage: z.enum(PARTY_STAGES).default("NEW"),
  displayName: z.string().trim().min(1).max(200),
  organization: z.string().trim().max(200).nullable().optional(),
  emails: z.array(z.string().trim().min(3).max(320)).max(20).default([]),
  phones: z.array(z.string().trim().min(3).max(32)).max(20).default([]),
  identities: z.array(IdentitySchema).max(50).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  timezone: z.string().trim().max(64).nullable().optional(),
  locale: z.string().trim().max(16).nullable().optional(),
  ownerUserId: z.string().trim().max(100).nullable().optional(),
});

export const PartyPatchSchema = PartyInputSchema.partial().extend({
  expectedVersion: z.number().int().positive().optional(),
  reason: z.string().trim().max(500).optional(),
});

const normalizeContacts = (input) => ({
  emails: uniq(asArray(input.emails).map(normalizeEmail)),
  phones: uniq(asArray(input.phones).map(normalizePhone)),
  identities: uniqIdentities(asArray(input.identities)),
});

const uniqIdentities = (identities) => {
  const seen = new Set();
  return identities.filter((identity) => {
    const key = `${identity.system}:${identity.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const toPartyView = (row, extra = {}) =>
  row && {
    id: row.id,
    kind: row.kind,
    role: row.role,
    stage: row.stage,
    displayName: row.displayName,
    organization: row.organization ?? null,
    emails: row.emails ?? [],
    phones: row.phones ?? [],
    identities: row.identities ?? [],
    tags: row.tags ?? [],
    timezone: row.timezone ?? null,
    locale: row.locale ?? null,
    ownerUserId: row.ownerUserId ?? null,
    mergedIntoId: row.mergedIntoId ?? null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...extra,
  };

export async function createParty(tx, env, rawInput) {
  const input = PartyInputSchema.parse(rawInput);
  const contacts = normalizeContacts(input);
  return tx.engagementParty.create({
    data: {
      tenantId: env.tenantId,
      kind: input.kind,
      role: input.role,
      stage: input.stage,
      displayName: input.displayName,
      organization: input.organization ?? null,
      ...contacts,
      tags: uniq(input.tags),
      timezone: input.timezone ?? null,
      locale: input.locale ?? null,
      ownerUserId: input.ownerUserId ?? null,
    },
  });
}

export async function getPartyOrFail(tx, env, partyId) {
  const row = await tx.engagementParty.findFirst({ where: { tenantId: env.tenantId, id: partyId } });
  if (!row) fail("HR-4701", "Party not found", 404);
  return row;
}

/**
 * Find the party that owns any of the given contact points or identities.
 * Priority: explicit identity link → email → phone. Merged parties resolve to
 * their survivor.
 */
export async function findPartyByContact(tx, env, { identities = [], emails = [], phones = [] }) {
  const tenantId = env.tenantId;
  const or = [];
  for (const identity of uniqIdentities(identities)) {
    or.push({ identities: { array_contains: [{ system: identity.system, externalId: identity.externalId }] } });
  }
  for (const email of uniq(emails.map(normalizeEmail))) or.push({ emails: { array_contains: [email] } });
  for (const phone of uniq(phones.map(normalizePhone))) or.push({ phones: { array_contains: [phone] } });
  if (!or.length) return null;
  const row = await tx.engagementParty.findFirst({
    where: { tenantId, OR: or },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) return null;
  if (row.mergedIntoId) return getPartyOrFail(tx, env, row.mergedIntoId);
  return row;
}

/**
 * Resolve-or-create: used by ingestion so that an email from an unknown
 * address becomes a VISITOR party instead of being dropped.
 */
export async function resolveParty(tx, env, { partyId, identities, emails, phones, displayName, role, organization, createIfMissing = true }) {
  if (partyId) return getPartyOrFail(tx, env, partyId);
  const found = await findPartyByContact(tx, env, { identities: identities ?? [], emails: emails ?? [], phones: phones ?? [] });
  if (found) return found;
  if (!createIfMissing) fail("HR-4701", "No party matches the supplied contact points", 404);
  const name = displayName || emails?.[0] || phones?.[0] || "Unknown counterparty";
  return createParty(tx, env, {
    displayName: name,
    role: role || "VISITOR",
    organization: organization ?? null,
    emails: emails ?? [],
    phones: phones ?? [],
    identities: identities ?? [],
  });
}

export async function updateParty(tx, env, partyId, rawPatch) {
  const patch = PartyPatchSchema.parse(rawPatch);
  const current = await getPartyOrFail(tx, env, partyId);
  if (patch.expectedVersion != null && patch.expectedVersion !== current.version) {
    fail("HR-4707", "Party was modified by another writer", 412, { currentVersion: current.version });
  }
  const data = { version: { increment: 1 } };
  for (const key of ["kind", "role", "stage", "displayName", "organization", "timezone", "locale", "ownerUserId"]) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }
  if (patch.tags) data.tags = uniq(patch.tags);
  if (patch.emails || patch.phones || patch.identities) {
    const merged = normalizeContacts({
      emails: patch.emails ?? current.emails,
      phones: patch.phones ?? current.phones,
      identities: patch.identities ?? current.identities,
    });
    Object.assign(data, merged);
  }
  const result = await tx.engagementParty.updateMany({
    where: { tenantId: env.tenantId, id: partyId, version: current.version },
    data,
  });
  if (!result?.count) fail("HR-4707", "Party was modified by another writer", 412, { currentVersion: current.version + 1 });
  return getPartyOrFail(tx, env, partyId);
}

/** Add identity links (idempotent) — e.g. link the Sales lead id after conversion. */
export async function linkIdentity(tx, env, partyId, rawIdentity) {
  const identity = IdentitySchema.parse(rawIdentity);
  const current = await getPartyOrFail(tx, env, partyId);
  const identities = uniqIdentities([...(current.identities ?? []), identity]);
  if (identities.length === (current.identities ?? []).length) return current;
  await tx.engagementParty.update({ where: { id: current.id }, data: { identities, version: { increment: 1 } } });
  return getPartyOrFail(tx, env, partyId);
}

/** Merge duplicate parties: everything moves to the survivor; the source is tombstoned. */
export async function mergeParties(tx, env, { sourcePartyId, targetPartyId }) {
  if (sourcePartyId === targetPartyId) fail("HR-4700", "Cannot merge a party into itself", 400);
  const source = await getPartyOrFail(tx, env, sourcePartyId);
  const target = await getPartyOrFail(tx, env, targetPartyId);
  if (source.mergedIntoId || target.mergedIntoId) fail("HR-4710", "Merged parties cannot be merged again", 409);
  const tenantId = env.tenantId;
  const where = { tenantId, partyId: source.id };
  const moved = {};
  for (const model of ["engagementEvent", "engagementFact", "engagementDocument", "engagementProjectLink", "engagementLlmRun"]) {
    const result = await tx[model].updateMany({ where, data: { partyId: target.id } });
    moved[model] = result?.count ?? 0;
  }
  // The source profile is dropped; the survivor is marked for refresh so the
  // merged record is re-read into one profile.
  await tx.engagementProfile.deleteMany({ where });
  await tx.engagementProfile.upsert({
    where: { tenantId_partyId: { tenantId, partyId: target.id } },
    create: { tenantId, partyId: target.id, refreshStatus: "QUEUED" },
    update: { refreshStatus: "QUEUED" },
  });
  const contacts = normalizeContacts({
    emails: [...(target.emails ?? []), ...(source.emails ?? [])],
    phones: [...(target.phones ?? []), ...(source.phones ?? [])],
    identities: [...(target.identities ?? []), ...(source.identities ?? [])],
  });
  await tx.engagementParty.update({
    where: { id: target.id },
    data: { ...contacts, tags: uniq([...(target.tags ?? []), ...(source.tags ?? [])]), version: { increment: 1 } },
  });
  await tx.engagementParty.update({
    where: { id: source.id },
    data: { stage: "MERGED", mergedIntoId: target.id, version: { increment: 1 } },
  });
  return { targetPartyId: target.id, sourcePartyId: source.id, moved };
}

const encodeCursor = (row) => Buffer.from(JSON.stringify({ u: row.updatedAt, i: row.id })).toString("base64url");
const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!parsed?.u || !parsed?.i) return null;
    return { updatedAt: new Date(parsed.u), id: parsed.i };
  } catch {
    return null;
  }
};

export async function listParties(tx, env, { q, role, stage, ownerUserId, includeMerged = false, cursor, limit = 25 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const where = { tenantId: env.tenantId };
  if (role) where.role = role;
  if (stage) where.stage = stage;
  else if (!includeMerged) where.stage = { not: "MERGED" };
  if (ownerUserId) where.ownerUserId = ownerUserId;
  if (q) {
    const needle = String(q).trim();
    where.OR = [
      { displayName: { contains: needle, mode: "insensitive" } },
      { organization: { contains: needle, mode: "insensitive" } },
      { emails: { array_contains: [normalizeEmail(needle)] } },
      { phones: { array_contains: [normalizePhone(needle)] } },
    ];
  }
  const after = decodeCursor(cursor);
  if (after) {
    where.AND = [{ OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { lt: after.id } }] }];
  }
  const rows = await tx.engagementParty.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: take + 1,
  });
  const page = rows.slice(0, take);
  const profiles = page.length
    ? await tx.engagementProfile.findMany({ where: { tenantId: env.tenantId, partyId: { in: page.map((r) => r.id) } } })
    : [];
  const byParty = new Map(profiles.map((p) => [p.partyId, p]));
  return {
    items: page.map((row) => {
      const profile = byParty.get(row.id);
      return toPartyView(row, {
        profileVersion: profile?.version ?? 0,
        lastEventAt: profile?.lastEventAt ?? null,
        lastRefreshedAt: profile?.lastRefreshedAt ?? null,
        refreshStatus: profile?.refreshStatus ?? "IDLE",
        sentiment: profile?.structured?.relationship?.sentiment ?? "UNKNOWN",
        summary: profile?.summary ?? "",
      });
    }),
    nextCursor: rows.length > take ? encodeCursor(page[page.length - 1]) : null,
  };
}
