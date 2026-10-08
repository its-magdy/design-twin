// Hex digests, shared by bridge/ and design-to-code/ (the layer may import bridge/src; bridge cannot import
// the layer). sha1Hex, the asset-content hash, lives with the asset comparison in asset-compare.ts.
import crypto from "node:crypto";

/** sha256 of a string (hashed as UTF-8) or of bytes, as lowercase hex. */
export const sha256Hex = (data: string | Uint8Array): string => crypto.createHash("sha256").update(data).digest("hex");
