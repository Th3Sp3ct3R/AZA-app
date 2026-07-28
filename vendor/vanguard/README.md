# vendored Vanguard engine

Compiled build of the closed-source Vanguard engine (see LICENSE), vendored
so release CI can bundle it into the desktop runtime. Do not edit by hand —
regenerate from a Vanguard checkout with:

    node scripts/sync-vanguard.mjs [path-to-vanguard]
