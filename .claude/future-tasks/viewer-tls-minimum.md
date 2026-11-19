# The distribution's minimum viewer TLS stays at CloudFront's default until a custom domain

**Priority:** P3 · **Status:** open, blocked on `domains-and-certs`
**Found by:** the security review of `fix/cdk-forwarded-host-https` (2026-11-19).

## What happens

`SssbApp`'s distribution is served on its `*.cloudfront.net` name with CloudFront's default certificate. With that
certificate, the minimum TLS version a viewer may use cannot be raised. CloudFront's guide puts the security policy
at TLSv1 for the default certificate ("Supported protocols and ciphers between viewers and CloudFront"). A
`minimumProtocolVersion` on the distribution takes effect only with a certificate of the adopter's own.

Nothing to build until then: the distribution has no custom domain, by design, until the `domains-and-certs` cutover
row closes.

## The fix, sketched

When `SssbApp` takes a custom domain (a `domainNames` + `certificate` pair, or the escape hatch the first adopter
uses), it should set `minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021` (or the newest CloudFront offers
then) and `sslSupportMethod: SNI`. A test should check that a distribution with a certificate never synthesizes an
older policy. The first adopter already sets `TLSv1.2_2021` on its own distribution.
