/**
 * Short-reference codec per docs/data-model.md section 5: prefix + base36 of
 * the local integer ID. References are only stable within one database.
 */
export type RefKind = "conversation" | "message" | "summaryUnit" | "summaryFinding";

const KIND_TO_PREFIX: Record<RefKind, string> = {
  conversation: "qqc_",
  message: "qqm_",
  summaryUnit: "qqsu_",
  summaryFinding: "qqsf_",
};

const PREFIX_TO_KIND = Object.fromEntries(
  Object.entries(KIND_TO_PREFIX).map(([kind, prefix]) => [prefix, kind as RefKind]),
) as Record<string, RefKind>;

const BASE36_PATTERN = /^[0-9a-z]+$/;

export function encodeRef(kind: RefKind, id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`cannot encode non-positive id ${String(id)}`);
  }
  return KIND_TO_PREFIX[kind] + id.toString(36);
}

export interface DecodedRef {
  kind: RefKind;
  id: number;
}

export function decodeRef(ref: string): DecodedRef | undefined {
  const separator = ref.indexOf("_");
  if (separator === -1) return undefined;
  const prefix = ref.slice(0, separator + 1);
  const kind = PREFIX_TO_KIND[prefix];
  if (kind === undefined) return undefined;

  const encoded = ref.slice(separator + 1);
  if (!BASE36_PATTERN.test(encoded)) return undefined;
  const id = Number.parseInt(encoded, 36);
  if (!Number.isSafeInteger(id) || id < 1) return undefined;
  return { kind, id };
}
