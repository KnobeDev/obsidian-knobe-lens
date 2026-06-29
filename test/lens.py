#!/usr/bin/env python3
"""lens.py — KNOBE Protocol v1 reference verifier.

Usage: python3 lens.py [--json] file.knobe.md
       python3 lens.py --help

Reports two independent dimensions:
  status (integrity):
    verified                payload_hash matches; body_hash matches or absent
    verified-body-modified  payload_hash matches; body_hash present and mismatched
    failed                  payload_hash mismatch
    unreadable              no payload block; payload cannot be decoded/parsed;
                            payload is not a JSON object; payload keys are
                            ambiguous (duplicate or NFC-colliding); or the file
                            declares a spec_version this verifier does not support

  conformance (schema/spec compliance):
    valid                   all required fields present and well-typed, formats
                            well-formed, no normative MUSTs violated
    warnings                file is usable, but soft-spec deviations detected
                            (e.g., custom vocabulary without namespace, or more
                            than one payload block)
    invalid                 normative MUSTs violated (e.g., missing/malformed
                            frontmatter, malformed payload_hash or body_hash,
                            bare numeric values, impossible created_date,
                            wrong field types)

A match proves integrity, not truth. A `valid` proves conformance, not truth.
Inspect before trusting.

Canonical hash rule (spec §5): decode the Base64 payload to JSON; remove
payload_hash; NFC-normalize all JSON object keys and string values recursively;
serialize with keys recursively sorted, no whitespace, arrays in insertion
order, literal UTF-8 (never \\uXXXX); SHA-256; compare to stored payload_hash.
This algorithm is frozen for v1 and is unchanged by the conformance/robustness
checks below — a file that verified before this verifier was hardened produces
the identical payload_hash now.

Numeric payload values MUST be JSON strings (spec §5). lens.py detects bare
numbers in payloads and reports them as `conformance: invalid`.

Body normalization (for the optional body_hash): extract the body between the
closing '---' line of the YAML frontmatter and the BEGIN marker; (0) strip the
whole body of leading/trailing whitespace; (1) CRLF and lone CR -> LF; (2) strip
only U+0020 and U+0009 from each line end; (3) no Unicode normalization;
(4) UTF-8; (5) SHA-256.

Multi-block files (spec §3.3, §6): when more than one payload block is present,
the LAST well-formed block is evaluated, body_verified MUST be omitted (body
extraction is ambiguous across multiple BEGIN markers), and conformance is at
least `warnings`.

Exit codes:
  0  status verified or verified-body-modified AND conformance valid or warnings
  1  status verified/verified-body-modified but conformance invalid, OR status failed
  2  status unreadable, OR a usage/file error
"""
import sys, re, json, base64, hashlib, unicodedata, datetime

SUPPORTED_SPEC_VERSIONS = {"1.0"}

REQUIRED = ["spec_version","title","summary","content_type","created_date",
            "license","privacy_level","quarantine_status","attribution","payload_hash"]

# Required fields that MUST be JSON strings (spec §4). attribution is an object
# and is validated structurally; payload_hash has its own HEX64 check.
STRING_FIELDS = ["spec_version","title","summary","content_type","created_date",
                 "license","privacy_level","quarantine_status"]

# Vocabulary canonical values (spec §8). Custom values are not invalid, but
# trigger a `warnings` conformance level if they are not prefix-namespaced.
CANONICAL_VOCAB = {
    "content_type": {"original","synthesis","adaptation","compression",
                     "annotation","seed","collection","translation"},
    "quarantine_status": {"quarantine","trusted","rejected"},
    "privacy_level": {"public","internal","sensitive","restricted"},
    "identity_status": {"declared","signed"},
}
ISO_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')


class DuplicateKeyError(ValueError):
    """Raised when a JSON object contains the same key more than once."""


class NonJSONConstantError(ValueError):
    """Raised for NaN / Infinity / -Infinity tokens (not valid JSON)."""


def _no_duplicate_keys(pairs):
    """object_pairs_hook: reject duplicate keys at any nesting level."""
    seen = {}
    for k, v in pairs:
        if k in seen:
            raise DuplicateKeyError(k)
        seen[k] = v
    return seen


def _reject_constant(token):
    raise NonJSONConstantError(token)


def normalize_body(text):
    text = text.strip()
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    return '\n'.join(line.rstrip(' \t') for line in text.split('\n'))


def find_numeric_paths(obj, path=""):
    """Return paths of bare numeric values in payload (spec §5 violations)."""
    out = []
    if isinstance(obj, bool):
        return out
    if isinstance(obj, (int, float)):
        out.append(path)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            out.extend(find_numeric_paths(v, f"{path}.{k}" if path else k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.extend(find_numeric_paths(v, f"{path}[{i}]"))
    return out


def find_nfc_collisions(obj, path=""):
    """Return paths where two distinct object keys collapse to the same key
    after NFC normalization. Such payloads cannot be canonicalized
    unambiguously (the §5 hash rule normalizes keys), so they are rejected."""
    out = []
    if isinstance(obj, dict):
        norm_to_orig = {}
        for k in obj.keys():
            nk = unicodedata.normalize("NFC", k) if isinstance(k, str) else k
            if nk in norm_to_orig and norm_to_orig[nk] != k:
                where = f"{path}.{k}" if path else str(k)
                out.append(f"{where!r} collides with {norm_to_orig[nk]!r} under NFC")
            else:
                norm_to_orig.setdefault(nk, k)
        for k, v in obj.items():
            out.extend(find_nfc_collisions(v, f"{path}.{k}" if path else str(k)))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.extend(find_nfc_collisions(v, f"{path}[{i}]"))
    return out


def safe(value, limit=300):
    """Render a (possibly payload-derived) value safely for terminal output:
    escape C0/C1 control characters and DEL so a crafted string cannot spoof
    the report or inject ANSI escape sequences. Non-strings -> repr."""
    if not isinstance(value, str):
        return repr(value)
    out = []
    for ch in value:
        o = ord(ch)
        if o < 0x20 or o == 0x7f or 0x80 <= o <= 0x9f:
            out.append(f"\\x{o:02x}")
        else:
            out.append(ch)
    rendered = "".join(out)
    if len(rendered) > limit:
        rendered = rendered[:limit] + "…"
    return rendered


def parse_frontmatter(raw):
    """Return (ok, fm_spec, reason). ok is True only when a YAML frontmatter
    block is present: the first line is exactly '---' and a later line is
    exactly '---'. fm_spec is the frontmatter's declared spec_version if found
    before the closing delimiter."""
    if raw.startswith('﻿'):
        raw = raw[1:]
    lines = raw.split('\n')
    if not lines or lines[0].rstrip('\r') != '---':
        return (False, None, "missing opening '---' frontmatter delimiter")
    fm_spec = None
    for i in range(1, len(lines)):
        if lines[i].rstrip('\r') == '---':
            return (True, fm_spec, None)
        m = re.match(r'\s*spec_version\s*:\s*(.+?)\s*$', lines[i].rstrip('\r'))
        if m and fm_spec is None:
            fm_spec = m.group(1).strip().strip('"\'')
    return (False, fm_spec, "missing closing '---' frontmatter delimiter")


def _find_body_start(pre):
    """Given the text before the last BEGIN marker, return the offset where the
    body begins: immediately after the closing '---' frontmatter line. Line-
    exact (a '---' must occupy its own line), so a '---' substring inside a
    value is not mistaken for the delimiter. Returns None if no frontmatter."""
    if not (pre.startswith('---\n') or pre.startswith('---\r\n')):
        return None
    idx = pre.index('\n') + 1            # start of line 2
    while True:
        nl = pre.find('\n', idx)
        line = pre[idx:nl] if nl != -1 else pre[idx:]
        if line.rstrip('\r') == '---':
            return (nl + 1) if nl != -1 else len(pre)
        if nl == -1:
            return None
        idx = nl + 1


def _unreadable(reason, blocks, payload=None):
    n = len(blocks)
    return {"state": "unreadable", "reason": reason,
            "conformance": "invalid", "conformance_issues": [reason],
            "multiple_blocks": n > 1, "block_count": n, "block_used": n,
            "computed": None, "stored": None, "payload": payload,
            "body_verified": None, "body": None, "missing": []}


def check_conformance(payload, missing, fm_ok, fm_reason, fm_spec, block_count):
    """Return (level, issues): level is 'valid', 'warnings', or 'invalid'."""
    errors = []      # -> invalid
    warnings = []    # -> warnings (only surfaced if no errors)

    # 1. Frontmatter presence (independent of body_hash). spec requires a YAML
    #    frontmatter block; without it the file is not a conformant KNOBE.
    if not fm_ok:
        errors.append(f"YAML frontmatter missing or malformed: {fm_reason}")
    elif (fm_spec is not None and isinstance(payload.get("spec_version"), str)
          and fm_spec != payload.get("spec_version")):
        warnings.append(f"frontmatter spec_version {fm_spec!r} does not match "
                        f"sealed payload spec_version {payload.get('spec_version')!r}")

    # 2. Missing required fields -> invalid
    for m in missing:
        errors.append(f"required field missing: {m}")

    # 3. Required-field types (spec §4): listed fields MUST be strings.
    for field in STRING_FIELDS:
        if field in payload and not isinstance(payload[field], str):
            errors.append(f"required field {field} must be a string, "
                          f"got {type(payload[field]).__name__}")

    # 4. attribution structure: object with a non-empty sources array.
    att = payload.get("attribution")
    if att is not None:
        if not isinstance(att, dict):
            errors.append(f"attribution must be an object, got {type(att).__name__}")
        else:
            src = att.get("sources")
            if src is not None and not isinstance(src, list):
                errors.append(f"attribution.sources must be an array, "
                              f"got {type(src).__name__}")
            elif isinstance(src, list) and len(src) == 0:
                errors.append("attribution.sources must be a non-empty array")

    # 5. payload_hash format (spec §4)
    ph = payload.get("payload_hash")
    if ph is not None and not (isinstance(ph, str) and HEX64.match(ph)):
        errors.append("payload_hash format invalid (must be 64 lowercase hex)")

    # 6. body_hash format if present (spec §4)
    bh = payload.get("body_hash")
    if bh is not None and not (isinstance(bh, str) and HEX64.match(bh)):
        errors.append("body_hash format invalid (must be 64 lowercase hex)")

    # 7. created_date: ISO shape AND a real calendar date (spec §4)
    cd = payload.get("created_date")
    if cd is not None:
        if not (isinstance(cd, str) and ISO_DATE.match(cd)):
            errors.append(f"created_date is not in YYYY-MM-DD form: {cd!r}")
        else:
            try:
                datetime.date.fromisoformat(cd)
            except ValueError:
                errors.append(f"created_date is not a real calendar date: {cd!r}")

    # 8. Numeric values (spec §5 — all numerics MUST be strings)
    obj_for_scan = {k: v for k, v in payload.items() if k != "payload_hash"}
    numeric_paths = find_numeric_paths(obj_for_scan)
    if numeric_paths:
        shown = numeric_paths if len(numeric_paths) <= 5 else numeric_paths[:5] + ["..."]
        errors.append(f"bare numeric value(s) in payload (spec §5 requires strings): "
                      f"{', '.join(shown)}")

    # 9. Parent hash format (spec §4)
    for i, parent in enumerate(payload.get("parents", []) or []):
        if isinstance(parent, dict) and "payload_hash" in parent:
            pph = parent["payload_hash"]
            if not isinstance(pph, str) or not HEX64.match(pph):
                errors.append(f"parents[{i}].payload_hash format invalid "
                              f"(must be 64 lowercase hex)")

    # 10. Multiple payload blocks (spec §3.3) -> warnings
    if block_count > 1:
        warnings.append(f"multiple payload blocks present ({block_count}); "
                        f"evaluated the last block per spec §3.3")

    # 11. Vocabulary — custom values without namespace -> warnings only
    for field, canon in CANONICAL_VOCAB.items():
        v = payload.get(field)
        if v is None or not isinstance(v, str) or v in canon:
            continue
        if ":" not in v and not v.startswith("ext-"):
            warnings.append(f"{field}: {v!r} is a custom vocabulary value without "
                            f"namespace prefix (recommend 'ext-' or 'domain:' per §8)")

    if errors:
        return ("invalid", errors + warnings)
    if warnings:
        return ("warnings", warnings)
    return ("valid", [])


def verify(path):
    # --- read the file safely (clean errors, never a stack trace) ---
    try:
        with open(path, "rb") as fh:
            raw_bytes = fh.read()
    except FileNotFoundError:
        return _unreadable(f"file not found: {path}", [])
    except IsADirectoryError:
        return _unreadable(f"path is a directory, not a file: {path}", [])
    except OSError as e:
        return _unreadable(f"could not read file: {e}", [])
    try:
        raw = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as e:
        return _unreadable(f"file is not valid UTF-8: {e}", [])

    blocks = re.findall(
        r'(?:^|\n)-----BEGIN KNOBE B64-----\n(.*?)\n-----END KNOBE B64-----',
        raw, re.DOTALL)
    if not blocks:
        return _unreadable("no payload block found", blocks)

    # --- decode + parse the last block, rejecting ambiguous/illegal JSON ---
    try:
        decoded = base64.b64decode("".join(blocks[-1].split()), validate=True)
        text = decoded.decode("utf-8")
        payload = json.loads(text, object_pairs_hook=_no_duplicate_keys,
                             parse_constant=_reject_constant)
    except DuplicateKeyError as e:
        return _unreadable(f"payload contains duplicate JSON key: {safe(str(e))} "
                           f"(ambiguous; rejected)", blocks)
    except NonJSONConstantError:
        return _unreadable("payload contains a non-JSON numeric constant "
                           "(NaN/Infinity); rejected", blocks)
    except Exception:
        return _unreadable("payload could not be decoded or parsed", blocks)

    # P0-2: payload MUST be a JSON object
    if not isinstance(payload, dict):
        return _unreadable(f"payload is not a JSON object "
                           f"(got {type(payload).__name__})", blocks)

    # P0-4: NFC key collisions make canonicalization ambiguous -> reject
    collisions = find_nfc_collisions(payload)
    if collisions:
        return _unreadable("payload keys collide under NFC normalization: "
                           + "; ".join(collisions[:5]), blocks)

    # P0-5: unsupported spec_version -> unreadable (cannot honestly verify a
    # file sealed under semantics this v1 verifier does not implement).
    sv = payload.get("spec_version")
    if sv is not None and sv not in SUPPORTED_SPEC_VERSIONS:
        r = _unreadable(f"unsupported spec_version: {safe(str(sv))}", blocks, payload=payload)
        r["conformance_issues"] = [
            f"unsupported spec_version: {safe(str(sv))} "
            f"(this verifier supports {sorted(SUPPORTED_SPEC_VERSIONS)})"]
        return r

    # --- canonical hash (spec §5) — FROZEN, unchanged from v1 ---
    stored = payload.get("payload_hash", "")
    obj = {k: v for k, v in payload.items() if k != "payload_hash"}

    def nfc_normalize(x):
        if isinstance(x, str):
            return unicodedata.normalize("NFC", x)
        if isinstance(x, dict):
            return {unicodedata.normalize("NFC", k) if isinstance(k, str) else k:
                    nfc_normalize(v) for k, v in x.items()}
        if isinstance(x, list):
            return [nfc_normalize(v) for v in x]
        return x
    obj = nfc_normalize(obj)

    canon = json.dumps(obj, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=False, allow_nan=False)
    computed = hashlib.sha256(canon.encode("utf-8")).hexdigest()

    # --- required-field presence ---
    missing = [f for f in REQUIRED if f not in payload]
    if "attribution" in payload and not (
            isinstance(payload["attribution"], dict)
            and payload["attribution"].get("sources")):
        missing.append("attribution.sources")

    state = "verified" if computed == stored else "failed"

    # --- frontmatter (validated regardless of body_hash presence) ---
    fm_ok, fm_spec, fm_reason = parse_frontmatter(raw)

    # --- body_verified: yes / modified / omitted ---
    # Omitted when: multiple blocks (ambiguous extraction), no body_hash, or
    # the payload did not verify (untrusted).
    body_result = None
    body_verified = "omitted"
    if state == "verified" and "body_hash" in payload and len(blocks) == 1:
        b64_marker = '\n-----BEGIN KNOBE B64-----\n'
        pre = raw[:raw.rindex(b64_marker)]
        body_start = _find_body_start(pre)
        if body_start is None:
            return _unreadable("body_hash present but YAML frontmatter "
                               "delimiters not found", blocks, payload=payload)
        body_text = pre[body_start:]
        computed_body = hashlib.sha256(
            normalize_body(body_text).encode("utf-8")).hexdigest()
        if computed_body == payload["body_hash"]:
            body_result, body_verified = "match", "yes"
        else:
            body_result, body_verified = "mismatch", "modified"
            state = "verified-body-modified"

    conformance, issues = check_conformance(
        payload, missing, fm_ok, fm_reason, fm_spec, len(blocks))

    return {"state": state, "computed": computed, "stored": stored,
            "payload": payload, "missing": missing, "body": body_result,
            "body_verified": body_verified,
            "conformance": conformance, "conformance_issues": issues,
            "multiple_blocks": len(blocks) > 1,
            "block_count": len(blocks), "block_used": len(blocks),
            "reason": None}


def _exit_code(r):
    st = r["state"]
    if st == "unreadable":
        return 2
    if st in ("verified", "verified-body-modified") and r["conformance"] in ("valid", "warnings"):
        return 0
    return 1


def _print_human(r):
    st = r["state"]
    if st == "unreadable":
        print(f"status:            unreadable ({safe(str(r.get('reason')))})")
        print(f"conformance:       {r['conformance']}")
        for issue in r.get("conformance_issues", []):
            print(f"  - {issue}")
        return _exit_code(r)

    p = r["payload"]
    print(f"title:             {safe(p.get('title'))}")
    print(f"spec_version:      {safe(str(p.get('spec_version')))}")
    print(f"quarantine_status: {safe(str(p.get('quarantine_status')))}")
    print(f"privacy_level:     {safe(str(p.get('privacy_level')))}")
    print(f"computed_hash:     {r['computed']}")
    print(f"stored_hash:       {r['stored']}")
    print(f"status:            {st}")
    if r["multiple_blocks"]:
        print(f"WARNING:           multiple payload blocks present. Evaluated "
              f"block {r['block_used']} of {r['block_count']} per spec §3.3.")
    print(f"body_verified:     {r['body_verified']}")
    print(f"conformance:       {r['conformance']}")
    for issue in r["conformance_issues"]:
        print(f"  - {issue}")
    if st in ("verified", "verified-body-modified"):
        print("note: integrity verified. Integrity is not truth — inspect before trusting.")
    if st == "verified-body-modified":
        print("note: the markdown body differs from the sealed body. "
              "Inspect before relying on this version.")
    return _exit_code(r)


USAGE = "usage: python3 lens.py [--json] FILE.knobe.md"

if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        sys.exit(0)
    as_json = False
    if args and args[0] == "--json":
        as_json, args = True, args[1:]
    if len(args) != 1:
        print(USAGE, file=sys.stderr)
        sys.exit(2)

    r = verify(args[0])
    if as_json:
        out = {k: r.get(k) for k in (
            "state", "computed", "stored", "body_verified", "conformance",
            "conformance_issues", "multiple_blocks", "block_count",
            "block_used", "reason")}
        print(json.dumps(out, indent=2, ensure_ascii=False))
        sys.exit(_exit_code(r))
    sys.exit(_print_human(r))
