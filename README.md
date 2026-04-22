# Aristotle Landing

Rotating ASCII-art Aristotle bust. Three.js + `AsciiEffect` rendering a GLB model to a mono-spaced character grid.

## Structure

```
.
├── index.html          # entry (loads styles + main.js via importmap)
├── aristotle.glb       # 1.8 MB glTF binary of the bust
├── src/
│   ├── main.js         # scene, lighting, ASCII effect, animation loop
│   └── styles.css      # vignette, label, loading state
├── package.json        # Bun scripts
└── .gitignore
```

## Run locally

Needs [Bun](https://bun.sh/) (`curl -fsSL https://bun.sh/install | bash`).

```
bun run dev       # serves index.html with HMR on :3000
bun run build     # bundles into ./dist (minified)
bun run preview   # serves ./dist
```

Three.js is loaded from `unpkg` via an importmap, so there are no npm deps to install.

## Deploy

It's a static site — drop `index.html`, `aristotle.glb`, and `src/` on any host.

- **Vercel / Netlify / Cloudflare Pages**: connect the repo, leave build command blank, set output directory to `.`. (Or run `bun run build` and publish `dist/`.)
- **GitHub Pages**: push to `gh-pages` branch (or enable Pages on `main`) — no build step needed.
- **Bun**: `bun run build` produces a self-contained `dist/` you can upload anywhere.
