// Pure Desktop attachment policy. Keeping MIME normalization and aggregate
// budgeting outside React makes paste/drop and steering behavior testable.

export const MAX_ATTACH_B64 = 2_000_000;
export const MAX_ATTACHMENTS = 8;
export const MAX_TOTAL_ATTACH_B64 = 4_000_000;

const SUPPORTED_ATTACHMENT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_EXTENSION_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export function supportedAttachmentMediaType(file: { type?: string; name?: string }): {
  mediaType: string;
  looksLikeImage: boolean;
} {
  const declared = (file.type ?? "").trim().toLowerCase();
  const extension = (file.name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const byExtension = IMAGE_EXTENSION_MEDIA_TYPE[extension];
  const looksLikeImage = declared.startsWith("image/") || Boolean(byExtension);
  const normalized = declared === "image/jpg" ? "image/jpeg" : declared;
  if (SUPPORTED_ATTACHMENT_MIME_TYPES.has(normalized)) return { mediaType: normalized, looksLikeImage };
  if ((!declared || declared === "application/octet-stream") && byExtension) {
    return { mediaType: byExtension, looksLikeImage: true };
  }
  return { mediaType: "", looksLikeImage };
}

export type AttachmentBudgetViolation = "per_image" | "count" | "total";

export function attachmentBudgetViolation(
  existingBase64Chars: readonly number[],
  candidateBase64Chars: number,
): AttachmentBudgetViolation | null {
  if (candidateBase64Chars > MAX_ATTACH_B64) return "per_image";
  if (existingBase64Chars.length >= MAX_ATTACHMENTS) return "count";
  if (existingBase64Chars.reduce((sum, size) => sum + size, 0) + candidateBase64Chars > MAX_TOTAL_ATTACH_B64) {
    return "total";
  }
  return null;
}
