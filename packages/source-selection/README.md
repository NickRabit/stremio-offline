# Source selection facts

This package contains the pure addon-listing fact parsers shared by the server and web client.

`vectors.json` is the portable conformance corpus. The Kotlin Android TV client will consume
these vectors before its own parser cutover; no Kotlin production code uses the corpus yet.
