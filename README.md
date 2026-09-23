# Character Vault Battle Arena

A standalone turn-based battle website for Character Vault. Import two `.charv` character exports, choose each move, or turn on Auto-Battle. The page reads files in your browser; it does not upload or save them.

The combat rules in `static/js/fight.js` are copied unchanged from the main app. `arena/charv.js` converts exported stats, buffs, passives, gear, and items into the same fighter data used by that engine.

## Local preview

From this repository's root:

```powershell
py -3 -m http.server 8000
```

Open `http://localhost:8000/arena/`.

## GitHub Pages

The included workflow runs the import test and deploys only `index.html`, `arena/`, and `static/`. In repository settings, select **Pages → Build and deployment → GitHub Actions**.

To update combat after changing the main app, copy its latest `static/js/fight.js` into this repository, run `node tests/test_arena.js`, and push. The arena keeps its own visual system in `arena/arena.css`. The browser ZIP reader is JSZip 3.10.1; its license is at `arena/vendor/LICENSE.markdown`.
