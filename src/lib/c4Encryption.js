// src/lib/c4Encryption.js — HR-01 / HR-10 (Roadmap T-P4.2)
//
// Transparent, at-the-persistence-boundary encryption for C4 columns, wired
// into the Prisma singleton as a client extension ($extends). Callers keep
// using prisma normally: they write plaintext numbers/strings and read
// plaintext numbers/strings back. Encryption-on-write and decryption-on-read
// happen here so NO service/controller call site has to change.
//
// Why an extension (not per-call-site helpers): payrollService does arithmetic
// on `baseSalary` (e.g. baseSalary / 2) and analyticsService pushes
// `record.baseSalary` into number arrays. Both require a real Number on read.
// A result-component decrypt restores that contract everywhere at once, and a
// query-component encrypt covers every write path (create/update/upsert/
// createMany) without rewriting them.
//
// Two field kinds:
//   * string  → encrypt/decrypt via crypto.encryptString/decryptString.
//   * number  → encrypt via encryptNumber (stringified envelope stored in what
//               is now a String column at rest), decrypt via decryptNumber so
//               the read is a Number.
//
// Blind-index wrinkle (BankDetail): the unique constraint and lookups were on
// the plaintext accountNumber. GCM's random IV makes the stored ciphertext
// differ per write, so equality/uniqueness on the encrypted column is
// impossible. We add a deterministic `accountNumberBidx` column (HMAC of the
// plaintext) — uniqueness moved to (employeeId, accountNumberBidx) in the
// schema — and this extension (a) fills it on write and (b) rewrites any
// `where` filter on accountNumber to the blind index so lookup-by-account
// still works.
import {
    encryptString,
    decryptString,
    encryptNumber,
    decryptNumber,
    blindIndex,
} from './crypto.js';

// model name (as used on the Prisma client, lowercased first letter) →
// { field: 'string' | 'number' }.  These are the verified C4 columns:
//   EmploymentTerms.baseSalary / bonusTarget — salary/comp
//   BankDetail.accountNumber / routingNumber — bank
//   Employee.nationality_id_no               — national id
//   Offer.salary                             — recruiting comp (the schema has
//      no CompensationPackage model; Offer.salary is the salary field that sits
//      where the conductor's ~L1573 pointer lands).
export const C4_FIELDS = {
    employmentTerms: { baseSalary: 'number', bonusTarget: 'number', equity: 'string' },
    // iban embeds the account number → encrypt at rest like accountNumber. No
    // blind index (we never look up / uniquely constrain by iban).
    bankDetail: { accountNumber: 'string', routingNumber: 'string', iban: 'string' },
    // ntn is a Pakistan tax registration id → encrypt like nationality_id_no.
    employee: { nationality_id_no: 'string', ntn: 'string' },
    offer: { salary: 'number' },
};

// Flat union of every C4 field name → kind, used to decrypt nested relation
// results (e.g. employee.employmentTerms[].baseSalary inside an include). A
// client-extension query hook fires once for the TOP-LEVEL model only, so the
// result decryptor cannot rely on the per-model map for nested objects — it
// walks the whole returned tree and decrypts any field whose NAME is a known
// C4 field. Field names are globally unambiguous across the C4 surface, so a
// name-based decode is safe (and mirrors how c4Redaction keys off names).
const C4_FIELD_KINDS = Object.values(C4_FIELDS).reduce(
    (acc, map) => Object.assign(acc, map),
    {},
);

// Models that carry a deterministic blind-index column for a (now-encrypted)
// lookup/unique field: model → { plaintextField: blindIndexColumn }.
export const C4_BLIND_INDEXES = {
    bankDetail: { accountNumber: 'accountNumberBidx' },
};

const encryptField = (kind, value) =>
    kind === 'number' ? encryptNumber(value) : encryptString(value);

const decryptField = (kind, value) =>
    kind === 'number' ? decryptNumber(value) : decryptString(value);

// Encrypt the C4 fields present in a write payload (and fill blind indexes).
// Handles both single-object `data` and array `data` (createMany).
const encryptWriteData = (modelKey, data) => {
    if (data === null || data === undefined) return data;
    if (Array.isArray(data)) return data.map((row) => encryptWriteData(modelKey, row));

    const fields = C4_FIELDS[modelKey];
    const bidx = C4_BLIND_INDEXES[modelKey];
    if (!fields && !bidx) return data;

    const out = { ...data };

    if (fields) {
        for (const [field, kind] of Object.entries(fields)) {
            if (Object.prototype.hasOwnProperty.call(out, field) && out[field] !== null && out[field] !== undefined) {
                // Prisma update can wrap a scalar in { set: value }; respect it.
                if (typeof out[field] === 'object' && Object.prototype.hasOwnProperty.call(out[field], 'set')) {
                    out[field] = { set: encryptField(kind, out[field].set) };
                } else {
                    out[field] = encryptField(kind, out[field]);
                }
            }
        }
    }

    if (bidx) {
        for (const [plainField, indexColumn] of Object.entries(bidx)) {
            if (Object.prototype.hasOwnProperty.call(data, plainField) && data[plainField] !== null && data[plainField] !== undefined) {
                // Use the ORIGINAL plaintext from `data` (not the now-encrypted
                // `out`) to compute the deterministic index.
                const plain =
                    typeof data[plainField] === 'object' && data[plainField] !== null && 'set' in data[plainField]
                        ? data[plainField].set
                        : data[plainField];
                out[indexColumn] = blindIndex(plain);
            }
        }
    }

    return out;
};

// Rewrite a `where` filter so equality on a blind-indexed plaintext field is
// translated to the blind-index column. Supports the common shapes:
//   { accountNumber: 'x' }            → { accountNumberBidx: hmac('x') }
//   { accountNumber: { equals: 'x' } }→ { accountNumberBidx: hmac('x') }
//   { employeeId_accountNumber: {..} }→ rewrite the compound unique selector
const rewriteWhereForBlindIndex = (modelKey, where) => {
    const bidx = C4_BLIND_INDEXES[modelKey];
    if (!bidx || !where || typeof where !== 'object') return where;

    let out = where;
    const ensureCloned = () => {
        if (out === where) out = { ...where };
        return out;
    };

    for (const [plainField, indexColumn] of Object.entries(bidx)) {
        // 1) Direct equality on the plaintext field.
        if (Object.prototype.hasOwnProperty.call(where, plainField)) {
            const cond = where[plainField];
            let plain;
            if (cond !== null && typeof cond === 'object') {
                if ('equals' in cond) plain = cond.equals;
            } else {
                plain = cond;
            }
            if (plain !== undefined && plain !== null) {
                ensureCloned();
                delete out[plainField];
                out[indexColumn] = blindIndex(plain);
            }
        }

        // 2) Prisma compound-unique selector, e.g. employeeId_accountNumber.
        for (const key of Object.keys(where)) {
            if (key.endsWith(`_${plainField}`) && where[key] && typeof where[key] === 'object') {
                const compound = where[key];
                if (Object.prototype.hasOwnProperty.call(compound, plainField) && compound[plainField] != null) {
                    const newKey = key.slice(0, -plainField.length) + indexColumn;
                    const rewritten = { ...compound };
                    rewritten[indexColumn] = blindIndex(compound[plainField]);
                    delete rewritten[plainField];
                    ensureCloned();
                    delete out[key];
                    out[newKey] = rewritten;
                }
            }
        }
    }

    return out;
};

// Decrypt every C4 field anywhere in a result tree. Walks objects and arrays,
// decrypting any property whose NAME is a known C4 field (so nested relation
// results from `include`/`select` are covered, not just the top-level model).
// Non-plain objects (Date, Buffer, Decimal) are left intact. Pure: operates on
// shallow copies per node.
const decryptResultNode = (node) => {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map((n) => decryptResultNode(n));
    if (typeof node !== 'object') return node;

    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return node; // Date/Buffer/etc.

    const out = {};
    for (const [key, val] of Object.entries(node)) {
        const kind = C4_FIELD_KINDS[key];
        if (kind && val !== null && val !== undefined && typeof val !== 'object') {
            out[key] = decryptField(kind, val);
        } else {
            out[key] = decryptResultNode(val);
        }
    }
    return out;
};

const WRITE_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert']);
const READ_WHERE_OPS = new Set([
    'findFirst',
    'findFirstOrThrow',
    'findUnique',
    'findUniqueOrThrow',
    'findMany',
    'count',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
]);

/**
 * Build the $extends spec for the C4 encryption layer. Exported so the prisma
 * singleton can apply it and tests can inspect the field map.
 */
export const c4EncryptionExtension = {
    name: 'hr-c4-encryption',
    query: {
        $allModels: {
            async $allOperations({ model, operation, args, query }) {
                const modelKey = model.charAt(0).toLowerCase() + model.slice(1);
                const isC4Model = Boolean(C4_FIELDS[modelKey] || C4_BLIND_INDEXES[modelKey]);

                let nextArgs = args;

                if (isC4Model) {
                    // Encrypt write payloads + fill blind indexes.
                    if (WRITE_OPS.has(operation) && nextArgs && nextArgs.data) {
                        nextArgs = { ...nextArgs, data: encryptWriteData(modelKey, nextArgs.data) };
                    }
                    // upsert carries both create and update payloads.
                    if (operation === 'upsert' && nextArgs) {
                        nextArgs = {
                            ...nextArgs,
                            ...(nextArgs.create ? { create: encryptWriteData(modelKey, nextArgs.create) } : {}),
                            ...(nextArgs.update ? { update: encryptWriteData(modelKey, nextArgs.update) } : {}),
                        };
                    }
                    // Rewrite blind-indexed equality filters to the index column.
                    if (READ_WHERE_OPS.has(operation) && nextArgs && nextArgs.where) {
                        nextArgs = { ...nextArgs, where: rewriteWhereForBlindIndex(modelKey, nextArgs.where) };
                    }
                }

                const result = await query(nextArgs);
                // Decrypt every C4 field anywhere in the result tree — covers
                // both this model's columns and any nested relation results
                // surfaced via include/select (e.g. employee.nationality_id_no).
                return decryptResultNode(result);
            },
        },
    },
};

export default c4EncryptionExtension;
