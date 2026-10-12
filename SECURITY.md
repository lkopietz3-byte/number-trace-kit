# Security policy

## Status

This package is private and unreleased. There are no supported published
versions yet.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainer (Lucas
Kopietz) rather than in a public place. Include what you can: the version or
commit, a minimal reproduction, and the impact you expect.

## Posture

The library reads text and numbers you give it and returns data. It does no
I/O, evaluates no code, and has no runtime dependencies. The inputs that matter
for safety are untrusted model output and untrusted evidence text:

- Scanning is linear in the text length. Texts over 5,000,000 UTF-16 units,
  arrays over 1,000,000 items, and more than 50,000,000 characters of evidence
  in total are rejected.
- Digit runs over 60 digits are never converted to BigInt.
- A caller-supplied regular expression (`ignorePattern`) is copied and shown a
  short window only. A pattern with catastrophic backtracking can still be
  slow on that window; keep patterns simple.
- Caller objects are read once. Getters and proxies that throw propagate their
  own error.

## Bug bounty

There is no bug bounty program for this project.
