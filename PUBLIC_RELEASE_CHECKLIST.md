# Public release checklist

Reviewed on 2026-09-29 against the public repository at
`https://github.com/mattwynne/pi-extensions`.

## Candidate identity

- Public default branch: `main`
- Reviewed head: `d3369bfeb26d8335ec1083fd5bc837c42e37c010`
- Sanitized parentless root: `1f18aced905ee0aabedfb08f75a2471a87aaf347`
- Reachable history: three intended commits (sanitized root, release workflow,
  and workflow badge)
- Working tree matched `origin/main` and was clean at review time

## Release checks

- `npm run check` passed on the exact sanitized-root tree before publication:
  51 tests passed, all 8 extension TypeScript files passed syntax validation,
  and `npm audit` reported 0 vulnerabilities.
- The same command passed in GitHub Actions for the workflow commit and current
  head.
- Current-head run: [Release check 36511603169](https://github.com/mattwynne/pi-extensions/actions/runs/36511603169)

## Public ref and reachability review

- `git ls-remote --symref origin HEAD 'refs/heads/*' 'refs/tags/*'
  'refs/notes/*'` advertised only `HEAD -> refs/heads/main` and `main` at the
  reviewed head.
- A fresh mirror contained only `refs/heads/main`; `git fsck --full
  --no-reflogs` passed without errors.
- The previous public root (`4a10677`), previous remote Yaks root (`d265d0a`),
  and local Yaks notes head (`2c3df7a`) were absent from the fresh mirror.
- No public tags, notes, backup branches, releases, or pull-request refs were
  reachable. Local `refs/notes/yaks` remains local, and `yaks.remote` is unset.

## Secret and privacy review

- Every commit and blob reachable from public `main` was scanned for common
  cloud keys, OAuth client IDs and secrets, access and refresh tokens, GitHub,
  npm, Slack, and model-provider tokens, JWTs, and private-key markers. No
  credential signature matched.
- Reachable filenames contain no environment files, OAuth client JSON,
  auth-URL files, token directories, private keys, certificates, local state,
  worktrees, or Yaks projections.
- Targeted scans found no personal account email, private organization or cloud
  identifier, private URL, author-specific checkout path, or private Calendar
  data.
- GitHub secret scanning returned no alerts for the repository.

Expected public identity and fixture values were reviewed separately: Matt
Wynne's author/committer metadata and MIT copyright, the public `mattwynne`
repository owner, Mario Zechner and Earendil Works upstream attribution,
reserved `example.com` identities and example paths, and public dependency
metadata. The release plan explicitly treats the commit author's identity as
expected for this personal repository; no personal account address appears in
tracked content.

## CI hardening

- The workflow runs on pull requests and pushes to `main` with Node.js 24.
- Its only shell command is `npm run check`.
- Top-level permissions grant read-only repository contents.
- Checkout does not persist credentials.
- Official checkout and Node setup actions are pinned to immutable full commit
  SHAs corresponding to `actions/checkout` v7.0.1 and `actions/setup-node`
  v7.0.0.

## Publication boundary and verdict

The repository was already public before this final review. Replacing public
`main` with the sanitized root and deleting the public Yaks notes ref were
separate, explicitly approved actions. This review did not change repository
visibility or publish another ref.

**Verdict: PASS.** The reviewed public refs and reachable objects are suitable
for the reusable extension collection described in the release plan.
