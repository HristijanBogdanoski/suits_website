# VESTRA

Frontend prototype for a made-to-measure suit house. A real 3D suit you scroll to turn
and drag to spin, switchable across six cloths, above a collection grid. No backend,
no framework.

## Running it

```bash
npm install
npm run build     # -> build/vestra-3d.html, self-contained, ~4.5 MB
npm run dev       # iterate at http://localhost:8781
npm run dev:csp   # verify at http://localhost:8790 before publishing
```

`npm run dev:csp` serves the built file behind the same Content Security Policy as the
sandboxed embed it gets published into. The plain dev server has no CSP and will run
pages that the sandbox refuses, so treat the CSP server as the real check.

## Credits

3D model: **Black Suit** by [TopNotch Assets](https://sketchfab.com/3d-models/black-suit-aa409a429ecf4766b1c0e8c83fc15771),
licensed under [CC Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).

Photography in `public/img/` is [Pexels](https://www.pexels.com) stock, free for
commercial use.

Type: Bodoni Moda and Archivo, via Google Fonts.
