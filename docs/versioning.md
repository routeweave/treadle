# Versioning

How `luci-app-treadle` version numbers are built, and the rules any change to
the packaging pipeline has to keep.

This is the single normative source. `CONTRIBUTING.md` summarises it,
`package.sh` and the CI workflows carry only the invariants local to the lines
they sit on, and everything that can be stated as an assertion instead lives
in `scripts/version-check.sh`, which both CI workflows run. Where
this document and `version-check.sh` disagree, the script is right — it is
checked against apk's own parser on every build.

## The model

**`PKG_VERSION` and `PKG_RELEASE` in the `Makefile` are the only input, and
they trail the timeline** — they name the version most recently *released*,
never a guess at the next one. A forward-looking version has to be predicted
correctly and is wrong the moment a hotfix pre-empts a planned release; a
trailing one only records what already happened.

A build is one of two things:

| Build | Version | Example |
|---|---|---|
| The release itself | `<PKG_VERSION>-r<PKG_RELEASE>` | `0.1.0-r1` |
| Anything else: a pull request, `main`, a local build | `<PKG_VERSION>_git<TS>-r<PKG_RELEASE>` | `0.1.0_git20260105083000-r1` |

`package.sh` builds the release shape only when `TREADLE_RELEASE_BUILD=1`,
which `ci.yml` sets on a release commit, and the snapshot shape otherwise. It
reads no tags. Because the Makefile names the last release, a snapshot is
always `<last release>_git<TS>`.

**What a change bumps** follows OpenWrt's rule for `PKG_RELEASE`, with
Treadle as its own upstream:

| What changed | Release | Version |
|---|---|---|
| CI, tests, docs, scripts outside the package | none | unchanged |
| Packaging only: `LUCI_DEPENDS`, `TREADLE_DEP_MIN`, postinst / prerm, conffiles, `package.sh` | yes | `PKG_RELEASE` + 1, tag `v0.1.0-r2` |
| App code: `htdocs/`, `root/`, `po/` | yes | `PKG_VERSION` bumped, `PKG_RELEASE` back to 1, tag `v0.2.0` |

CI checks the arithmetic, not the judgement: the new version must sort above
the newest release, and a new `PKG_VERSION` must come with `PKG_RELEASE` 1.
Whether a change was packaging-only is for the release PR to get right.

**The Makefile edit is the release decision, and the `v*` tag is its
record.** A push to `main` whose version has no tag yet is a release commit:
`ci.yml` builds and tests that version, and creates the tag and the release on
that commit. Nothing pushes a tag by hand, so there is no second place to
declare a version. That is what keeps the OpenWrt SDK build path — which reads
`PKG_VERSION` / `PKG_RELEASE` verbatim and never sees the CI environment —
labelled identically to what is published.

Releasing therefore means merging a commit that bumps the Makefile. See
[Releasing](#releasing).

## Snapshots are a channel, and rollback is not supported

apk and opkg compare the version body before the revision, so a snapshot sorts
above every release with the same `PKG_VERSION`:

- the release PR's own builds, `0.2.0_git<TS>-r1`, sort above the `0.2.0-r1`
  they become;
- a snapshot made after `0.1.0-r1`, `0.1.0_git<TS>-r1`, sorts above a later
  `0.1.0-r2`.

Nothing can sit between `0.1.0-r1` and `0.1.0-r2`: the revision is a whole
number and nothing may follow it. This is the intended behaviour, not a
defect. A router that installed a snapshot stays on it, and the release feed
moves it on only when a higher version is released; going to a
release with the same version would be a rollback, which Treadle does not
support. Nothing is lost by staying. The release PR's build is the release's
code. An `-r2` changes no code, and the snapshots built after the bump carry
the fix as `0.1.0_git<TS>-r2`, which sorts above all of these.

## OpenWrt's `<version>-r<release>` spelling

Both package formats use OpenWrt's `<version>-r<release>` spelling — the
single `VERSION` that `include/package-defaults.mk` derives for apk and ipk
alike:

```make
VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)
```

**Not** Debian's `<version>-<release>`. This is not cosmetic: opkg compares
revisions Debian-style, where the empty run before `1` sorts below the letter
`r`, so a bare `1.1.3-1` ranks *below* an SDK- or feed-built `1.1.3-r1` of the
identical source.

**Never route a build counter through `-r<N>`.** It is the packaging
revision. Snapshot ordering belongs in the version body, which is what the
timestamp is for.

## The snapshot suffix is a timestamp, never a commit count

`<TS>` is HEAD's committer date as UTC `YYYYMMDDHHMMSS`, formatted by git so
no `date(1)` is needed (`date --utc --date=@…` is GNU-only and the BSD
spelling differs):

```sh
TZ=UTC0 git log -1 --format=%cd --date=format-local:%Y%m%d%H%M%S
```

A commit **count** encodes distance rather than identity and fails twice:

- Two branches the same number of commits past the tag produce an identical
  version, so a tester moving between their CI builds can end up installing
  nothing.
- A count moves *backwards*. Rebasing or squashing a topic branch turns
  `_git5` into `_git1`, so the later build sorts below the installed one.

A commit timestamp is distinct per commit and only ever advances — a rebase
resets the committer date to now — so the version body orders snapshots on its
own, with no tie-breaker needed anywhere else.

Use the **committer date, not the build time**, so rebuilding a commit
reproduces its version and the version stays a function of the source. This is
the same field `luci.mk`'s `findrev` uses.

It is also the convention elsewhere: Alpine spells the suffix `_git<date>`
(`pimd 3.0_git20220201`, `sdc 0.0.15_git20260102`, with the aports variables
named `$_date` / `$_pkgdate`), `openwrt/packages` uses `PKG_SOURCE_DATE` plus
`PKG_SOURCE_VERSION`, and `luci.mk` builds `YY.DDD.SSSSS~HASH`.

## apk format constraints

The version must be `<major>.<minor>.<patch>` with optional suffixes.

- **Suffix order**, from apk's own table:
  `_alpha` < `_beta` < `_pre` < `_rc` < *(none)* < `_cvs` < `_svn` < `_git` <
  `_hg` < `_p`. Each takes digits only. This is what guarantees
  `<tag>` < `<tag>_git<TS>` < `<next-tag>`.
- **`-r<N>` is a terminal token** (`TOKEN_REVISION_NO`). Nothing may follow
  it: `1.1.3-r2_git2-r1` does not parse, and `apk mkpkg` rejects the package
  outright.
- **`-` is not otherwise legal.** Debian's `1.2.0-1` is rejected.
- **`~<hex>` *is* legal** — apk parses it as `TOKEN_COMMIT_HASH`, and
  OpenWrt's own apk feed ships `luci-app-acl-26.255.21994~842f055.apk`. It
  makes builds distinguishable but **not** ordered, so it is no substitute
  for a monotonic component.
- **Suffix and revision numbers compare numerically**, not lexically —
  `token_cmp()` puts `TOKEN_SUFFIX_NO` and `TOKEN_REVISION_NO` in the numeric
  branch — so `_git9 < _git10 < _git100` and `-r9 < -r10`. Note that a
  `TOKEN_DIGIT` run with a *leading zero* falls back to string sort, so never
  zero-pad a version component.
- **Architecture**: `noarch` for architecture-independent packages, not `all`.
  `arch = all` in `.PKGINFO` makes apk reject the package as invalid.
  `all` and `noarch` are the ipk and apk spellings of the same thing;
  `package.sh` translates, as OpenWrt's `package-pack.mk` does.

## Where opkg differs

Two differences matter, and assuming the managers behave alike has produced
wrong conclusions before.

**opkg has no suffix table.** `verrevcmp()` in `libopkg/pkg.c` ranks
characters with

```c
#define order(x) ((x) == '~' ? -1 : isdigit((x)) ? 0 : !(x) ? 0 \
                : isalpha((x)) ? (x) : (x) + 256)
```

so `_` scores 351 against end-of-string's 0 and **every** `_suffix` sorts
*above* the bare version:

| Comparison | apk | opkg |
|---|---|---|
| `1.2.0_git<TS>` vs `1.2.0` | `>` | `>` — agree |
| `1.2.0_pre<TS>` vs `1.2.0` | `<` | **`>`** — disagree |
| `1.2.0_alpha1` / `_beta` / `_rc` vs `1.2.0` | `<` | **`>`** — disagree |

Only `_git<TS>` and `-r1` ship, and both agree, so this is latent.

### Release candidates are unsolved, not forbidden

Treadle publishes none today, and **one version string cannot mean
"pre-release" in both managers**:

- `1.2.0_rc1` — apk sorts it below `1.2.0` (correct); opkg sorts it *above*
  (wrong), so a 24.10 user on the RC would never be offered the release.
- `1.2.0~rc1` — Debian's spelling, correct for opkg, but **apk rejects it**.
  After `~` apk spans hex digits only and requires at least one
  (`apk_blob_spn(*b, APK_CTYPE_HEXDIGIT, …)`; `r` is not hex), so the version
  does not parse at all.

So publishing an RC means choosing one of:

1. **Ship RCs as snapshots.** Costs nothing — the mechanism exists, and
   snapshots are installed by hand and kept out of the feed, so no ordering
   question arises. You give up having the RC installable *from the feed*.
2. **Version the two formats differently** — `1.2.0_rc1` for the apk,
   `1.2.0~rc1` for the ipk. Both then sort correctly in their own manager.
   This gives up the single-`VERSION`-for-both-formats property that the rest
   of this document rests on, and `package.sh` would derive two version
   strings rather than one.

Until one is chosen, **do not put `_pre` / `_alpha` / `_beta` / `_rc` in a
version that is also built as an ipk** — not as a permanent rule, but because
nothing downstream is prepared for it yet.

**A local-file install is version-gated on opkg but not on apk.** Snapshots
are installed by hand and kept out of the feed, so this decides what any
snapshot-ordering bug actually costs:

- `opkg install <file>` compares versions (`opkg_install.c` →
  `pkg_compare_versions`): `cmp > 0` prints "Not downgrading package …",
  `cmp == 0` prints "… already install on …". Both refuse without a
  `--force-` flag, so a colliding or regressed version installs *nothing*.
- `apk add <file>` does not. `app_add.c` sends a file argument through
  `apk_dep_from_pkg()`, which pins the world constraint to the package's
  **content hash** (`APK_DEPMASK_CHECKSUM`), never its version — so the file
  always installs. That pin (`luci-app-treadle><Q1…` in `/etc/apk/world`)
  also stops a later release from replacing the file, unless the package
  name is given in the same command: `apk add /tmp/treadle.apk
  luci-app-treadle` records the name, and the file satisfies it. The
  README's snapshot line does exactly that.

Do not weaken the version scheme on the strength of apk's leniency; 24.10 is
supported.

Ordering against the **feed** is a separate property that applies to both:
an installed snapshot must outrank the release it follows, or the next
`apk upgrade` / `opkg upgrade` pulls the user back to an older release.

## Releasing

```sh
# After merging the changes that constitute the release to main:
git switch -c release-0.11.0 origin/main

# Record the version being released: PKG_VERSION for a change to the app,
# with PKG_RELEASE back to 1; PKG_RELEASE alone for a packaging-only change,
# which is tagged v0.11.0-r2.
$EDITOR Makefile          # PKG_VERSION:=0.11.0
git commit -am "Release 0.11.0"
git push -u origin release-0.11.0
# Open a pull request; merging it to main is the release.
```

The push to `main` that carries the bump runs CI with the release version.
When every check passes, it signs the `.apk` it tested, creates the tag
(`v0.11.0`) and the release on that commit, and republishes the feed. A
failing check publishes nothing; fix it and merge again, and the next push
releases, since the version still has no tag. A version that sorts below the
newest release fails the run instead of releasing. Never push a `v*` tag by
hand: a tag that exists is a version already released, so CI would skip it.

Snapshots from the next commit on are `0.11.0_git<TS>-r1` automatically, or
`…-r2` after a packaging-only release.

To try the release path without releasing, run CI from the Actions tab with
`release_dry_run`: it builds, tests and signs the Makefile's version and keeps
the packages as an artifact.

## Enforcement

`scripts/version-check.sh` asserts the rules above against apk's
real parser — which versions must parse, which must not, and the orderings the
upgrade guarantee depends on — and every build runs it against the version it
just built. Add a case there when you change the scheme; a rule that
exists only in this file is a rule that can drift.

With an `apk` on `PATH` it also runs locally:

```sh
scripts/version-check.sh
```

The apk checks call apk's own parser. The ipk ordering is checked through
**`dpkg`**, which stands in for opkg: opkg's comparison *is* dpkg's —
`order()` and `verrevcmp()` in `libopkg/pkg.c` match dpkg's — and dpkg is
already present on CI runners, so the check runs against a real implementation
of the algorithm rather than a hand-written model of it. Porting `verrevcmp()`
into shell was rejected for exactly that reason: the test would then be able to
be wrong in the same way as the thing it guards.

Two limits worth knowing. dpkg is a different codebase, so this would not catch
opkg diverging from dpkg in future. And Debian's `upstream_version` grammar
excludes `_`, which the snapshot suffix uses — the script probes for that and
skips the ipk block loudly if this dpkg refuses such versions, rather than
reporting a pass it did not earn.
