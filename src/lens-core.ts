/**
 * lens-core.ts — KNOBE Protocol v1 verifier.
 *
 * A faithful TypeScript port of the reference verifier lens.py (knobe.org/lens.py),
 * in step with KnobeOne/knobe-protocol main 6132595 (PR #11 hostile input,
 * PR #12 and ERRATA E12) and with the display escaping of the pending upstream
 * safe() fix. Every verdict, hash, reason and conformance issue is gated against
 * lens.py's own output on the published vectors (test/lens-core.test.ts) and on a
 * battery of crafted files (test/lens-parity.test.ts), which also pins the two
 * places this port deliberately differs: CR-tolerant block markers, and
 * frontmatter that must declare spec_version (spec §3.1).
 *
 * Integrity, not truth: a `verified` status proves only that the sealed payload
 * is byte-intact. It does not prove the content is true, safe, or appropriate.
 *
 * Canonical hash rule (spec §5): decode the payload JSON, drop payload_hash,
 * NFC-normalize all keys and string values recursively, serialize with keys
 * sorted (by code point), no whitespace, arrays in order, literal UTF-8, SHA-256.
 */

import {
  PyFloat, PyValue, PyDict, isDict, pyTypeName, pyTruthy, pyStrRepr, pyRepr, pyStr, toPlain,
  hex, DuplicateKeyError, NonJSONConstantError, parseStrictJson, canonical,
} from "./pyjson";

export type Status = "verified" | "verified-body-modified" | "failed" | "unreadable";
export type Conformance = "valid" | "warnings" | "invalid";
export type BodyVerified = "yes" | "modified" | "omitted";

export interface LensResult {
  state: Status;
  computed: string | null;
  /** The sealed payload_hash: the string itself, "" when absent, null when the
   *  payload has none to report (unreadable, or JSON null). Any other JSON value
   *  is given as Python's str() of it, as lens.py prints it. Raw payload text:
   *  pass it through safe() before display. */
  stored: string | null;
  payload: Record<string, unknown> | null;
  missing: string[];
  body: "match" | "mismatch" | null;
  bodyVerified: BodyVerified;
  conformance: Conformance;
  /** lens.py's issue text. Parts may quote payload keys: display through safe(). */
  conformanceIssues: string[];
  multipleBlocks: boolean;
  blockCount: number;
  reason: string | null;
}

// A v1 lens must not guess how another protocol version is canonicalized or
// interpreted. Version gating happens before hashing, matching reference lens.py.
const SUPPORTED_SPEC_VERSIONS = new Set<string>(["1.0"]);

export const REQUIRED = ["spec_version", "title", "summary", "content_type", "created_date",
  "license", "privacy_level", "quarantine_status", "attribution", "payload_hash"];

const STRING_FIELDS = ["spec_version", "title", "summary", "content_type", "created_date",
  "license", "privacy_level", "quarantine_status"];

export const CANONICAL_VOCAB: Record<string, Set<string>> = {
  content_type: new Set(["original", "synthesis", "adaptation", "compression",
    "annotation", "seed", "collection", "translation"]),
  quarantine_status: new Set(["quarantine", "trusted", "rejected"]),
  privacy_level: new Set(["public", "internal", "sensitive", "restricted"]),
  identity_status: new Set(["declared", "signed"]),
};

// ASCII digits and hex only, nothing following (ERRATA E12).
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// Upper bound on the note size we'll attempt to verify (1 MB). Sealed KNOBE
// notes are tens of KB; this caps the cost of the block-extraction regexes on
// adversarial input rather than freezing the UI thread.
const MAX_RAW_BYTES = 1_000_000;

// Canonical block markers. The verifier ONLY treats the B64 form as sealed.
export const KNOBE_BEGIN_B64 = "-----BEGIN KNOBE B64-----";
export const KNOBE_END_B64 = "-----END KNOBE B64-----";

// Block matching tolerates CR (`\r\n` and the doubled `\r\r\n` some exporters
// emit): every `\r*` matches the empty string on pure-LF input, so the 9
// reference vectors are byte-for-byte unaffected. lens.py matches LF only and
// reports such a file unreadable; test/lens-parity.test.ts pins the difference.
const BLOCK_RE = /(?:^|\r*\n)-----BEGIN KNOBE B64-----\r*\n([\s\S]*?)\r*\n-----END KNOBE B64-----/g;
// Legacy/non-B64 marker (older or newer spec variants). Detected ONLY to surface
// such objects in the dashboard with a reason — never accepted as a sealed block.
const BARE_BLOCK_RE = /(?:^|\r*\n)-----BEGIN KNOBE B-----\r*\n([\s\S]*?)\r*\n-----END KNOBE B-----/g;
// Body extraction marker, CR-tolerant. Used via lastBodyMarkerStart().
const BODY_MARKER_RE = /\r*\n-----BEGIN KNOBE B64-----\r*\n/g;

// KNOBE.AI HTML-comment envelope (knobe_version 0.1): a JSON payload inside a
// <script> tag, delimited by HTML comments, with a self-describing integrity
// block. A second, fully distinct serialization from the PEM/B64 format above;
// extracted with linear scans (see extractHtmlPayloadJson), not a lazy regex.
// The only claim-fields canonicalization this verifier implements. Per the
// format's self-description: SHA-256 over the claim_fields VALUES, in the listed
// order, joined by this separator, UTF-8, no trailing separator.
const CLAIM_JOIN_METHOD = "claim-fields-join-v0.1";
const CLAIM_JOIN_SEP = "\n---\n";

// Cheap prefilter for "could this note contain a KNOBE object?" — matches the
// canonical B64 marker, the bare-B legacy variant, AND the 0.1 HTML envelope, so
// every KNOBE serialization is SURFACED (visible in the dashboard) rather than
// silently skipped. Intentionally more lenient than the per-format verifiers:
// lenient for discovery, strict for verification. Shared by scanner and plugin.
const KNOBE_MARKER_RE = /-----BEGIN KNOBE B(?:64)?-----|<!--\s*KNOBE_PAYLOAD_START\s*-->/;
export const hasKnobeMarker = (raw: string): boolean => KNOBE_MARKER_RE.test(raw);

/** Index of the last body marker (start of the `\r*\n` run), or -1. CR-tolerant
 *  replacement for `raw.lastIndexOf(BODY_MARKER)`. */
function lastBodyMarkerStart(raw: string): number {
  const re = new RegExp(BODY_MARKER_RE.source, "g");
  let idx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) idx = m.index;
  return idx;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * Render a (possibly payload-derived) value safely for display: escape C0/C1
 * control characters and DEL (so a crafted string cannot spoof a report or
 * inject terminal escape sequences), bidi overrides and isolates and line and
 * paragraph separators (U+202A-202E, U+2066-2069, U+2028/2029, which can
 * visually reorder text), and unpaired surrogates (which have no UTF-8 form).
 * Port of lens.py safe() with the pending upstream display-escaping fix, and of
 * knobe-core.js safe(). `limit` counts code points, as Python's len() does;
 * null keeps the whole text. Non-strings are shown as JSON.
 */
export function safe(value: unknown, limit: number | null = 300): string {
  if (typeof value !== "string") {
    let s: string | undefined;
    try { s = JSON.stringify(value); } catch { /* BigInt or a cycle */ }
    return safe(s ?? String(typeof value === "bigint" ? value : typeof value), limit);
  }
  const out: string[] = [];
  for (const ch of value) {
    const o = ch.codePointAt(0) as number;
    if (o < 0x20 || o === 0x7f || (o >= 0x80 && o <= 0x9f)) out.push("\\x" + hex(o, 2));
    else if ((o >= 0x202a && o <= 0x202e) || (o >= 0x2066 && o <= 0x2069) || o === 0x2028
      || o === 0x2029 || (o >= 0xd800 && o <= 0xdfff)) out.push("\\u" + hex(o, 4));
    else out.push(ch);
  }
  return limit !== null && out.length > limit ? out.slice(0, limit).join("") + "…" : out.join("");
}

/** Multi-line payload text for display: safe() on each line, line breaks kept,
 *  nothing cut. For panes that show a whole value (a summary, a JSON dump). */
export const safeLines = (text: string): string => text.split("\n").map((l) => safe(l, null)).join("\n");

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** lens.py: base64.b64decode(re.sub(r"[ \t\r\n]", "", block), validate=True).
 *  Only ASCII space, tab, CR and LF may wrap a block (ERRATA E12). */
function decodeBase64Strict(b64: string): Uint8Array {
  const compact = b64.replace(/[ \t\r\n]+/g, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("invalid base64");
  }
  const bin = atob(compact);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return bytes;
}

/** Strict UTF-8, keeping a leading BOM (which then fails the JSON parse, as in
 *  lens.py) rather than silently dropping it. */
const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

/* ---- body normalization (spec, optional body_hash) ---- */

// Python's str.isspace() set, which str.strip() and re's \s use. It differs from
// JS trim() and \s: it has U+001C-001F and U+0085, and lacks U+FEFF.
const PY_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85,
  0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const PY_WS = "[" + [...PY_SPACE].map((c) => "\\u" + hex(c, 4)).join("") + "]";

function pyStrip(s: string): string {
  let a = 0, b = s.length;
  while (a < b && PY_SPACE.has(s.charCodeAt(a))) a++;
  while (b > a && PY_SPACE.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

function normalizeBody(text: string): string {
  const lf = pyStrip(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return lf.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
}

function findBodyStart(pre: string): number | null {
  if (!(pre.startsWith("---\n") || pre.startsWith("---\r\n"))) return null;
  let idx = pre.indexOf("\n") + 1;
  for (;;) {
    const nl = pre.indexOf("\n", idx);
    const line = nl !== -1 ? pre.slice(idx, nl) : pre.slice(idx);
    if (line.replace(/\r+$/, "") === "---") return nl !== -1 ? nl + 1 : pre.length;
    if (nl === -1) return null;
    idx = nl + 1;
  }
}

// lens.py: re.match(r'\s*spec_version\s*:\s*(.+?)\s*$', line), with Python's \s.
const FM_SPEC_RE = new RegExp(`^${PY_WS}*spec_version${PY_WS}*:${PY_WS}*([^\\n]+?)${PY_WS}*$`);

/** lens.py parse_frontmatter(), plus spec §3.1: a frontmatter block that never
 *  declares spec_version is reported (lens.py accepts it). */
function parseFrontmatter(raw: string): { ok: boolean; spec: string | null; reason: string | null } {
  const lines = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).split("\n");
  if (lines[0].replace(/\r+$/, "") !== "---") {
    return { ok: false, spec: null, reason: "missing opening '---' frontmatter delimiter" };
  }
  let spec: string | null = null;
  for (let k = 1; k < lines.length; k++) {
    const ln = lines[k].replace(/\r+$/, "");
    if (ln === "---") {
      return spec === null
        ? { ok: false, spec: null, reason: "missing required spec_version" }
        : { ok: true, spec, reason: null };
    }
    const m = ln.match(FM_SPEC_RE);
    if (m && spec === null) spec = pyStrip(m[1]).replace(/^["']+/, "").replace(/["']+$/, "");
  }
  return { ok: false, spec, reason: "missing closing '---' frontmatter delimiter" };
}

/* ---- structural scans (ports of lens.py's, on the parsed payload) ---- */

function hasLoneSurrogate(x: PyValue | string): boolean {
  if (typeof x === "string") {
    for (let k = 0; k < x.length; k++) {
      const c = x.charCodeAt(k);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = x.charCodeAt(k + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { k++; continue; }
        return true;
      }
      if (c >= 0xdc00 && c <= 0xdfff) return true;
    }
    return false;
  }
  if (Array.isArray(x)) return x.some(hasLoneSurrogate);
  if (isDict(x)) for (const [k, v] of x) if (hasLoneSurrogate(k) || hasLoneSurrogate(v)) return true;
  return false;
}

function findNfcCollisions(x: PyValue, path = ""): string[] {
  const out: string[] = [];
  if (isDict(x)) {
    const normToOrig = new Map<string, string>();
    for (const k of x.keys()) {
      const nk = k.normalize("NFC");
      const prior = normToOrig.get(nk);
      if (prior !== undefined && prior !== k) {
        out.push(`${pyStrRepr(path ? `${path}.${k}` : k)} collides with ${pyStrRepr(prior)} under NFC`);
      } else if (prior === undefined) normToOrig.set(nk, k);
    }
    for (const [k, v] of x) out.push(...findNfcCollisions(v, path ? `${path}.${k}` : k));
  } else if (Array.isArray(x)) {
    x.forEach((v, idx) => out.push(...findNfcCollisions(v, `${path}[${idx}]`)));
  }
  return out;
}

function findNumericPaths(x: PyValue, path = ""): string[] {
  const out: string[] = [];
  if (typeof x === "number" || typeof x === "bigint" || x instanceof PyFloat) out.push(path);
  else if (Array.isArray(x)) x.forEach((v, idx) => out.push(...findNumericPaths(v, `${path}[${idx}]`)));
  else if (isDict(x)) for (const [k, v] of x) out.push(...findNumericPaths(v, path ? `${path}.${k}` : k));
  return out;
}

/** datetime.date.fromisoformat() on an ISO_DATE-shaped string. */
function isRealCalendarDate(s: string): boolean {
  const y = +s.slice(0, 4), mo = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

/** lens.py check_conformance(), in its order and wording. */
function checkConformance(
  payload: PyDict, missing: string[],
  fmOk: boolean, fmReason: string | null, fmSpec: string | null, blockCount: number,
): { level: Conformance; issues: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const get = (k: string): PyValue | null => (payload.has(k) ? (payload.get(k) as PyValue) : null);

  if (!fmOk) {
    errors.push(fmReason === "missing required spec_version"
      ? "YAML frontmatter missing required spec_version"
      : `YAML frontmatter missing or malformed: ${fmReason}`);
  } else {
    const sv = get("spec_version");
    if (fmSpec !== null && typeof sv === "string" && fmSpec !== sv) {
      warnings.push(`frontmatter spec_version ${pyStrRepr(fmSpec)} does not match sealed payload spec_version ${pyStrRepr(sv)}`);
    }
  }

  for (const mm of missing) errors.push(`required field missing: ${mm}`);

  for (const field of STRING_FIELDS) {
    const v = get(field);
    if (payload.has(field) && typeof v !== "string") {
      errors.push(`required field ${field} must be a string, got ${pyTypeName(v)}`);
    }
  }

  const att = get("attribution");
  if (att !== null) {
    if (!isDict(att)) errors.push(`attribution must be an object, got ${pyTypeName(att)}`);
    else {
      const src = att.has("sources") ? (att.get("sources") as PyValue) : null;
      if (src !== null && !Array.isArray(src)) errors.push(`attribution.sources must be an array, got ${pyTypeName(src)}`);
      else if (Array.isArray(src) && src.length === 0) errors.push("attribution.sources must be a non-empty array");
    }
  }

  const ph = get("payload_hash");
  if (ph !== null && !(typeof ph === "string" && HEX64.test(ph))) errors.push("payload_hash format invalid (must be 64 lowercase hex)");
  const bh = get("body_hash");
  if (bh !== null && !(typeof bh === "string" && HEX64.test(bh))) errors.push("body_hash format invalid (must be 64 lowercase hex)");

  const cd = get("created_date");
  if (cd !== null) {
    if (!(typeof cd === "string" && ISO_DATE.test(cd))) errors.push(`created_date is not in YYYY-MM-DD form: ${pyRepr(cd)}`);
    else if (!isRealCalendarDate(cd)) errors.push(`created_date is not a real calendar date: ${pyRepr(cd)}`);
  }

  const scan: PyDict = new Map([...payload].filter(([k]) => k !== "payload_hash"));
  const nums = findNumericPaths(scan);
  if (nums.length) {
    const shown = nums.length <= 5 ? nums : [...nums.slice(0, 5), "..."];
    errors.push(`bare numeric value(s) in payload (spec §5 requires strings): ${shown.join(", ")}`);
  }

  const parents = get("parents");
  (Array.isArray(parents) ? parents : []).forEach((p, idx) => {
    if (isDict(p) && p.has("payload_hash")) {
      const pph = p.get("payload_hash");
      if (typeof pph !== "string" || !HEX64.test(pph)) errors.push(`parents[${idx}].payload_hash format invalid (must be 64 lowercase hex)`);
    }
  });

  if (blockCount > 1) warnings.push(`multiple payload blocks present (${blockCount}); evaluated block ${blockCount} of ${blockCount} per spec §3.3`);

  for (const field of Object.keys(CANONICAL_VOCAB)) {
    const v = get(field);
    if (typeof v !== "string" || CANONICAL_VOCAB[field].has(v)) continue;
    if (!v.includes(":") && !v.startsWith("ext-")) {
      warnings.push(`${field}: ${pyStrRepr(v)} is a custom vocabulary value without namespace prefix (recommend 'ext-' or 'domain:' per §8)`);
    }
  }

  if (errors.length) return { level: "invalid", issues: [...errors, ...warnings] };
  if (warnings.length) return { level: "warnings", issues: warnings };
  return { level: "valid", issues: [] };
}

function unreadable(reason: string, blockCount: number, payload: Record<string, unknown> | null = null,
  issues: string[] = [reason]): LensResult {
  return {
    state: "unreadable", computed: null, stored: null, payload, missing: [],
    body: null, bodyVerified: "omitted", conformance: "invalid", conformanceIssues: issues,
    multipleBlocks: blockCount > 1, blockCount, reason,
  };
}

/* ---- reusable primitives (shared with the sealer, so seal == verify) ---- */

/** Canonical payload hash (spec §5), computed over the payload minus payload_hash. */
export async function payloadHashOf(payload: Record<string, unknown>): Promise<string> {
  const obj: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(payload)) if (k !== "payload_hash") obj[k] = payload[k];
  return sha256Hex(canonical(obj));
}

/** Normalized body hash (optional body_hash field). With applyNfc, additionally
 *  NFC-normalizes after body normalization — used by the break inspector to test
 *  the "benign server normalization" hypothesis. Body hashing itself never
 *  applies NFC, so default is false (matches the verifier and sealer). */
export async function bodyHashOf(bodyText: string, applyNfc = false): Promise<string> {
  const norm = normalizeBody(bodyText);
  return sha256Hex(applyNfc ? norm.normalize("NFC") : norm);
}

/** Extract the body text the verifier hashes: between the frontmatter close and
 *  the last payload marker. Returns null when not extractable. */
export function extractBodyText(raw: string): string | null {
  const markerIdx = lastBodyMarkerStart(raw);
  if (markerIdx < 0) return null;
  const pre = raw.slice(0, markerIdx);
  const start = findBodyStart(pre);
  return start === null ? null : pre.slice(start);
}

/** Parse JSON strictly into plain values (null-prototype objects, numbers). */
function parsePlainJson(text: string): unknown {
  return toPlain(parseStrictJson(text));
}

/* ---- KNOBE.AI HTML-comment envelope (knobe_version 0.1) ---- */

/** Compute the claim-fields-join-v0.1 hash, or an explanatory error.
 *
 *  SECURITY NOTE: the v0.1 join is NOT prefix-free — values are concatenated with
 *  a plain separator and the field NAMES are not part of the preimage. A value
 *  containing the separator could let two structurally different payloads hash
 *  identically (separator injection). We faithfully implement the scheme but
 *  REFUSE to assert "verified" when any value contains the separator, since the
 *  preimage is then ambiguous. (Reported upstream: v0.2 should length-prefix or
 *  include field names.) `claim_fields` lists names; values are read from the
 *  sibling top-level `fields` map, per the format. */
type HashResult = { hash: string } | { error: string };
async function claimFieldsJoinHash(payload: Record<string, unknown>): Promise<HashResult> {
  const integ = payload.integrity;
  if (!isObj(integ) || !Array.isArray(integ.claim_fields)) return { error: "integrity.claim_fields is missing" };
  const fields = payload.fields;
  if (!isObj(fields)) return { error: "the fields object is missing" };
  const values: string[] = [];
  for (const name of integ.claim_fields) {
    if (typeof name !== "string") return { error: "claim_fields contains a non-string name" };
    const v = fields[name];
    if (typeof v !== "string") return { error: `claim field '${safe(name)}' is missing or not a string` };
    if (v.includes(CLAIM_JOIN_SEP)) return { error: `claim field '${safe(name)}' contains the join separator — ambiguous preimage, cannot verify safely` };
    values.push(v);
  }
  return { hash: await sha256Hex(values.join(CLAIM_JOIN_SEP)) };
}

/** Extract the JSON text from the 0.1 HTML-comment envelope using linear scans
 *  (no lazy-wildcard regex over the whole file — avoids O(n^2) backtracking on
 *  adversarial input). Returns null when the delimiters aren't both present. */
function extractHtmlPayloadJson(raw: string): string | null {
  const startTok = raw.indexOf("KNOBE_PAYLOAD_START");
  if (startTok < 0) return null;
  const afterStart = raw.indexOf("-->", startTok);
  if (afterStart < 0) return null;
  const endTok = raw.indexOf("KNOBE_PAYLOAD_END", afterStart);
  if (endTok < 0) return null;
  const beforeEnd = raw.lastIndexOf("<!--", endTok);
  if (beforeEnd < 0 || beforeEnd <= afterStart) return null;
  const between = raw.slice(afterStart + 3, beforeEnd);
  // `between` is bounded by the payload region, so a scoped regex here is safe.
  const script = between.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  return (script ? script[1] : between).trim();
}

/** Verify a KNOBE.AI 0.1 HTML-comment/script object. Self-describing: the payload
 *  declares its own canonicalization; we implement claim-fields-join-v0.1 and
 *  surface anything else as unreadable-but-recognized. */
async function verifyHtmlEnvelope(raw: string): Promise<LensResult> {
  const json = extractHtmlPayloadJson(raw);
  if (json === null) return unreadable("KNOBE payload markers not found", 0);

  let parsed: PyValue;
  try {
    parsed = parseStrictJson(json);
  } catch {
    return unreadable("KNOBE payload could not be parsed", 1);
  }
  if (!isDict(parsed)) return unreadable("KNOBE payload is not a JSON object", 1);
  // UTF-8 encoding turns an unpaired surrogate into the bytes of U+FFFD, so two
  // different claims would share one hash: reject, as the B64 path does.
  if (hasLoneSurrogate(parsed)) {
    return unreadable("KNOBE payload contains characters that cannot be UTF-8 encoded (e.g. an unpaired surrogate); rejected", 1);
  }
  const payload = toPlain(parsed) as Record<string, unknown>;

  const integ = isObj(payload.integrity) ? payload.integrity : null;
  const method = integ && isObj(integ.canonicalization) ? integ.canonicalization.method : undefined;
  if (method !== CLAIM_JOIN_METHOD) {
    return unreadable(`unsupported KNOBE canonicalization '${typeof method === "string" ? safe(method) : "unknown"}'`, 1, payload);
  }

  const stored = integ && typeof integ.sha256 === "string" ? integ.sha256 : null;
  if (stored === null || !HEX64.test(stored)) {
    return unreadable("KNOBE 0.1: integrity.sha256 is missing or not 64 lowercase hex", 1, payload);
  }
  const res = await claimFieldsJoinHash(payload);
  if ("error" in res) return unreadable(`KNOBE 0.1: ${res.error}`, 1, payload);

  return {
    state: res.hash === stored ? "verified" : "failed",
    computed: res.hash, stored, payload, missing: [],
    body: null, bodyVerified: "omitted",
    conformance: "valid", conformanceIssues: [],
    multipleBlocks: false, blockCount: 1, reason: null,
  };
}

/** Decode the last bare-B (non-B64) block's JSON payload, or null. Used only to
 *  surface unverifiable legacy/variant objects with a meaningful title/reason.
 *  Assumes the same base64 encoding as B64 blocks; a raw-JSON or otherwise-encoded
 *  variant returns null and the file surfaces as "no payload block found". */
function tryDecodeBareBlock(raw: string): Record<string, unknown> | null {
  const re = new RegExp(BARE_BLOCK_RE.source, "g");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) last = m[1];
  if (last === null) return null;
  try {
    const parsed = parsePlainJson(decodeUtf8(decodeBase64Strict(last)));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ---- public entry point ---- */

export async function verify(raw: string): Promise<LensResult> {
  // Bound work before any block regex runs. The marker extractors use lazy
  // wildcards that backtrack toward O(n^2) on adversarial input with a missing
  // end marker; a real sealed note is far under this, so oversized files are
  // refused rather than scanned. (The 0.1 path uses linear extraction already.)
  if (raw.length > MAX_RAW_BYTES) return unreadable("file too large to verify", 0);

  const blocks: string[] = [];
  const re = new RegExp(BLOCK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) blocks.push(m[1]);
  if (blocks.length === 0) {
    // No PEM/B64 block. A KNOBE.AI 0.1 HTML-comment envelope is a separate, fully
    // verifiable serialization — route to its own verifier.
    if (raw.includes("KNOBE_PAYLOAD_START")) return verifyHtmlEnvelope(raw);
    // Otherwise: if a bare-B (legacy/variant) block is present, surface it as
    // unreadable with its declared spec_version and payload so the dashboard
    // shows the real title and reason instead of hiding the file.
    const bare = tryDecodeBareBlock(raw);
    if (bare) {
      const reason = typeof bare.payload_hash === "string"
        ? "legacy KNOBE block (non-B64 marker); re-seal this note to verify under the current format"
        : "KNOBE block has no payload_hash (unsealed/legacy); re-seal this note to verify";
      return unreadable(reason, 0, bare);
    }
    return unreadable("no payload block found", 0);
  }
  const n = blocks.length;

  // --- decode + parse the last block, rejecting ambiguous/illegal JSON ---
  let parsed: PyValue;
  try {
    parsed = parseStrictJson(decodeUtf8(decodeBase64Strict(blocks[n - 1])));
  } catch (e) {
    if (e instanceof DuplicateKeyError) return unreadable(`payload contains duplicate JSON key: ${safe(e.key)} (ambiguous; rejected)`, n);
    if (e instanceof NonJSONConstantError) return unreadable("payload contains a non-JSON numeric constant (NaN/Infinity); rejected", n);
    return unreadable("payload could not be decoded or parsed", n);
  }
  if (!isDict(parsed)) return unreadable(`payload is not a JSON object (got ${pyTypeName(parsed)})`, n);
  const payload = parsed;

  // Unpaired surrogates anywhere (payload_hash included) cannot be encoded for
  // hashing or display: reject before either.
  if (hasLoneSurrogate(payload)) {
    return unreadable("payload contains characters that cannot be UTF-8 encoded (e.g. an unpaired surrogate); rejected", n);
  }
  const plain = toPlain(payload) as Record<string, unknown>;

  const collisions = findNfcCollisions(payload);
  if (collisions.length) {
    return unreadable(`payload keys collide under NFC normalization: ${collisions.slice(0, 5).join("; ")}`, n, plain);
  }

  // Unsupported spec_version (any non-null value other than the string "1.0").
  const sv = payload.get("spec_version");
  if (sv !== undefined && sv !== null && !(typeof sv === "string" && SUPPORTED_SPEC_VERSIONS.has(sv))) {
    const shown = safe(pyStr(sv));
    return unreadable(`unsupported spec_version: ${shown}`, n, plain,
      [`unsupported spec_version: ${shown} (this verifier supports ${pyRepr([...SUPPORTED_SPEC_VERSIONS].sort())})`]);
  }

  // --- canonical hash (spec §5) ---
  const ph = payload.has("payload_hash") ? (payload.get("payload_hash") as PyValue) : "";
  const stored = ph === null ? null : pyStr(ph);
  const rest: PyDict = new Map([...payload].filter(([k]) => k !== "payload_hash"));
  const computed = await sha256Hex(canonical(rest));

  const missing = REQUIRED.filter((f) => !payload.has(f));
  const att = payload.get("attribution");
  if (payload.has("attribution") && !(isDict(att) && pyTruthy(att.get("sources")))) missing.push("attribution.sources");

  let state: Status = typeof ph === "string" && computed === ph ? "verified" : "failed";
  const fm = parseFrontmatter(raw);

  let body: "match" | "mismatch" | null = null;
  let bodyVerified: BodyVerified = "omitted";
  if (state === "verified" && payload.has("body_hash") && n === 1) {
    // A block at byte 0 has no marker line before it: no frontmatter, no body.
    const markerIdx = lastBodyMarkerStart(raw);
    const pre = markerIdx >= 0 ? raw.slice(0, markerIdx) : "";
    const bodyStart = findBodyStart(pre);
    if (bodyStart === null) {
      return unreadable("body_hash present but YAML frontmatter delimiters not found", n, plain);
    }
    const computedBody = await bodyHashOf(pre.slice(bodyStart));
    if (computedBody === payload.get("body_hash")) { body = "match"; bodyVerified = "yes"; }
    else { body = "mismatch"; bodyVerified = "modified"; state = "verified-body-modified"; }
  }

  const conf = checkConformance(payload, missing, fm.ok, fm.reason, fm.spec, n);

  return {
    state, computed, stored, payload: plain, missing, body, bodyVerified,
    conformance: conf.level, conformanceIssues: conf.issues,
    multipleBlocks: n > 1, blockCount: n, reason: null,
  };
}
