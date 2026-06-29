/**
 * lens-core.ts — KNOBE Protocol v1 verifier.
 *
 * A faithful TypeScript port of the reference verifier lens.py (knobe.org/lens.py).
 * Behavior is gated against lens.py's own output on the 9 published conformance
 * vectors — see test/lens-core.test.ts and test/expected.json.
 *
 * Integrity, not truth: a `verified` status proves only that the sealed payload
 * is byte-intact. It does not prove the content is true, safe, or appropriate.
 *
 * Canonical hash rule (spec §5): decode the payload JSON, drop payload_hash,
 * NFC-normalize all keys and string values recursively, serialize with keys
 * sorted (by code point), no whitespace, arrays in order, literal UTF-8, SHA-256.
 */

export type Status = "verified" | "verified-body-modified" | "failed" | "unreadable";
export type Conformance = "valid" | "warnings" | "invalid";
export type BodyVerified = "yes" | "modified" | "omitted" | null;

export interface LensResult {
  state: Status;
  computed: string | null;
  stored: string | null;
  payload: Record<string, unknown> | null;
  missing: string[];
  body: "match" | "mismatch" | null;
  bodyVerified: BodyVerified;
  conformance: Conformance;
  conformanceIssues: string[];
  multipleBlocks: boolean;
  blockCount: number;
  reason: string | null;
}

const SUPPORTED_SPEC_VERSIONS = new Set(["1.0"]);

const REQUIRED = ["spec_version", "title", "summary", "content_type", "created_date",
  "license", "privacy_level", "quarantine_status", "attribution", "payload_hash"];

const STRING_FIELDS = ["spec_version", "title", "summary", "content_type", "created_date",
  "license", "privacy_level", "quarantine_status"];

const CANONICAL_VOCAB: Record<string, Set<string>> = {
  content_type: new Set(["original", "synthesis", "adaptation", "compression",
    "annotation", "seed", "collection", "translation"]),
  quarantine_status: new Set(["quarantine", "trusted", "rejected"]),
  privacy_level: new Set(["public", "internal", "sensitive", "restricted"]),
  identity_status: new Set(["declared", "signed"]),
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BLOCK_RE = /(?:^|\n)-----BEGIN KNOBE B64-----\n([\s\S]*?)\n-----END KNOBE B64-----/g;
const BODY_MARKER = "\n-----BEGIN KNOBE B64-----\n";

class DuplicateKeyError extends Error {}

const isObj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);

/* ---- strict JSON parse: rejects duplicate keys + NaN/Infinity (spec §5) ---- */

function parseStrictJson(text: string): unknown {
  let i = 0;
  const n = text.length;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const ws = () => { while (i < n && isWs(text[i])) i++; };
  const numRe = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  function parseString(): string {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= n) throw new SyntaxError("unterminated string");
      const c = text[i++];
      if (c === '"') return out;
      if (c === "\\") {
        const e = text[i++];
        if (e === '"') out += '"';
        else if (e === "\\") out += "\\";
        else if (e === "/") out += "/";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError("bad unicode escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else throw new SyntaxError("bad escape");
      } else if (c.charCodeAt(0) < 0x20) {
        throw new SyntaxError("control character in string");
      } else out += c;
    }
  }
  // null-prototype objects: a "__proto__" key becomes an ordinary own property
  // (so it is hashed and the seal correctly fails), not a prototype mutation —
  // this closes a body-hash bypass via prototype pollution.
  function parseObject(depth: number): Record<string, unknown> {
    i++; // {
    const obj: Record<string, unknown> = Object.create(null);
    const seen = new Set<string>();
    ws();
    if (text[i] === "}") { i++; return obj; }
    for (;;) {
      ws();
      if (text[i] !== '"') throw new SyntaxError("expected object key");
      const key = parseString();
      if (seen.has(key)) throw new DuplicateKeyError(key);
      seen.add(key);
      ws();
      if (text[i] !== ":") throw new SyntaxError("expected ':'");
      i++;
      obj[key] = parseValue(depth + 1);
      ws();
      const ch = text[i];
      if (ch === ",") { i++; continue; }
      if (ch === "}") { i++; return obj; }
      throw new SyntaxError("expected ',' or '}'");
    }
  }
  function parseArray(depth: number): unknown[] {
    i++; // [
    const arr: unknown[] = [];
    ws();
    if (text[i] === "]") { i++; return arr; }
    for (;;) {
      arr.push(parseValue(depth + 1));
      ws();
      const ch = text[i];
      if (ch === ",") { i++; continue; }
      if (ch === "]") { i++; return arr; }
      throw new SyntaxError("expected ',' or ']'");
    }
  }
  function parseValue(depth: number): unknown {
    if (depth > 256) throw new SyntaxError("JSON nesting too deep"); // DoS guard
    ws();
    if (i >= n) throw new SyntaxError("unexpected end of input");
    const c = text[i];
    if (c === "{") return parseObject(depth);
    if (c === "[") return parseArray(depth);
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) {
      numRe.lastIndex = i;
      const m = numRe.exec(text);
      if (!m || m.index !== i) throw new SyntaxError("bad number");
      i += m[0].length;
      return Number(m[0]);
    }
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    throw new SyntaxError("unexpected token"); // rejects NaN / Infinity
  }

  const value = parseValue(0);
  ws();
  if (i !== n) throw new SyntaxError("trailing content after JSON value");
  return value;
}

/* ---- canonicalization (spec §5) ---- */

function nfcNormalize(x: unknown): unknown {
  if (typeof x === "string") return x.normalize("NFC");
  if (Array.isArray(x)) return x.map(nfcNormalize);
  if (isObj(x)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(x)) out[k.normalize("NFC")] = nfcNormalize(x[k]);
    return out;
  }
  return x;
}

function cmpCodePoint(a: string, b: string): number {
  const ai = Array.from(a), bi = Array.from(b);
  const len = Math.min(ai.length, bi.length);
  for (let k = 0; k < len; k++) {
    const d = (ai[k].codePointAt(0) as number) - (bi[k].codePointAt(0) as number);
    if (d !== 0) return d;
  }
  return ai.length - bi.length;
}

function canonical(x: unknown): string {
  if (x === null) return "null";
  if (typeof x === "boolean") return x ? "true" : "false";
  if (typeof x === "number") return String(x); // payload numerics SHOULD be strings (§5)
  if (typeof x === "string") return JSON.stringify(x); // matches Python json ensure_ascii=False
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  const obj = x as Record<string, unknown>;
  const keys = Object.keys(obj).sort(cmpCodePoint);
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeBase64Strict(b64: string): Uint8Array {
  const compact = b64.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("invalid base64");
  }
  const bin = atob(compact);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return bytes;
}

/* ---- body normalization (spec, optional body_hash) ---- */

function normalizeBody(text: string): string {
  const stripped = text.trim();
  const lf = stripped.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return lf.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
}

function findBodyStart(pre: string): number | null {
  if (!(pre.startsWith("---\n") || pre.startsWith("---\r\n"))) return null;
  let idx = pre.indexOf("\n") + 1;
  for (;;) {
    const nl = pre.indexOf("\n", idx);
    const line = nl !== -1 ? pre.slice(idx, nl) : pre.slice(idx);
    if (line.replace(/\r$/, "") === "---") return nl !== -1 ? nl + 1 : pre.length;
    if (nl === -1) return null;
    idx = nl + 1;
  }
}

function parseFrontmatter(raw: string): { ok: boolean; spec: string | null; reason: string | null } {
  let r = raw;
  if (r.charCodeAt(0) === 0xfeff) r = r.slice(1);
  const lines = r.split("\n");
  if (lines.length === 0 || lines[0].replace(/\r$/, "") !== "---") {
    return { ok: false, spec: null, reason: "missing opening '---' frontmatter delimiter" };
  }
  let spec: string | null = null;
  for (let k = 1; k < lines.length; k++) {
    const ln = lines[k].replace(/\r$/, "");
    if (ln === "---") return { ok: true, spec, reason: null };
    const m = ln.match(/^\s*spec_version\s*:\s*(.+?)\s*$/);
    if (m && spec === null) spec = m[1].trim().replace(/^["']/, "").replace(/["']$/, "");
  }
  return { ok: false, spec, reason: "missing closing '---' frontmatter delimiter" };
}

/* ---- structural scans ---- */

function findNfcCollisions(x: unknown): string[] {
  const out: string[] = [];
  if (isObj(x)) {
    const map = new Map<string, string>();
    for (const k of Object.keys(x)) {
      const nk = k.normalize("NFC");
      if (map.has(nk) && map.get(nk) !== k) out.push(`${k} collides with ${map.get(nk)} under NFC`);
      else if (!map.has(nk)) map.set(nk, k);
    }
    for (const k of Object.keys(x)) out.push(...findNfcCollisions(x[k]));
  } else if (Array.isArray(x)) {
    for (const v of x) out.push(...findNfcCollisions(v));
  }
  return out;
}

function findNumericPaths(x: unknown, path = ""): string[] {
  const out: string[] = [];
  if (typeof x === "boolean") return out;
  if (typeof x === "number") { out.push(path); return out; }
  if (Array.isArray(x)) x.forEach((v, idx) => out.push(...findNumericPaths(v, `${path}[${idx}]`)));
  else if (isObj(x)) for (const k of Object.keys(x)) out.push(...findNumericPaths(x[k], path ? `${path}.${k}` : k));
  return out;
}

function isRealCalendarDate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function checkConformance(
  payload: Record<string, unknown>, missing: string[],
  fmOk: boolean, fmReason: string | null, fmSpec: string | null, blockCount: number,
): { level: Conformance; issues: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fmOk) errors.push(`YAML frontmatter missing or malformed: ${fmReason}`);
  else if (fmSpec !== null && typeof payload.spec_version === "string" && fmSpec !== payload.spec_version) {
    warnings.push(`frontmatter spec_version '${fmSpec}' does not match sealed payload spec_version '${payload.spec_version}'`);
  }

  for (const mm of missing) errors.push(`required field missing: ${mm}`);

  for (const field of STRING_FIELDS) {
    if (field in payload && typeof payload[field] !== "string") {
      errors.push(`required field ${field} must be a string, got ${typeof payload[field]}`);
    }
  }

  const att = payload.attribution;
  if (att !== undefined) {
    if (!isObj(att)) errors.push(`attribution must be an object`);
    else {
      const src = att.sources;
      if (src !== undefined && !Array.isArray(src)) errors.push(`attribution.sources must be an array`);
      else if (Array.isArray(src) && src.length === 0) errors.push(`attribution.sources must be a non-empty array`);
    }
  }

  const ph = payload.payload_hash;
  if (ph !== undefined && !(typeof ph === "string" && HEX64.test(ph))) errors.push(`payload_hash format invalid (must be 64 lowercase hex)`);
  const bh = payload.body_hash;
  if (bh !== undefined && !(typeof bh === "string" && HEX64.test(bh))) errors.push(`body_hash format invalid (must be 64 lowercase hex)`);

  const cd = payload.created_date;
  if (cd !== undefined) {
    if (!(typeof cd === "string" && ISO_DATE.test(cd))) errors.push(`created_date is not in YYYY-MM-DD form`);
    else if (!isRealCalendarDate(cd)) errors.push(`created_date is not a real calendar date`);
  }

  const scan: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(payload)) if (k !== "payload_hash") scan[k] = payload[k];
  const nums = findNumericPaths(scan);
  if (nums.length) {
    const shown = nums.length <= 5 ? nums : [...nums.slice(0, 5), "..."];
    errors.push(`bare numeric value(s) in payload (spec §5 requires strings): ${shown.join(", ")}`);
  }

  const parents = Array.isArray(payload.parents) ? payload.parents : [];
  parents.forEach((p, idx) => {
    if (isObj(p) && "payload_hash" in p) {
      const pph = p.payload_hash;
      if (typeof pph !== "string" || !HEX64.test(pph)) errors.push(`parents[${idx}].payload_hash format invalid`);
    }
  });

  if (blockCount > 1) warnings.push(`multiple payload blocks present (${blockCount}); evaluated the last block per spec §3.3`);

  for (const field of Object.keys(CANONICAL_VOCAB)) {
    const v = payload[field];
    if (typeof v !== "string" || CANONICAL_VOCAB[field].has(v)) continue;
    if (!v.includes(":") && !v.startsWith("ext-")) {
      warnings.push(`${field}: '${v}' is a custom vocabulary value without namespace prefix`);
    }
  }

  if (errors.length) return { level: "invalid", issues: [...errors, ...warnings] };
  if (warnings.length) return { level: "warnings", issues: warnings };
  return { level: "valid", issues: [] };
}

function unreadable(reason: string, blockCount: number, payload: Record<string, unknown> | null = null): LensResult {
  return {
    state: "unreadable", computed: null, stored: null, payload, missing: [],
    body: null, bodyVerified: null, conformance: "invalid", conformanceIssues: [reason],
    multipleBlocks: blockCount > 1, blockCount, reason,
  };
}

/* ---- reusable primitives (shared with the sealer, so seal == verify) ---- */

/** Canonical payload hash (spec §5), computed over the payload minus payload_hash. */
export async function payloadHashOf(payload: Record<string, unknown>): Promise<string> {
  const obj: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(payload)) if (k !== "payload_hash") obj[k] = payload[k];
  return sha256Hex(canonical(nfcNormalize(obj)));
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
  const markerIdx = raw.lastIndexOf(BODY_MARKER);
  if (markerIdx < 0) return null;
  const pre = raw.slice(0, markerIdx);
  const start = findBodyStart(pre);
  return start === null ? null : pre.slice(start);
}

/* ---- public entry point ---- */

export async function verify(raw: string): Promise<LensResult> {
  const blocks: string[] = [];
  const re = new RegExp(BLOCK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) blocks.push(m[1]);
  if (blocks.length === 0) return unreadable("no payload block found", 0);

  let payload: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Strict(blocks[blocks.length - 1]));
    const parsed = parseStrictJson(text);
    if (!isObj(parsed)) return unreadable(`payload is not a JSON object`, blocks.length);
    payload = parsed;
  } catch (e) {
    if (e instanceof DuplicateKeyError) return unreadable(`payload contains duplicate JSON key: ${e.message}`, blocks.length);
    return unreadable("payload could not be decoded or parsed", blocks.length);
  }

  if (findNfcCollisions(payload).length) return unreadable("payload keys collide under NFC normalization", blocks.length, payload);

  const sv = payload.spec_version;
  if (sv !== undefined && !(typeof sv === "string" && SUPPORTED_SPEC_VERSIONS.has(sv))) {
    const r = unreadable(`unsupported spec_version`, blocks.length, payload);
    r.conformanceIssues = [`unsupported spec_version (this verifier supports 1.0)`];
    return r;
  }

  const stored = typeof payload.payload_hash === "string" ? payload.payload_hash : "";
  const computed = await payloadHashOf(payload);

  const missing = REQUIRED.filter((f) => !(f in payload));
  const att = payload.attribution;
  const sourcesTruthy = isObj(att)
    ? (Array.isArray(att.sources) ? att.sources.length > 0 : !!att.sources)
    : false;
  if ("attribution" in payload && !(isObj(att) && sourcesTruthy)) missing.push("attribution.sources");

  let state: Status = computed === stored ? "verified" : "failed";
  const fm = parseFrontmatter(raw);

  let body: "match" | "mismatch" | null = null;
  let bodyVerified: BodyVerified = "omitted";
  if (state === "verified" && "body_hash" in payload && blocks.length === 1) {
    const markerIdx = raw.lastIndexOf(BODY_MARKER);
    if (markerIdx >= 0) {
      const pre = raw.slice(0, markerIdx);
      const bodyStart = findBodyStart(pre);
      if (bodyStart === null) {
        return unreadable("body_hash present but YAML frontmatter delimiters not found", blocks.length, payload);
      }
      const computedBody = await bodyHashOf(pre.slice(bodyStart));
      if (computedBody === payload.body_hash) { body = "match"; bodyVerified = "yes"; }
      else { body = "mismatch"; bodyVerified = "modified"; state = "verified-body-modified"; }
    }
  }

  const conf = checkConformance(payload, missing, fm.ok, fm.reason, fm.spec, blocks.length);

  return {
    state, computed, stored, payload, missing, body, bodyVerified,
    conformance: conf.level, conformanceIssues: conf.issues,
    multipleBlocks: blocks.length > 1, blockCount: blocks.length, reason: null,
  };
}
