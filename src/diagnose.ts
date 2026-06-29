/**
 * diagnose.ts — classify *why* a seal is broken, so the UI can tell a benign
 * server/editor round-trip apart from a real change. Pure (one hash probe).
 */

import { extractBodyText, bodyHashOf, LensResult } from "./lens-core";

export type BreakKind =
  | "ok"
  | "body-benign-normalization"
  | "body-edited"
  | "payload-record-altered"
  | "payload-hash-malformed"
  | "unreadable";

export interface BreakDiagnosis {
  kind: BreakKind;
  benign: boolean;
  detail: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export async function diagnoseBreak(raw: string, result: LensResult): Promise<BreakDiagnosis> {
  switch (result.state) {
    case "verified":
      return { kind: "ok", benign: true, detail: "Seal intact. Integrity is not truth — inspect before trusting." };

    case "unreadable":
      return { kind: "unreadable", benign: false, detail: result.reason ?? "Payload could not be read." };

    case "verified-body-modified": {
      const body = extractBodyText(raw);
      const stored = typeof result.payload?.body_hash === "string" ? result.payload.body_hash : "";
      if (body !== null && stored && (await bodyHashOf(body, true)) === stored) {
        return {
          kind: "body-benign-normalization",
          benign: true,
          detail:
            "The body changed only by Unicode normalization (a server or editor round-trip). It is semantically identical to what was sealed.",
        };
      }
      return {
        kind: "body-edited",
        benign: false,
        detail: "The visible body was edited after sealing. The sealed metadata is intact; reconcile the body or re-seal.",
      };
    }

    case "failed": {
      const stored = typeof result.payload?.payload_hash === "string" ? result.payload.payload_hash : "";
      if (!HEX64.test(stored)) {
        return {
          kind: "payload-hash-malformed",
          benign: false,
          detail: "The stored payload_hash is missing or malformed — the seal field itself may be corrupt or truncated.",
        };
      }
      return {
        kind: "payload-record-altered",
        benign: false,
        detail: "The sealed payload (metadata) changed after sealing. More serious than a body edit — the record itself is suspect.",
      };
    }
  }
}
