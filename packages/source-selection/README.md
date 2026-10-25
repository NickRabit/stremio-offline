# Source selection facts

This package contains the pure addon-listing fact parsers shared by the server and web client.

`vectors.json` is the portable conformance corpus. TypeScript and Android TV JVM tests read this
same tracked file, so a parser change must satisfy both implementations.

Run the Android TV conformance test from the repository root:

```sh
cd android-tv && ./gradlew :app:testDebugUnitTest --tests cz.stremiooffline.tv.catalog.SourceFactsVectorsTest
```
