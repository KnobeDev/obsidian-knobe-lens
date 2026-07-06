import { describe, it, expect } from "vitest";
import { resolveSealFields, mayEmbedBody, descriptiveFrontmatter, FRONTMATTER_DESCRIPTIVE, SealFields } from "../src/seal";

const CONTENT_TYPES = ["original", "synthesis", "adaptation", "compression", "annotation", "seed", "collection", "translation"];

const mk = (over: Partial<SealFields> = {}): SealFields => ({
  title: "T", summary: "S", content_type: "original", created_date: "2026-07-06",
  license: "CC BY 4.0", privacy_level: "public", quarantine_status: "quarantine",
  attribution: { sources: [{ author: "A", contribution: "authorship" }] },
  ...over,
});

describe("FRONTMATTER_DESCRIPTIVE", () => {
  it("covers descriptive fields but never created_date, quarantine_status, or privacy_level", () => {
    expect([...FRONTMATTER_DESCRIPTIVE]).toEqual(["title", "summary", "content_type", "license"]);
    expect(FRONTMATTER_DESCRIPTIVE).not.toContain("created_date");      // must stay stable
    expect(FRONTMATTER_DESCRIPTIVE).not.toContain("quarantine_status"); // action-managed (promote)
    expect(FRONTMATTER_DESCRIPTIVE).not.toContain("privacy_level");     // security-managed (embed guard)
  });
});

describe("mayEmbedBody (fail-closed privacy guard)", () => {
  it("embeds only for recognized non-restricted levels when enabled", () => {
    expect(mayEmbedBody(true, "public")).toBe(true);
    expect(mayEmbedBody(true, "internal")).toBe(true);
    expect(mayEmbedBody(true, "sensitive")).toBe(true);
  });

  it("never embeds restricted content", () => {
    expect(mayEmbedBody(true, "restricted")).toBe(false);
  });

  it("fails closed on an unrecognized / typo'd / missing privacy level", () => {
    for (const bad of ["Restricted", "RESTRICTED", "secret", "", undefined, null, 5]) {
      expect(mayEmbedBody(true, bad)).toBe(false);
    }
  });

  it("never embeds when the setting is off", () => {
    expect(mayEmbedBody(false, "public")).toBe(false);
  });
});

describe("descriptiveFrontmatter", () => {
  it("returns only the descriptive fields explicitly set in frontmatter", () => {
    const out = descriptiveFrontmatter(
      { title: "T", summary: "S", license: "MIT", content_type: "synthesis" }, CONTENT_TYPES,
    );
    expect(out).toEqual({ title: "T", summary: "S", license: "MIT", content_type: "synthesis" });
  });

  it("ignores empty / non-string / absent values", () => {
    expect(descriptiveFrontmatter({ title: "  ", summary: 5, license: null }, CONTENT_TYPES)).toEqual({});
    expect(descriptiveFrontmatter({}, CONTENT_TYPES)).toEqual({});
  });

  it("drops a typo'd content_type so it can't overwrite the carried value", () => {
    expect(descriptiveFrontmatter({ content_type: "Synthesis" }, CONTENT_TYPES)).toEqual({});
    expect(descriptiveFrontmatter({ content_type: "bogus" }, CONTENT_TYPES)).toEqual({});
  });

  it("never surfaces privacy_level, quarantine_status, or created_date from frontmatter", () => {
    const out = descriptiveFrontmatter(
      { privacy_level: "public", quarantine_status: "trusted", created_date: "2020-01-01", title: "keep" },
      CONTENT_TYPES,
    );
    expect(out).toEqual({ title: "keep" });
  });
});

describe("resolveSealFields precedence", () => {
  const defaults = mk({ title: "basename", created_date: "2026-07-06", license: "settings-license" });
  const carried = mk({
    title: "OldSealed", summary: "old summary", created_date: "2026-01-01",
    quarantine_status: "trusted", license: "CC BY 4.0",
    instructions: "keep me", custom_x: "opaque",
  } as Partial<SealFields>);

  it("explicit frontmatter edits to descriptive fields win over the last-sealed payload", () => {
    const out = resolveSealFields(defaults, carried, { title: "NewFromFrontmatter", license: "MIT" }, {});
    expect(out.title).toBe("NewFromFrontmatter"); // THE FIX: frontmatter edit is honored
    expect(out.license).toBe("MIT");
    expect(out.summary).toBe("old summary");       // not edited in frontmatter -> carried
  });

  it("keeps created_date and quarantine_status from the last seal (stable / promotion-safe)", () => {
    const out = resolveSealFields(defaults, carried, { title: "New" }, {});
    expect(out.created_date).toBe("2026-01-01");   // stable, not reset to defaults' today
    expect(out.quarantine_status).toBe("trusted"); // a promotion is not reverted on reseal
  });

  it("carries opaque / extension fields through untouched", () => {
    const out = resolveSealFields(defaults, carried, {}, {}) as Record<string, unknown>;
    expect(out.instructions).toBe("keep me");
    expect(out.custom_x).toBe("opaque");
  });

  it("caller overrides win over frontmatter and carried", () => {
    const out = resolveSealFields(defaults, carried, { title: "FromFrontmatter" }, { title: "FromPrompt" });
    expect(out.title).toBe("FromPrompt");
  });

  it("a cleared field (override undefined) drops the carried value", () => {
    const out = resolveSealFields(defaults, carried, {}, { instructions: undefined } as Partial<SealFields>);
    expect(out.instructions).toBeUndefined();
  });

  it("merges override attribution onto carried sources, preserving per-source metadata", () => {
    const withMeta = mk({ attribution: { sources: [{ author: "A", contribution: "authorship", orcid: "0000-1" }] } });
    const out = resolveSealFields(defaults, withMeta, {}, {
      attribution: { sources: [{ author: "B", contribution: "adaptation" }] },
    });
    expect(out.attribution.sources[0]).toEqual({ author: "B", contribution: "adaptation", orcid: "0000-1" });
  });

  it("new seal (empty carried): frontmatter over defaults, overrides over all", () => {
    const out = resolveSealFields(mk({ title: "base", license: "settings" }), {}, { title: "FM" }, {});
    expect(out.title).toBe("FM");
    expect(out.license).toBe("settings");
  });
});
