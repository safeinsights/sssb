#!/usr/bin/env bash
# Trojan Source scan (CVE-2021-42574). Bidirectional control characters let source render in a different
# order than it compiles in, so a reviewer reads one program and the compiler builds another. This fails
# when a tracked file's CONTENTS or a tracked file's NAME holds one of the nine reordering codepoints:
# the embeddings and overrides U+202A-202E and the isolates U+2066-2069. Deliberately not the marks
# U+061C, U+200E and U+200F: their reordering power is confined to adjacent neutral runs, and they appear
# legitimately in right-to-left copy. The filename half matches the same nine as raw UTF-8 bytes; keep
# the two in step.
#
# Run it from the repository root, before any install: it needs only git, perl and bash, and fails in
# seconds. Adapted from CanopyCMS's ci.yml. It is a script, not inline YAML, so tests/tooling/check-bidi.test.ts
# can run it against real scratch repositories and watch it fail.
#
# FAIL CLOSED. Every way the scan can fail to run must read as a failure, never as "nothing found":
#   - LC_ALL is pinned. `git grep -P` compiles \x{...} escapes above 0xFF only in PCRE2 UTF mode, which git
#     turns on only under a UTF-8 locale; under LC_ALL=C or an unset locale it dies with "character code
#     point value in \x{} or \o{} is too large" and exit 128.
#   - The exit status is read with `case`, not `if git grep ...; then`. That form treats exit 128 as
#     "found nothing" and passes, so a locale change or a missing repository would quietly turn the check
#     into a no-op instead of breaking it loudly. Only exit 1 means clean.
#   - `pipefail`, because `git ls-files -z | perl ...` otherwise reports only perl's status: if git failed,
#     perl reads empty stdin, exits 0, and the scan reads as clean.
#   - The byte pattern is self-tested against all nine codepoints, because a wrong range would fail OPEN
#     (no match reads as clean).
set -euo pipefail
export LC_ALL=C.UTF-8

fail() {
    echo "::error::$1"
    exit 1
}

bidi='[\x{202A}-\x{202E}\x{2066}-\x{2069}]'
bidi_bytes='\xe2\x80[\xaa-\xae]|\xe2\x81[\xa6-\xa9]'

# File CONTENTS. -I skips files git considers binary: a file marked binary via .gitattributes can opt
# out, but without it an image fixture would false-positive on a stray E2 80 AA-AE byte run.
status=0
matches=$(git grep -P -I -l -e "$bidi") || status=$?
case "$status" in
    0)
        echo "$matches"
        fail 'Bidirectional unicode characters detected in file contents (CVE-2021-42574 Trojan Source)'
        ;;
    1) ;;
    *) fail "bidi content scan did not run (git grep exited $status)" ;;
esac

# FILENAMES. git grep reads contents only, so a file merely NAMED with an override, report<U+202E>gnp.ts,
# which renders as "report st.png", would otherwise sail through. `-z` keeps paths raw: without it git
# quotes non-ASCII and the bytes never arrive.
#
# Matched as raw UTF-8 BYTES (U+202A-202E are E2 80 AA-AE, U+2066-2069 are E2 81 A6-A9), not as \x{...}
# under `perl -CSD`. Decoding would make a path holding an invalid multi-byte sequence a FATAL match error
# that aborts the scan partway and leaves every later path unexamined. Bytes cannot be malformed.
selftest=$(perl -CO -e 'print chr($_) for (0x202A..0x202E, 0x2066..0x2069)' |
    perl -0 -ne '$n++ while /'"$bidi_bytes"'/g; print $n+0')
if [ "$selftest" != "9" ]; then
    fail "bidi filename pattern self-test matched $selftest of 9 codepoints"
fi

# Detection is signalled by OUTPUT, not by exit status: perl exits 0 whether or not it matched, so a
# non-zero status means git or perl itself failed and the scan did not run. Deliberately not perl's own
# exit code via END: an END block runs on die too, laundering a fatal into a status read as "clean".
nstatus=0
names=$(git ls-files -z |
    perl -0 -ne 'chomp; print "$_\n" if /'"$bidi_bytes"'/') || nstatus=$?
if [ "$nstatus" -ne 0 ]; then
    fail "bidi filename scan did not run (pipeline exited $nstatus)"
fi
if [ -n "$names" ]; then
    echo "$names"
    fail 'Bidirectional unicode characters detected in a FILENAME (CVE-2021-42574 Trojan Source)'
fi

echo 'No bidirectional unicode control characters in contents or filenames'
