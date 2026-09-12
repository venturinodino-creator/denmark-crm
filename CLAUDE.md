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
