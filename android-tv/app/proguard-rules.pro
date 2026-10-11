# Only what a minified release build proves it needs: Media3, OkHttp,
# kotlinx-serialization and Coil ship their own consumer rules, so nothing here
# is required for them. Add a rule only when `assembleRelease` shows a missing
# class at runtime; watch androidx.security:security-crypto (Tink) for that.
