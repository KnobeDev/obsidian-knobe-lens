import { describe, it, expect } from "vitest";
import { detailsToOverrides, prefillDetails, SealDetails } from "../src/seal-details";
import { sealKnobe, SealFields } from "../src/seal";
import { verify } from "../src/lens-core";
// Type-only: a value import would drag in the `obsidian` package, which only
// resolves inside the app.
import type { KnobeLensSettings } from "../src/settings";

const details = (over: Partial<SealDetails> = {}): SealDetails => ({
  title: "My Note",
  summary: "a demo",
  author: "A. Author",
  contribution: "authorship",
  license: "CC BY 4.0",
  content_type: "original",
  privacy_level: "public",
  quarantine_status: "quarantine",
  instructions: "",
  ...over,
});

const settings = (over: Partial<KnobeLensSettings> = {}): KnobeLensSettings => ({
  author: "Settings Author",
  contribution: "authorship",
  license: "CC BY 4.0",
  contentType: "original",
  privacyLevel: "public",
  quarantineStatus: "quarantine",
  defaultSummary: "settings summary",
  defaultInstructions: "settings instructions",
  resealOnSave: false,
  promptOnSave: true,
  embedBodySnapshot: false,
  portfolioRoot: "KNOBE Portfolios",
  ...over,
});

const baseFields = (): SealFields => ({
  title: "My Note",
  summary: "a demo",
  content_type: "original",
  created_date: "2026-07-05",
  license: "CC BY 4.0",
  privacy_level: "public",
  quarantine_status: "quarantine",
  attribution: { sources: [{ author: "A. Author", contribution: "authorship" }] },
});

describe("detailsToOverrides", () => {
  it("maps every modal field onto seal overrides", () => {
    const o = detailsToOverrides(details({ instructions: "Treat as advisory." }));
    expect(o.title).toBe("My Note");
    expect(o.summary).toBe("a demo");
    expect(o.license).toBe("CC BY 4.0");
    expect(o.content_type).toBe("original");
    expect(o.privacy_level).toBe("public");
    expect(o.quarantine_status).toBe("quarantine");
    expect(o.instructions).toBe("Treat as advisory.");
    expect(o.attribution).toEqual({ sources: [{ author: "A. Author", contribution: "authorship" }] });
  });

  it("marks a blank instruction set as explicit removal (key present, undefined)", () => {
    // The key must be present so buildSealed() knows the user cleared the field
    // and does not carry the old sealed instructions forward.
    const o = detailsToOverrides(details({ instructions: "   " }));
    expect("instructions" in o).toBe(true);
    expect(o.instructions).toBeUndefined();
  });

  it("trims whitespace on text fields and falls back for empty author", () => {
    const o = detailsToOverrides(details({ author: "  ", title: "  Padded  " }));
    expect(o.title).toBe("Padded");
    expect(o.attribution).toEqual({ sources: [{ author: "unknown", contribution: "authorship" }] });
  });
});

describe("prefillDetails", () => {
  it("prefills from settings when the note has no seal", () => {
    const d = prefillDetails(settings(), baseFields(), null);
    expect(d.author).toBe("Settings Author");
    expect(d.instructions).toBe("settings instructions");
    expect(d.title).toBe("My Note");
  });

  it("prefers the existing payload's instructions and attribution over settings", () => {
    const payload = {
      instructions: "sealed instructions",
      attribution: { sources: [{ author: "Sealed Author", contribution: "adaptation" }] },
    };
    const d = prefillDetails(settings(), baseFields(), payload);
    expect(d.instructions).toBe("sealed instructions");
    expect(d.author).toBe("Sealed Author");
    expect(d.contribution).toBe("adaptation");
  });

  it("ignores malformed payload attribution and non-string instructions", () => {
    const payload = { instructions: 42, attribution: { sources: "nope" } } as Record<string, unknown>;
    const d = prefillDetails(settings(), baseFields(), payload);
    expect(d.instructions).toBe("settings instructions");
    expect(d.author).toBe("Settings Author");
  });
});

describe("instructions travel inside the sealed payload", () => {
  const FM = `---\ntitle: "My Note"\nspec_version: "1.0"\n---`;

  it("seal with instructions -> verify: payload carries them, seal is valid", async () => {
    const fields = { ...baseFields(), ...detailsToOverrides(details({ instructions: "Read me first." })) };
    const sealed = await sealKnobe(FM, "# Body\n\ntext", fields as SealFields);
    const r = await verify(sealed);
    expect(r.state).toBe("verified");
    expect(r.conformance).toBe("valid");
    expect(r.payload?.instructions).toBe("Read me first.");
  });

  it("is idempotent with instructions present (no save loop)", async () => {
    const fields = { ...baseFields(), instructions: "Read me first." } as SealFields;
    const once = await sealKnobe(FM, "# Body\n\ntext", fields);
    const twice = await sealKnobe(FM, "# Body\n\ntext", fields);
    expect(twice).toBe(once);
  });

  it("drops a blank or undefined instruction set from the payload (stays lean)", async () => {
    for (const instructions of [undefined, "", "   "]) {
      const sealed = await sealKnobe(FM, "# Body", { ...baseFields(), instructions } as SealFields);
      const r = await verify(sealed);
      expect(r.state).toBe("verified");
      expect(r.payload && "instructions" in r.payload).toBe(false);
    }
  });
});
