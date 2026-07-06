import { describe, it, expect } from "vitest";
import { carriedFields, sealKnobe, SealFields } from "../src/seal";
import { verify } from "../src/lens-core";

const FM = `---\ntitle: "x"\nspec_version: "1.0"\n---`;

const fields = (over: Partial<SealFields> = {}): SealFields => ({
  title: "x", summary: "s", content_type: "original", created_date: "2026-07-06",
  license: "CC BY 4.0", privacy_level: "public", quarantine_status: "quarantine",
  attribution: { sources: [{ author: "A", contribution: "authorship" }] },
  ...over,
});

/** Corrupt a sealed note's payload so the stored payload_hash no longer matches
 *  the recomputed one → verify() reports "failed" (decodable JSON, wrong hash). */
function tamperToFailed(sealed: string): string {
  const m = sealed.match(/-----BEGIN KNOBE B64-----\n([\s\S]*?)\n-----END KNOBE B64-----/);
  const b64 = m![1].replace(/\n/g, "");
  const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  json.summary = `${json.summary} TAMPERED`; // payload changes, stored hash does not
  const reB64 = Buffer.from(JSON.stringify(json), "utf8").toString("base64").replace(/(.{76})/g, "$1\n");
  return sealed.replace(m![1], reB64);
}

describe("carriedFields", () => {
  it("returns {} for a note with no seal", async () => {
    expect(await carriedFields("# just a note\n\nno seal here")).toEqual({});
  });

  it("carries every non-recomputed field from an intact seal, dropping hash fields", async () => {
    const sealed = await sealKnobe(FM, "body", fields({ instructions: "advisory", custom_x: "keep" }));
    const carried = await carriedFields(sealed);
    expect(carried.instructions).toBe("advisory");
    expect((carried as Record<string, unknown>).custom_x).toBe("keep"); // opaque extension preserved
    expect(carried.title).toBe("x");
    expect("payload_hash" in carried).toBe(false); // sealer regenerates these
    expect("body_hash" in carried).toBe(false);
  });

  it("still carries when only the body changed (seal block intact = body-modified)", async () => {
    const sealed = await sealKnobe(FM, "original body", fields({ instructions: "advisory" }));
    const bodyModified = sealed.replace("original body", "edited body");
    expect((await verify(bodyModified)).state).toBe("verified-body-modified");
    expect((await carriedFields(bodyModified)).instructions).toBe("advisory");
  });

  it("returns {} for a FAILED seal — never launders a tampered payload", async () => {
    const sealed = await sealKnobe(FM, "body", fields({ instructions: "advisory" }));
    const broken = tamperToFailed(sealed);
    expect((await verify(broken)).state).toBe("failed");
    expect(await carriedFields(broken)).toEqual({});
  });

  it("returns {} for an UNREADABLE seal (garbage payload block)", async () => {
    const garbage = `${FM}\n\nbody\n\n-----BEGIN KNOBE B64-----\nZm9v\n-----END KNOBE B64-----\n`;
    expect((await verify(garbage)).state).toBe("unreadable");
    expect(await carriedFields(garbage)).toEqual({});
  });
});
