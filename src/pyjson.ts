/**
 * pyjson.ts — JSON as lens.py's Python sees it.
 *
 * The strict parser, value model and canonical serializer behind lens-core.ts.
 * They reproduce what CPython's json module and repr() do with the same text, so
 * hashes, type names, quoted values and the order in which parse errors are
 * reported all match the reference verifier. No Obsidian imports.
 */

// JSON nesting guard. lens.py accepts payloads nested a few hundred levels deep
// (its limit is CPython's recursion limit); 512 keeps every such payload
// readable, as knobe-rs does, while bounding the recursion.
const MAX_DEPTH = 512;

/* ---- Python value model (lens.py parity) ----
 * Inside verify() a payload is held the way Python's json module holds it, so
 * hashing, type names and quoted values match lens.py exactly: objects are Maps
 * (insertion order, as a Python dict; a numeric-looking key does not move to
 * the front), floats are PyFloat (1.0 stays "1.0"), and integers beyond 2^53 are
 * BigInt (no digit lost). LensResult.payload is converted back to plain values. */

export class PyFloat {
  readonly n: number;
  constructor(n: number) { this.n = n; }
}

export type PyValue = null | boolean | number | bigint | string | PyFloat | PyValue[] | PyDict;
export type PyDict = Map<string, PyValue>;

export const isDict = (x: unknown): x is PyDict => x instanceof Map;

/** Python's type(x).__name__ for a parsed JSON value. */
export function pyTypeName(x: PyValue): string {
  if (x === null) return "NoneType";
  if (x instanceof PyFloat) return "float";
  if (Array.isArray(x)) return "list";
  if (isDict(x)) return "dict";
  if (typeof x === "string") return "str";
  if (typeof x === "boolean") return "bool";
  return "int"; // number (integers only; floats are PyFloat) or bigint
}

/** Python truthiness of a parsed JSON value. */
export function pyTruthy(x: PyValue | undefined): boolean {
  if (x === undefined || x === null || x === false) return false;
  if (x instanceof PyFloat) return x.n !== 0;
  if (typeof x === "number") return x !== 0;
  if (typeof x === "bigint") return x !== 0n;
  if (typeof x === "string" || Array.isArray(x)) return x.length > 0;
  if (isDict(x)) return x.size > 0;
  return true;
}

/** Python's float repr(), which json.dumps uses: shortest round-trip digits,
 *  always a decimal point or an exponent, fixed notation for 1e-4 <= |x| < 1e16. */
function pyFloatRepr(x: number): string {
  if (Object.is(x, -0)) return "-0.0";
  const m = x.toExponential().match(/^(-?)(\d)(?:\.(\d+))?e([+-])(\d+)$/);
  if (!m) throw new Error("non-finite number has no canonical form");
  const [, sign, lead, frac = "", esign, edigits] = m;
  const e10 = (esign === "-" ? -1 : 1) * parseInt(edigits, 10);
  if (e10 >= 16 || e10 < -4) {
    return `${sign}${frac ? `${lead}.${frac}` : lead}e${e10 < 0 ? "-" : "+"}${String(Math.abs(e10)).padStart(2, "0")}`;
  }
  const digits = lead + frac;
  if (e10 < 0) return `${sign}0.${"0".repeat(-e10 - 1)}${digits}`;
  if (e10 + 1 >= digits.length) return `${sign}${digits.padEnd(e10 + 1, "0")}.0`;
  return `${sign}${digits.slice(0, e10 + 1)}.${digits.slice(e10 + 1)}`;
}

/** A JS number as Python sees the JSON text JSON.stringify writes for it: an
 *  integer below 1e21 is written in plain digits (a Python int), the same digits
 *  String() gives (not BigInt's exact binary value); anything else is a Python
 *  float. Non-finite numbers are written as null, as JSON.stringify does, so a
 *  sealer's hash matches the text it emits. */
function pyNumberRepr(x: number): string {
  if (!Number.isFinite(x)) return "null";
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return Object.is(x, -0) ? "0" : String(x);
  return pyFloatRepr(x);
}

// Python's repr() escapes non-printable characters: categories Cc, Cf, Cs, Co,
// Cn, Zl, Zp and Zs (except the ASCII space).
const PY_NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

export const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

/** Python's repr() of a str. */
export function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const o = ch.codePointAt(0) as number;
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (o < 0x20 || o === 0x7f) out += "\\x" + hex(o, 2);
    else if (o < 0x7f || !PY_NON_PRINTABLE.test(ch)) out += ch;
    else if (o <= 0xff) out += "\\x" + hex(o, 2);
    else if (o <= 0xffff) out += "\\u" + hex(o, 4);
    else out += "\\U" + hex(o, 8);
  }
  return out + quote;
}

/** Python's repr() of a parsed JSON value. */
export function pyRepr(x: PyValue): string {
  if (x === null) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (x instanceof PyFloat) return pyFloatRepr(x.n);
  if (typeof x === "number") return pyNumberRepr(x);
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "string") return pyStrRepr(x);
  if (Array.isArray(x)) return "[" + x.map(pyRepr).join(", ") + "]";
  return "{" + [...x].map(([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`).join(", ") + "}";
}

/** Python's str() of a parsed JSON value. */
export const pyStr = (x: PyValue): string => (typeof x === "string" ? x : pyRepr(x));

/** Plain JS values for LensResult.payload: null-prototype objects, numbers. */
export function toPlain(x: PyValue): unknown {
  if (x instanceof PyFloat) return x.n;
  if (typeof x === "bigint") return Number(x);
  if (Array.isArray(x)) return x.map(toPlain);
  if (isDict(x)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of x) out[k] = toPlain(v);
    return out;
  }
  return x;
}

/* ---- strict JSON parse, as lens.py's json.loads hooks report it ---- */

export class DuplicateKeyError extends Error {
  readonly key: string;
  constructor(key: string) { super("duplicate key"); this.key = key; }
}
/** NaN, Infinity, -Infinity, or a float that overflows (1e400): no canonical form. */
export class NonJSONConstantError extends Error {}

export function parseStrictJson(text: string): PyValue {
  let i = 0;
  const n = text.length;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const ws = () => { while (i < n && isWs(text[i])) i++; };
  const numRe = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

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
          const h = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new SyntaxError("bad unicode escape");
          out += String.fromCharCode(parseInt(h, 16));
          i += 4;
        } else throw new SyntaxError("bad escape");
      } else if (c.charCodeAt(0) < 0x20) {
        throw new SyntaxError("control character in string");
      } else out += c;
    }
  }
  // Maps, not objects: a "__proto__" key is an ordinary key (so it is hashed and
  // the seal correctly fails), not a prototype mutation. A duplicate key is
  // reported when its object closes, as lens.py's object_pairs_hook does, so an
  // error later in the same object (NaN, 1e400, bad syntax) is reported first.
  function parseObject(depth: number): PyDict {
    i++; // {
    const obj: PyDict = new Map();
    let duplicate: string | null = null;
    ws();
    if (text[i] === "}") { i++; return obj; }
    for (;;) {
      ws();
      if (text[i] !== '"') throw new SyntaxError("expected object key");
      const key = parseString();
      if (duplicate === null && obj.has(key)) duplicate = key;
      ws();
      if (text[i] !== ":") throw new SyntaxError("expected ':'");
      i++;
      obj.set(key, parseValue(depth + 1));
      ws();
      const ch = text[i];
      if (ch === ",") { i++; continue; }
      if (ch === "}") {
        i++;
        if (duplicate !== null) throw new DuplicateKeyError(duplicate);
        return obj;
      }
      throw new SyntaxError("expected ',' or '}'");
    }
  }
  function parseArray(depth: number): PyValue[] {
    i++; // [
    const arr: PyValue[] = [];
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
  function parseValue(depth: number): PyValue {
    if (depth > MAX_DEPTH) throw new SyntaxError("JSON nesting too deep"); // DoS guard
    ws();
    if (i >= n) throw new SyntaxError("unexpected end of input");
    const c = text[i];
    if (c === "{") return parseObject(depth);
    if (c === "[") return parseArray(depth);
    if (c === '"') return parseString();
    if (text.startsWith("NaN", i) || text.startsWith("Infinity", i) || text.startsWith("-Infinity", i)) {
      throw new NonJSONConstantError("non-JSON constant");
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      numRe.lastIndex = i;
      const m = numRe.exec(text);
      if (!m) throw new SyntaxError("bad number");
      i += m[0].length;
      if (m[1] === undefined && m[2] === undefined) {
        const int = Number(m[0]);
        return Number.isSafeInteger(int) ? int : BigInt(m[0]);
      }
      const float = Number(m[0]);
      if (!Number.isFinite(float)) throw new NonJSONConstantError("float overflow");
      return new PyFloat(float);
    }
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    throw new SyntaxError("unexpected token");
  }

  const value = parseValue(0);
  ws();
  if (i !== n) throw new SyntaxError("trailing content after JSON value");
  return value;
}

/* ---- canonicalization (spec §5) ---- */

function cmpCodePoint(a: string, b: string): number {
  const ai = Array.from(a), bi = Array.from(b);
  const len = Math.min(ai.length, bi.length);
  for (let k = 0; k < len; k++) {
    const d = (ai[k].codePointAt(0) as number) - (bi[k].codePointAt(0) as number);
    if (d !== 0) return d;
  }
  return ai.length - bi.length;
}

/** json.dumps(nfc(x), sort_keys=True, separators=(",", ":"), ensure_ascii=False).
 *  Takes a parsed payload (Maps, PyFloat, BigInt) or plain values from a sealer. */
export function canonical(x: unknown): string {
  if (x === null) return "null";
  if (x instanceof PyFloat) return pyFloatRepr(x.n);
  if (typeof x === "boolean") return x ? "true" : "false";
  if (typeof x === "number") return pyNumberRepr(x); // payload numerics SHOULD be strings (§5)
  if (typeof x === "bigint") return x.toString();
  // JSON.stringify escapes exactly what Python's json does for well-formed text (ERRATA E8).
  if (typeof x === "string") return JSON.stringify(x.normalize("NFC"));
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  const entries: [string, unknown][] = isDict(x)
    ? [...x].map(([k, v]) => [k.normalize("NFC"), v])
    : Object.keys(x as object).map((k) => [k.normalize("NFC"), (x as Record<string, unknown>)[k]]);
  entries.sort((a, b) => cmpCodePoint(a[0], b[0]));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
}
