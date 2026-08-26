# Recovery kit compatibility files

These files contain synthetic keys only. They were generated once by the real
`@cloakedxyz/clkd-sdk-client` writer and are intentionally frozen.
The standalone recovery tests decrypt them to catch accidental format drift
between the application and this repository.

Test password: `correct-horse-battery-staple`

Expected stealth material:

- `p_spend`: `0x1111111111111111111111111111111111111111111111111111111111111111`
- `p_view`: `0x2222222222222222222222222222222222222222222222222222222222222222`

The passkey v1 file uses that material. The wallet+PIN v1 file uses `0x33...33`
for `p_spend` and `0x44...44` for `p_view`. Version 1 did not encode an account
type; the separately named fixtures ensure the reader continues to accept files
produced by both application paths.

`recovery-kit-v1-pre-webcrypto.json` is an older frozen file from before the
application moved PBKDF2 to Web Crypto. Its password is `password1234`.

The wallet+PIN v2 file contains the Privacy Pools mnemonic derived from the
synthetic signature `0x` followed by `ab` 65 times:

`scale useful hurt mixed boring birth defense toilet slide reduce virus source`
