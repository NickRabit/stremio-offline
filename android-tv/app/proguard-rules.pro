# Only what a minified release build proves it needs: Media3, OkHttp and
# kotlinx-serialization ship their own consumer rules, and Coil 2 needs none
# (its docs say it is compatible with R8 out of the box). A successful
# `assembleRelease` only shows that the build minifies, not that a reflective
# path survives on a television, so add a rule the moment a runtime crash names
# a class R8 kept out; watch androidx.security:security-crypto (Tink) for that.
