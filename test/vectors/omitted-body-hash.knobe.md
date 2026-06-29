---
title: "Omitted Body Hash Test Vector"
spec_version: "1.0"
content_type: original
privacy_level: public
quarantine_status: trusted
created_date: "2026-06-23"
---
# Omitted Body Hash Test Vector

This test vector deliberately omits the optional body_hash field. The verifier should report status: verified · body_verified: omitted · conformance: valid. The omission is the receiver's signal that body integrity was never sealed.

-----BEGIN KNOBE B64-----
eyJhdHRyaWJ1dGlvbiI6eyJnb29kX2ZhaXRoX2RlY2xhcmF0aW9uIjp0cnVlLCJzb3VyY2VzIjpb
eyJhdXRob3IiOiJUZXN0IEF1dGhvciIsImNvbnRyaWJ1dGlvbiI6InRlc3QgdmVjdG9yIGF1dGhv
cnNoaXAiLCJyaWdodHNfYmVhcmluZyI6dHJ1ZX1dfSwiY29udGVudF90eXBlIjoib3JpZ2luYWwi
LCJjcmVhdGVkX2RhdGUiOiIyMDI2LTA2LTIzIiwibGljZW5zZSI6IkNDIEJZIDQuMCIsInBheWxv
YWRfaGFzaCI6ImMyODE4NWFiZDgwMWUwNjIyZWQ1MzMxMTk4YjllNjc0YWU5OTY5OTZhMTlkNTc0
YTIyNDU3ZmM1NjllMWNkZGQiLCJwcml2YWN5X2xldmVsIjoicHVibGljIiwicXVhcmFudGluZV9z
dGF0dXMiOiJ0cnVzdGVkIiwic3BlY192ZXJzaW9uIjoiMS4wIiwic3VtbWFyeSI6Ik5vIGJvZHlf
aGFzaCBpbiBwYXlsb2FkOyB2ZXJpZmllciByZXBvcnRzIGJvZHlfdmVyaWZpZWQ6IG9taXR0ZWQu
IiwidGl0bGUiOiJPbWl0dGVkIEJvZHkgSGFzaCBUZXN0IFZlY3RvciJ9
-----END KNOBE B64-----
