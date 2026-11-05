#!/usr/bin/env python3
"""Generate the lens.py parity fixture: a battery of crafted KNOBE files and
what the reference verifier (lens.py) reports for each.

    python3 gen_lens_parity.py /path/to/lens.py OUT.json [--human] [--label TEXT]

Every file is sealed with lens.py's own hash rules (never with the code under
test), then run through `python3 lens.py --json` (and, with --human, the
default human-readable mode). The output records the file bytes (base64), the
--json report, the exit code and, optionally, the human report.

The battery is a Python port of knobe-rs's tests/lens_parity.rs hostile cases
(122), plus cases for display escaping, the order in which parse errors are
reported, and nesting depth. Regenerate whenever upstream lens.py changes.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unicodedata


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    human = "--human" in sys.argv
    label = None
    if "--label" in sys.argv:
        label = sys.argv[sys.argv.index("--label") + 1]
        args.remove(label)
    if len(args) != 2:
        sys.exit(__doc__)
    lens_path, out_path = args
    sys.path.insert(0, os.path.dirname(os.path.abspath(lens_path)))
    import lens  # noqa: E402  (the oracle's own body normalization)

    cases = build_cases(lens)
    out = {"oracle": label or os.path.abspath(lens_path), "cases": []}
    with tempfile.TemporaryDirectory() as tmp:
        for name, data in cases:
            path = os.path.join(tmp, name + ".knobe.md")
            with open(path, "wb") as fh:
                fh.write(data)
            j = subprocess.run([sys.executable, lens_path, "--json", path],
                               capture_output=True)
            try:
                report = json.loads(j.stdout.decode("utf-8"))
            except ValueError:
                sys.exit(f"{name}: lens.py produced no JSON report (a lens.py without "
                         f"the display-escaping fix to safe() crashes on x-dup-key-surrogate):\n"
                         f"{j.stderr.decode('utf-8', 'replace')}")
            case = {"name": name, "file_b64": base64.b64encode(data).decode("ascii"),
                    "exit": j.returncode, "lens": report}
            if human:
                h = subprocess.run([sys.executable, lens_path, path], capture_output=True)
                if h.returncode != j.returncode:
                    sys.exit(f"{name}: human mode exit {h.returncode} != --json exit "
                             f"{j.returncode}:\n{h.stderr.decode('utf-8', 'replace')}")
                case["human"] = h.stdout.decode("utf-8").replace(path, "<FILE>")
            out["cases"].append(case)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=True)
        fh.write("\n")
    print(f"{len(cases)} cases -> {out_path}")


# --- builders (mirroring knobe-rs tests/lens_parity.rs) ----------------------

FM = '---\ntitle: "T"\nspec_version: "1.0"\n---\n'
BASE = ('"spec_version":"1.0","title":"T","summary":"S","content_type":"original",'
        '"created_date":"2026-01-02","license":"CC0-1.0","privacy_level":"public",'
        '"quarantine_status":"quarantine","attribution":{"sources":[{"author":"A"}]}')
BEGIN, END = "-----BEGIN KNOBE B64-----", "-----END KNOBE B64-----"


def _nfc(x):
    if isinstance(x, str):
        return unicodedata.normalize("NFC", x)
    if isinstance(x, dict):
        return {unicodedata.normalize("NFC", k): _nfc(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_nfc(v) for v in x]
    return x


def payload_hash(text):
    # Hostile fixtures may be unparseable or uncanonicalizable on purpose; the
    # file is then unreadable or failed whatever hash is written.
    try:
        p = json.loads(text.lstrip("﻿"), strict=False)
        p.pop("payload_hash", None)
        canon = json.dumps(_nfc(p), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(canon.encode("utf-8", "surrogatepass")).hexdigest()
    except Exception:  # noqa: BLE001
        return "0" * 64


def b64(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return base64.b64encode(data).decode("ascii")


def split_top_level(s):
    out, depth, start, in_str, esc = [], 0, 0, False, False
    for i, c in enumerate(s):
        if esc:
            esc = False
        elif c == "\\" and in_str:
            esc = True
        elif c == '"':
            in_str = not in_str
        elif c in "{[" and not in_str:
            depth += 1
        elif c in "}]" and not in_str:
            depth -= 1
        elif c == "," and not in_str and depth == 0:
            out.append(s[start:i])
            start = i + 1
    out.append(s[start:])
    return out


def obj(extra=""):
    return "{" + BASE + ("," + extra if extra else "") + ',"payload_hash":"__H__"}'


def obj_without(drop, extra=""):
    fields = [f for f in split_top_level(BASE) if not f.startswith(f'"{drop}"')]
    body = ",".join(fields)
    if extra:
        body = f"{body},{extra}" if body else extra
    return "{" + body + ',"payload_hash":"__H__"}'


def flip_trailing_bits(b):
    pad = len(b) - len(b.rstrip("="))
    assert pad > 0, "need padded input to have spare bits"
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    i = len(b) - pad - 1
    return b[:i] + alphabet[alphabet.index(b[i]) | 1] + b[i + 1:]


def build_cases(lens):
    def body_hash(text):
        return hashlib.sha256(lens.normalize_body(text).encode("utf-8")).hexdigest()

    def sealed(payload, body):
        p = payload.replace("__B__", body_hash(body))
        if "__H__" in p:
            p = p.replace("__H__", payload_hash(p.replace('"__H__"', "null")))
        return p

    def block(text):
        return f"\n{BEGIN}\n{b64(text)}\n{END}\n"

    def knobe(fm, body, payload):
        return (fm + body + block(sealed(payload, body))).encode("utf-8")

    def raw(s):
        return s.encode("utf-8")

    hx = "a" * 64
    body = "\nHello body.\n"
    bh = '"body_hash":"__B__"'
    no_ph = ',"payload_hash":"__H__"'
    c = [
        ("baseline", knobe(FM, "", obj())),
        ("baseline-with-body", knobe(FM, body, obj(bh))),
        # hash format: exactly 64 lowercase hex, nothing following (ERRATA E12)
        ("payload-hash-trailing-newline", knobe(FM, "", obj_without(
            "payload_hash", f'"payload_hash":"{hx}\\n"').replace(no_ph, ""))),
        ("body-hash-trailing-newline", knobe(FM, body, obj(f'"body_hash":"{hx}\\n"'))),
        ("parent-hash-trailing-newline", knobe(FM, "", obj(
            f'"parents":[{{"title":"p","payload_hash":"{hx}\\n"}}]'))),
        ("parent-hash-uppercase", knobe(FM, "", obj(
            f'"parents":[{{"title":"p","payload_hash":"{"A" * 64}"}}]'))),
        ("parent-hash-missing-ok", knobe(FM, "", obj('"parents":[{"title":"p"},"x",null]'))),
        ("parents-not-a-list", knobe(FM, "", obj('"parents":{"payload_hash":"zz"}'))),
        ("payload-hash-missing", knobe(FM, "", obj_without("payload_hash").replace(no_ph, ""))),
        ("payload-hash-null", knobe(FM, "", obj().replace('"__H__"', "null"))),
        ("payload-hash-number", knobe(FM, "", obj().replace('"__H__"', "5"))),
        ("body-hash-null", knobe(FM, body, obj('"body_hash":null'))),
        ("body-hash-number", knobe(FM, body, obj('"body_hash":7'))),
        # created_date
        ("date-feb-29-nonleap", knobe(FM, "", obj_without("created_date", '"created_date":"2026-02-29"'))),
        ("date-feb-29-leap", knobe(FM, "", obj_without("created_date", '"created_date":"2024-02-29"'))),
        ("date-year-zero", knobe(FM, "", obj_without("created_date", '"created_date":"0000-01-01"'))),
        ("date-arabic-indic-digits", knobe(FM, "", obj_without(
            "created_date", '"created_date":"٢٠٢٦-01-01"'))),
        ("date-trailing-newline", knobe(FM, "", obj_without("created_date", '"created_date":"2026-01-01\\n"'))),
        ("date-short-month", knobe(FM, "", obj_without("created_date", '"created_date":"2026-1-01"'))),
        ("date-number", knobe(FM, "", obj_without("created_date", '"created_date":20260101'))),
        # attribution / sources truthiness
        ("sources-empty-list", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":[]}'))),
        ("sources-empty-object", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":{}}'))),
        ("sources-nonempty-object", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":{"a":1}}'))),
        ("sources-string", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":"x"}'))),
        ("sources-empty-string", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":""}'))),
        ("sources-zero", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":0}'))),
        ("sources-zero-float", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":0.0}'))),
        ("sources-true", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":true}'))),
        ("sources-null", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":null}'))),
        ("sources-absent", knobe(FM, "", obj_without("attribution", '"attribution":{}'))),
        ("attribution-string", knobe(FM, "", obj_without("attribution", '"attribution":"me"'))),
        ("attribution-null", knobe(FM, "", obj_without("attribution", '"attribution":null'))),
        ("attribution-list", knobe(FM, "", obj_without("attribution", '"attribution":[{"sources":[1]}]'))),
        # string-typed required fields
        ("title-number", knobe(FM, "", obj_without("title", '"title":5'))),
        ("title-bool", knobe(FM, "", obj_without("title", '"title":true'))),
        ("title-null", knobe(FM, "", obj_without("title", '"title":null'))),
        ("summary-list", knobe(FM, "", obj_without("summary", '"summary":[]'))),
        ("license-object", knobe(FM, "", obj_without("license", '"license":{}'))),
        ("summary-missing", knobe(FM, "", obj_without("summary"))),
        # spec_version
        ("spec-version-float", knobe(FM, "", obj_without("spec_version", '"spec_version":1.0'))),
        ("spec-version-2", knobe(FM, "", obj_without("spec_version", '"spec_version":"2.0"'))),
        ("spec-version-null", knobe(FM, "", obj_without("spec_version", '"spec_version":null'))),
        ("spec-version-padded", knobe(FM, "", obj_without("spec_version", '"spec_version":"1.0 "'))),
        ("spec-version-missing", knobe(FM, "", obj_without("spec_version"))),
        # vocabulary
        ("vocab-custom-bare", knobe(FM, "", obj_without("content_type", '"content_type":"custom"'))),
        ("vocab-ext-prefix", knobe(FM, "", obj_without("content_type", '"content_type":"ext-custom"'))),
        ("vocab-namespaced", knobe(FM, "", obj_without("privacy_level", '"privacy_level":"acme:secret"'))),
        ("vocab-identity-status", knobe(FM, "", obj('"identity_status":"vibes"'))),
        ("vocab-non-string", knobe(FM, "", obj('"identity_status":["signed"]'))),
        # numbers: the hash must still match (ERRATA E1); conformance invalid
        ("numbers-ints", knobe(FM, "", obj('"x":[0,-0,7,-12,123456789012345678901234567890]'))),
        ("numbers-floats", knobe(FM, "", obj(
            '"x":[1.0,1.5,-0.0,1e16,1E2,1e-5,0.0001,2.5e-7,123456789.125,'
            '1.7976931348623157e308,5e-324]'))),
        ("numbers-bool-null-not-numeric", knobe(FM, "", obj(
            '"flag":true,"none":null,"deep":{"a":[false]}'))),
        ("number-underflow-to-zero", knobe(FM, "", obj('"x":1e-400'))),
        ("number-int-beyond-float-range", knobe(FM, "", obj('"x":1' + "0" * 400))),
        # a float that overflows to inf has no canonical form (lens.py PR #11)
        ("number-overflow-in-field", knobe(FM, "", obj('"x":1e400'))),
        ("number-overflow-nested", knobe(FM, "", obj('"ext":{"a":[-1e309]}'))),
        ("payload-hash-overflow", knobe(FM, "", obj().replace('"__H__"', "1e400"))),
        ("payload-hash-overflow-negative", knobe(FM, "", obj().replace('"__H__"', "-1.5E+999"))),
        ("payload-hash-overflow-in-list", knobe(FM, "", obj().replace('"__H__"', "[1e400]"))),
        # JSON strictness
        ("dup-key-nested", knobe(FM, "", obj('"ext":{"a":"1","a":"2"}'))),
        ("nan-constant", knobe(FM, "", obj('"x":NaN'))),
        ("infinity-constant", knobe(FM, "", obj('"x":-Infinity'))),
        ("lone-surrogate-value", knobe(FM, "", obj(r'"x":"\ud800"'))),
        ("surrogate-pair-escape", knobe(FM, "", obj('"x":"\U0001F600"'))),
        ("escapes-mixed", knobe(FM, "", obj(r'"x":"\u0000\u001f\b\f\n\r\t\/\\\"\u007f é"'))),
        ("nfd-key-no-collision", knobe(FM, "", obj('"café":"v","x":"é"'))),
        ("nfc-collision-in-list", knobe(FM, "", obj('"x":[{"café":"1","café":"2"}]'))),
        ("astral-keys-sorting", knobe(FM, "", obj('"\U0001F600":"a","￿":"b","\U00010000":"c"'))),
        ("payload-top-level-string", knobe(FM, "", '"hello"')),
        ("payload-top-level-null", knobe(FM, "", "null")),
        ("payload-whitespace-around", knobe(FM, "", " \n\t" + obj() + "\r\n ")),
        ("payload-trailing-comma", knobe(FM, "", '{"a":"1",}')),
        ("payload-bom", knobe(FM, "", "﻿" + obj())),
        ("payload-raw-control-char", knobe(FM, "", obj('"x":"a\u0001b"'))),
        ("payload-raw-del-char", knobe(FM, "", obj('"x":"a\u007fb"'))),
        # frontmatter
        ("fm-missing", knobe("", "", obj())),
        ("fm-crlf", knobe("---\r\ntitle: T\r\nspec_version: 1.0\r\n---\r\n", "", obj())),
        ("fm-crlf-with-body", knobe("---\r\ntitle: T\r\n---\r\n", "Body\r\nline  \r\n", obj(bh))),
        ("fm-double-cr", knobe("---\r\r\ntitle: T\r\n---\r\n", "", obj())),
        ("fm-double-cr-with-body", knobe("---\r\r\ntitle: T\n---\n", body, obj(bh))),
        ("fm-bom", knobe("﻿---\ntitle: T\n---\n", "", obj())),
        ("fm-bom-with-body", knobe("﻿---\ntitle: T\n---\n", body, obj(bh))),
        ("fm-unclosed", knobe("---\ntitle: T\nspec_version: 2.0\n", "", obj())),
        ("fm-spec-quoted-mismatch", knobe("---\nspec_version: '1.1'\n---\n", "", obj())),
        ("fm-spec-mixed-quotes", knobe("---\nspec_version: \"'1.0'\"\n---\n", "", obj())),
        ("fm-spec-whitespace-only", knobe("---\nspec_version:    \n---\n", "", obj())),
        ("fm-spec-empty", knobe("---\nspec_version:\n---\n", "", obj())),
        ("fm-spec-indented-unicode-ws", knobe(
            "---\n　spec_version : 1.1 \n---\n", "", obj())),
        ("fm-spec-first-wins", knobe("---\nspec_version: 1.0\nspec_version: 9\n---\n", "", obj())),
        ("fm-spec-after-close-ignored", knobe("---\ntitle: T\n---\nspec_version: 9\n", "", obj())),
        ("fm-spec-not-prefix", knobe("---\nspec_versionx: 9\n---\n", "", obj())),
        # body normalization edges (Python whitespace vs line-end rules)
        ("body-tabs-and-spaces", knobe(FM, "\n  a \t\n\tb\t \n\n", obj(bh))),
        ("body-lone-cr", knobe(FM, "\na\rb\r\n", obj(bh))),
        ("body-unicode-edges", knobe(FM, "\u001c\u0085  body 　 ", obj(bh))),
        ("body-feff-edge", knobe(FM, "﻿body﻿", obj(bh))),
        ("body-nbsp-line-end", knobe(FM, "\nline \nnext \n", obj(bh))),
        ("body-with-dashes-line", knobe(FM, "\nbefore\n---\nafter\n", obj(bh))),
        ("body-empty-with-hash", knobe(FM, "", obj(bh))),
        ("body-modified", knobe(FM, body, obj(bh)).decode("utf-8")
         .replace("Hello", "Jello", 1).encode("utf-8")),
    ]

    # block-level structure (built by hand)
    good = sealed(obj(), "")
    good_b64 = b64(good)
    with_bh = sealed(obj(bh), body)
    padded = good
    while len(padded.encode("utf-8")) % 3 == 0:
        padded += " "

    def wrap(s):
        return "\n".join(s[i:i + 10] for i in range(0, len(s), 10))

    c += [
        ("block-wrapped-lines", raw(f"{FM}\n{BEGIN}\n{wrap(good_b64)}\n{END}\n")),
        ("block-internal-spaces-tabs", raw(
            f"{FM}\n{BEGIN}\n {good_b64.replace('A', 'A \t', 1)} \t\n{END}\n")),
        ("block-internal-unicode-space", raw(f"{FM}\n{BEGIN}\n{good_b64} \u001c\n{END}\n")),
        ("block-internal-nel", raw(f"{FM}\n{BEGIN}\n{good_b64}\u0085\n{END}\n")),
        ("block-internal-vt-ff", raw(f"{FM}\n{BEGIN}\n{good_b64[:8]}\u000b{good_b64[8:]}\u000c\n{END}\n")),
        ("block-internal-zwsp", raw(f"{FM}\n{BEGIN}\n{good_b64}​\n{END}\n")),
        ("block-at-byte-zero", raw(f"{BEGIN}\n{good_b64}\n{END}\n")),
        ("block-at-byte-zero-with-body-hash", raw(f"{BEGIN}\n{b64(with_bh)}\n{END}\n")),
        ("block-no-end", raw(f"{FM}\n{BEGIN}\n{good_b64}\n")),
        ("block-empty", raw(f"{FM}\n{BEGIN}\n\n{END}\n")),
        ("block-end-trailing-text", raw(f"{FM}\n{BEGIN}\n{good_b64}\n{END} trailing\n")),
        ("block-begin-trailing-space", raw(f"{FM}\n{BEGIN} \n{good_b64}\n{END}\n")),
        ("block-crlf-markers", raw(f"{FM}\r\n{BEGIN}\r\n{good_b64}\r\n{END}\r\n")),
        ("block-two-then-garbage-last", raw(f"{FM}{block(good)}\n{BEGIN}\n!!!!\n{END}\n")),
        ("block-two-with-body-hash", raw(f"{FM}{body}{block(with_bh)}{block(with_bh)}")),
        ("block-nested-begin", raw(f"{FM}\n{BEGIN}\n{BEGIN}\n{good_b64}\n{END}\n")),
        ("b64-nonzero-trailing-bits", raw(f"{FM}\n{BEGIN}\n{flip_trailing_bits(b64(padded))}\n{END}\n")),
        ("b64-excess-after-padding", raw(f"{FM}\n{BEGIN}\n{good_b64}QQ==\n{END}\n")),
        ("b64-bad-alphabet", raw(f"{FM}\n{BEGIN}\n{good_b64[:-2]}-_\n{END}\n")),
        ("b64-three-pad", raw(f"{FM}\n{BEGIN}\nQ===\n{END}\n")),
        ("b64-not-utf8-json", raw(f"{FM}\n{BEGIN}\n{b64(bytes([0xff, 0xfe, 0x7b, 0x7d]))}\n{END}\n")),
        ("file-not-utf8", FM.encode("utf-8") + bytes([0xc3, 0x28])),
        ("file-empty", b""),
    ]
    assert len(c) == 122, len(c)

    # --- display escaping: payload-derived text that reaches a report --------
    breakout = ("x` |\n| Match | ✅ yes |\n\n![](https://example.invalid/track.png)")
    c += [
        ("x-dup-key-surrogate", knobe(FM, "", r'{"\ud800":"1","\ud800":"2"}')),
        ("x-dup-key-bidi-ansi", knobe(FM, "", r'{"a‮\u001b[31mX":"1","a‮\u001b[31mX":"2"}')),
        ("x-dup-key-long", knobe(FM, "", '{"' + "k" * 400 + '":"1","' + "k" * 400 + '":"2"}')),
        ("x-surrogate-in-key", knobe(FM, "", obj(r'"\ud800x":"v"'))),
        ("x-surrogate-in-payload-hash", knobe(FM, "", obj().replace('"__H__"', r'"\udc00"'))),
        ("x-surrogates-reversed", knobe(FM, "", obj(r'"x":"\udc00\ud800"'))),
        ("x-surrogate-pair-escaped", knobe(FM, "", obj(r'"x":"\ud83d\ude00"'))),
        ("x-payload-hash-markdown", knobe(FM, "", obj().replace('"__H__"', json.dumps(breakout)))),
        ("x-payload-hash-ansi", knobe(FM, "", obj().replace(
            '"__H__"', r'"\u001b[2J\u001b[32mverified‮"'))),
        ("x-title-rlo", knobe(FM, "", obj_without("title", r'"title":"evil‮gnp.exe"'))),
        ("x-title-controls", knobe(FM, "", obj_without(
            "title", r'"title":"a\u0000b\u001b[31mc\u0085d e⁦f"'))),
        ("x-title-markdown", knobe(FM, "", obj_without(
            "title", json.dumps("T | x |\n![](https://example.invalid/t.png) %%hide%% $x$ [[Note]] <b>"))
            )),
        ("x-numeric-hostile-key", knobe(FM, "", obj(r'"\u001b[31m‮|`":5'))),
        ("x-vocab-hostile", knobe(FM, "", obj_without("content_type", r'"content_type":"‮evil\u0007"'))),
        ("x-vocab-quotes", knobe(FM, "", obj_without("content_type", r'"content_type":"it' + "'" + r's \"x\""'))),
        ("x-nfc-collision-hostile", knobe(FM, "", obj('"‮café":"1","‮café":"2"'))),
        ("x-spec-version-list", knobe(FM, "", obj_without("spec_version", '"spec_version":["1.0"]'))),
        ("x-spec-version-object", knobe(FM, "", obj_without(
            "spec_version", r'"spec_version":{"v":"‮1.0","n":1.5,"t":true,"z":null,"i":7}'))),
        ("x-spec-version-int", knobe(FM, "", obj_without("spec_version", '"spec_version":2'))),
        ("x-spec-version-quotes", knobe(FM, "", obj_without(
            "spec_version", r'"spec_version":"it' + "'" + r's \"1\""'))),
        ("x-created-date-bidi", knobe(FM, "", obj_without(
            "created_date", r'"created_date":"2026-01-0‮1"'))),
        ("x-created-date-list", knobe(FM, "", obj_without("created_date", '"created_date":["2026-01-02"]'))),
        ("x-fm-spec-bidi", knobe('---\nspec_version: "1.0‮"\n---\n', "", obj())),
        ("x-sources-number", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":5}'))),
        ("x-sources-strings", knobe(FM, "", obj_without("attribution", '"attribution":{"sources":["x"]}'))),
        # --- parse errors: lens.py's json reports duplicates when an object closes
        ("x-dup-then-nan", knobe(FM, "", '{"a":"1","a":"2","x":NaN}')),
        ("x-dup-then-overflow", knobe(FM, "", '{"a":"1","a":"2","x":1e400}')),
        ("x-dup-then-syntax-error", knobe(FM, "", '{"a":"1","a":"2","x":}')),
        ("x-dup-nested-then-nan", knobe(FM, "", '{"o":{"k":"1","k":"2"},"x":NaN}')),
        ("x-dup-first-repeat-wins", knobe(FM, "", '{"b":"1","a":"1","a":"2","b":"2"}')),
        ("x-infinity-plain", knobe(FM, "", obj('"x":Infinity'))),
        ("x-nan-negative", knobe(FM, "", obj('"x":-NaN'))),
        # --- nesting depth
        ("x-depth-300", knobe(FM, "", obj('"deep":' + "[" * 300 + "]" * 300))),
        ("x-depth-2000", knobe(FM, "", obj('"deep":' + "[" * 2000 + "]" * 2000))),
    ]
    names = [n for n, _ in c]
    assert len(names) == len(set(names)), "duplicate case names"
    return c


if __name__ == "__main__":
    main()
