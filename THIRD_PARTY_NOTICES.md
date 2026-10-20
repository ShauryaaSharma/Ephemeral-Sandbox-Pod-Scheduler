# Third-party notices

This file lists third-party source code vendored (copied directly) into this repository, as opposed to pulled in as an npm dependency (those are covered by their own `node_modules/*/LICENSE` files and aren't repeated here).

## xterm.js default terminal styles

- **Component**: default `.xterm` CSS, vendored into [`frontend/src/App.css`](frontend/src/App.css) (lines 43-74) rather than imported from the `xterm` package.
- **License**: MIT.
- **Source**: [xterm.js](https://github.com/xtermjs/xterm.js), `css/xterm.css`.
- **Copyright**: (c) 2014 The xterm.js authors; (c) 2012-2013 Christopher Jeffrey ([chjj/term.js](https://github.com/chjj/term.js)). The embedded header also credits an earlier fork, with permission, of Fabrice Bellard's VT100 terminal for jslinux ([bellard.org/jslinux](http://bellard.org/jslinux/)), (c) 2011 Fabrice Bellard.

The full license text is preserved verbatim in `App.css` itself - this entry doesn't restate it, only points to where it lives.

## Not listed here

`frontend/src/components/external/editor/` (file tree, file manager, Monaco editor wrapper, sidebar) was inspected for the same reason - no license file, header comment, copyright notice, or other attribution exists anywhere in that directory, in `package.json`, or nearby. Two things suggest it wasn't written from scratch for this repo, but neither is a verifiable source: Chinese-language inline comments documenting props/interfaces in `file-tree.tsx`/`file-manager.tsx`, and `utils/index.tsx`'s `useFilesFromSandbox` hook, which calls CodeSandbox's public API (`https://codesandbox.io/api/v1/sandboxes/:id`) directly. No entry is added here without a verifiable source - this is intentionally left for whoever can identify the actual origin to add properly, or to replace with original code.
