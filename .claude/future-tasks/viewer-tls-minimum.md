# The distribution's minimum viewer TLS stays at CloudFront's default until a custom domain

**Priority:** P3 · **Status:** open, blocked on `domains-and-certs`
**Found by:** the security review of `fix/cdk-forwarded-host-https` (2026-11-19).

## What happens

`SssbApp`'s distribution is served on its `*.cloudfront.net` name with CloudFront's default certificate. With that
certificate, the minimum TLS version a viewer may use cannot be raised. For the default certificate CloudFront
"automatically sets the security policy to TLSv1" (CloudFront's guide, "Distribution settings", "Security policy
(minimum SSL/TLS version)"). A
`minimumProtocolVersion` on the distribution takes effect only with a certificate of the adopter's own.

Nothing to build until then: the distribution has no custom domain, by design, until the `domains-and-certs` cutover
row closes.

## The fix, sketched

When `SssbApp` takes a custom domain (a `domainNames` + `certificate` pair, or the escape hatch an adopter
may use), it should set `minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021` (or the newest CloudFront offers
then) and `sslSupportMethod: SNI`. A test should check that a distribution with a certificate never synthesizes an
older policy. An adopter may already set `TLSv1.2_2021` on its own distribution.
