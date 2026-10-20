# landing

Static marketing page for [Ephemeral Sandbox Pod Scheduler](../README.md) - a React + Vite single-page app with no backend connection and no environment variables.

Sections ([`src/App.tsx`](src/App.tsx), top to bottom): `Nav`, `Hero`, `HowItWorks`, `Security`, `SystemDesign`, `Stack`, `Marquee`, `Soon`, `What`. Each is a self-contained component under [`src/components/`](src/components/) with its own CSS file.

## Scripts

From `package.json`:

- `npm run dev` - Vite dev server (`:5173` by default).
- `npm run build` - type-checks (`tsc -b`) then builds for production (`vite build`) into `dist/`.
- `npm run preview` - serves the production build locally.
- `npm run lint` - [Oxlint](https://oxc.rs/docs/guide/usage/linter.html).

## Build & deploy

`npm run build` produces a static `dist/` - deploy it anywhere static files are served, with no environment variables to configure. See [HOSTING_GUIDE.md](../HOSTING_GUIDE.md) for a worked example (Cloudflare Pages) deploying this alongside [`frontend/`](../frontend).
