import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const CAPABILITY_MANIFEST_FILE = "capability.json";
export const CAPABILITY_CONTRACT_VERSION = 1 as const;
export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const capabilityEffectSchema = z.enum(["read-only", "workspace-write", "external-state"]);
export type CapabilityEffect = z.infer<typeof capabilityEffectSchema>;

const identifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/, "must be a lowercase namespaced identifier");

const operationNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9._-]*$/, "must be a lowercase operation name");

const nonEmptyString = z.string().trim().min(1);

export const capabilityOperationSchema = z
  .object({
    description: nonEmptyString.max(500),
    effect: capabilityEffectSchema,
    evidence: z
      .array(nonEmptyString.max(80))
      .max(16)
      .refine((kinds) => new Set(kinds).size === kinds.length, "must not contain duplicate evidence kinds")
      .default([]),
    requiresFreshObservationAfter: z.boolean().default(false),
  })
  .strict();

export type CapabilityOperation = z.infer<typeof capabilityOperationSchema>;

const capabilityMatcherSchema = z
  .object({
    files: z.array(nonEmptyString.max(500)).max(128).default([]),
    commands: z.array(nonEmptyString.max(500)).max(64).default([]),
  })
  .strict();

const compatibilitySchema = z
  .object({
    platforms: z.array(z.enum(["win32", "darwin", "linux"])).max(3).optional(),
    providerVersion: nonEmptyString.max(120).optional(),
  })
  .strict();

export const capabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_CONTRACT_VERSION),
    id: identifierSchema,
    kind: z.enum(["capability-provider", "environment-provider"]),
    version: nonEmptyString.max(64),
    scope: z.enum(["workspace", "user"]),
    description: nonEmptyString.max(1_000),
    compatibility: compatibilitySchema.default({}),
    match: capabilityMatcherSchema.default({ files: [], commands: [] }),
    operations: z.record(operationNameSchema, capabilityOperationSchema).refine(
      (operations) => Object.keys(operations).length > 0,
      "must declare at least one operation",
    ),
    provides: z.record(identifierSchema, operationNameSchema).refine(
      (provides) => Object.keys(provides).length > 0,
      "must provide at least one capability",
    ),
    healthcheck: z
      .object({
        operation: operationNameSchema,
        timeoutMs: z.number().int().min(100).max(600_000).default(15_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const operationNames = new Set(Object.keys(manifest.operations));
    for (const [capability, operation] of Object.entries(manifest.provides)) {
      if (!operationNames.has(operation)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["provides", capability],
          message: `references unknown operation '${operation}'`,
        });
      }
    }
    if (!operationNames.has(manifest.healthcheck.operation)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["healthcheck", "operation"],
        message: `references unknown operation '${manifest.healthcheck.operation}'`,
      });
    } else if (manifest.operations[manifest.healthcheck.operation].effect !== "read-only") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["healthcheck", "operation"],
        message: "must reference a read-only operation",
      });
    }
  });

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export type CapabilityScope = CapabilityManifest["scope"];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");

export const capabilityMutationSchema = z
  .object({
    path: nonEmptyString.max(32_768),
    beforeHash: sha256Schema.nullable().optional(),
    /** SHA-256 of the file after the operation, or null when it was deleted. */
    afterHash: sha256Schema.nullable(),
  })
  .strict();

export const capabilityEvidenceSchema = z
  .object({
    kind: nonEmptyString.max(80),
    uri: nonEmptyString.max(32_768).optional(),
    sha256: sha256Schema.optional(),
    observedAt: z.string().datetime({ offset: true }),
    stateVersion: nonEmptyString.max(500).optional(),
  })
  .strict();

export const capabilityReceiptSchema = z
  .object({
    contractVersion: z.literal(CAPABILITY_CONTRACT_VERSION),
    ok: z.boolean(),
    providerId: identifierSchema,
    providerHash: sha256Schema,
    operation: operationNameSchema,
    targetRoot: nonEmptyString.max(32_768),
    stateVersion: nonEmptyString.max(500).optional(),
    result: z.unknown().optional(),
    mutations: z.array(capabilityMutationSchema).max(512).default([]),
    evidence: z.array(capabilityEvidenceSchema).max(256).default([]),
    diagnostics: z.array(z.string().max(20_000)).max(256).default([]),
    jobRefs: z.array(nonEmptyString.max(500)).max(128).default([]),
    error: nonEmptyString.max(20_000).optional(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!receipt.ok && !receipt.error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "is required when ok is false" });
    }
  });

export type CapabilityReceipt = z.infer<typeof capabilityReceiptSchema>;

export class CapabilityManifestError extends Error {
  readonly file?: string;

  constructor(message: string, file?: string, cause?: unknown) {
    super(file ? `${file}: ${message}` : message, { cause });
    this.name = "CapabilityManifestError";
    this.file = file;
  }
}

export function parseCapabilityManifest(value: unknown, source?: string): CapabilityManifest {
  const parsed = capabilityManifestSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "manifest"}: ${issue.message}`)
      .join("; ");
    throw new CapabilityManifestError(`invalid capability manifest (${detail})`, source, parsed.error);
  }
  return parsed.data;
}

export function parseCapabilityReceipt(value: unknown, source?: string): CapabilityReceipt {
  const parsed = capabilityReceiptSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "receipt"}: ${issue.message}`)
      .join("; ");
    throw new CapabilityManifestError(`invalid capability receipt (${detail})`, source, parsed.error);
  }
  return parsed.data;
}

export async function readCapabilityManifest(file: string): Promise<CapabilityManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    throw new CapabilityManifestError("could not read capability manifest", file, error);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new CapabilityManifestError("capability manifest is not valid JSON", file, error);
  }
  return parseCapabilityManifest(value, file);
}

export async function readCapabilityManifestIfPresent(skillDir: string): Promise<CapabilityManifest | null> {
  const file = path.join(skillDir, CAPABILITY_MANIFEST_FILE);
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  return readCapabilityManifest(file);
}

export function canonicalCapabilityManifest(manifest: CapabilityManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

export function capabilityManifestHash(manifest: CapabilityManifest): string {
  return createHash("sha256").update(canonicalCapabilityManifest(manifest), "utf8").digest("hex");
}
