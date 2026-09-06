# GitHub Pages deployment

Application: https://wieslawsoltes.github.io/ForgeStudio/

Portable application: https://wieslawsoltes.github.io/ForgeStudio/ForgeStudio.html

Source: https://github.com/wieslawsoltes/ForgeStudio

## Publishing

The `Publish Forge Studio` workflow runs on pushes to `main` and can be run manually. It runs the core tests, rebuilds and checks the committed portable HTML, and runs the Chromium integration suite before publishing.

Only the static runtime files are copied to `gh-pages`: `index.html`, `styles.css`, `ForgeStudio.html`, `LICENSE`, `src/`, `vendor/`, `.nojekyll`, and a `deployment.json` recording the source commit. The complete editable source, tests, tools, documentation, and screenshots remain on `main`.

GitHub Pages uses the root of `gh-pages` as its publishing source. The workflow explicitly requests a Pages build with the repository-scoped `GITHUB_TOKEN`, because pushes by that token do not automatically trigger another workflow. No personal access token, paid hosting, or application build dependencies are required.

After publication, the workflow checks the deployed source revision and the SHA-256 checksum of every static asset, then runs the Chromium integration suite against the public HTTPS application. Browser reports and screenshots are available as the workflow artifact `forge-browser-verification`.

Keep Settings > Pages > Source set to **Deploy from a branch**, with **gh-pages** and **/(root)** selected. The `Core validation` workflow also checks pull requests without publishing.

## Local development

```sh
npm test
npm run build:standalone
python3 tools/serve.py
```

Browser tests use separately installed Playwright tooling:

```sh
python3 -m pip install playwright
python3 -m playwright install chromium
python3 tests/browser_e2e.py
FORGE_URL=https://wieslawsoltes.github.io/ForgeStudio/ python3 tests/browser_e2e.py
```

`docs/SOURCE-INTEGRITY.json` records the checksums of the initial delivered source. It is provenance for the initial import, not a restriction on subsequent source changes.

GitHub's publishing-source documentation: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

GitHub's Pages build API: https://docs.github.com/en/rest/pages/pages#request-a-github-pages-build
