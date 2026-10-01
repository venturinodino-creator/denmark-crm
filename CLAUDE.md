# denmark-crm

## Never use inline `node -e`

Write the script to a `.js` / `.mjs` file and run `node file.js`. Create that
file with the Write tool, not a heredoc.

**Why.** On this machine a fragment of an inline one-liner can end up at
`cmd.exe`, which does not understand JavaScript, reads the `>` in an `=>` arrow
as an output redirection, and leaves a 0-byte file named after the next token.
That is the source of the stray files that keep appearing in the repo root —
`x.type`, `(a[r[k]]`, `ELIG.includes(i.type)`, `$(grep`, `${r[p]}`, `a`.

Reproduced directly:

    cmd /c "const vis = SEED.filter(x => x.type !== 'university')"   ->  creates  x.type
    cmd /c "const t = rows.reduce((a, r) => (a[r[k]] = 1, a), {})"   ->  creates  (a[r[k]]

Bash cannot produce these: it rejects the `(` with a syntax error and creates
nothing at all. The confirming evidence is a stray named `console.log('` that
was *not* empty — it contained cmd.exe's own `is not recognized as an internal
or external command` error text.

**Use the Write tool rather than a heredoc** for the script file. Heredocs whose
content carries apostrophes — `'university'`, Danish possessives — are what
breaks the quoting that starts the whole thing.

The strays are harmless individually, but they accumulate as untracked noise in
`git status` and a broad `git add` will eventually commit one.

## Working convention

- **Code changes go through a pull request.** One pull request per ticket, squash-merged, with the smoke check green once it exists here. Do not push code straight to `main`.
- **Scan workflows push data straight to `main`.** They commit their own output under `data/` and must keep working unattended, so `main` is deliberately not protected: protection rules would break every scan.
- **Rebase before merging.** The scans and other sessions push to `main` many times a day, so cut each branch from the current `main` and rebase it before the merge.
- **This repo mirrors `netherlands-crm`.** The Netherlands repo is the reference; `denmark-crm` and `belgium-crm` are near-copies kept in step by hand. Fixes and cleanups land there first and are mirrored here in the same ticket. Region data, Region wording, localised patterns and storage-key prefixes are intentionally different and are never mirrored.
- **Work from a clean worktree.** Another session may have uncommitted work in the main checkout.

## Testing

The smoke check opens every page in a real browser with sign-in and the database stubbed at the network boundary, and fails on any console error.

- First time: `npm install`, then `npx playwright install chromium`.
- Every time: `npm test`. One file or one test: `npx playwright test tests/smoke.spec.js -g "<name>"`.
- Nothing in `index.html` knows it is under test. Keep it that way: stub at the network (`tests/support/stubs.js`), never add a test flag to the page.
- New behaviour and bug fixes start with a failing test at this seam.
