# GitHub Pages deployment

Application: https://wieslawsoltes.github.io/ForgeStudio/

Portable application: https://wieslawsoltes.github.io/ForgeStudio/ForgeStudio.html

Source: https://github.com/wieslawsoltes/ForgeStudio

## Publishing

The `Publish Forge Studio` workflow runs on pushes to `main` and can be run manually. It runs the core tests, rebuilds and checks the committed portable HTML, and runs the Chromium integration suite before publishing.

Only the static runtime files are uploaded to the Pages artifact: `index.html`, `styles.css`, `ForgeStudio.html`, `LICENSE`, `src/`, `vendor/`, `.nojekyll`, and a `deployment.json` recording the source commit. The complete editable source, tests, tools, documentation, and screenshots remain on `main`.

The workflow uses the official `actions/configure-pages`, `actions/upload-pages-artifact`, and `actions/deploy-pages` actions. It authenticates with the repository-scoped `GITHUB_TOKEN` and OpenID Connect. Repository contents are read-only during publishing; no personal access token, deployment branch, paid hosting, or application build dependencies are required.

After publication, the workflow checks the deployed source revision and the SHA-256 checksum of every static asset, then runs the Chromium integration suite against the public HTTPS application. Browser reports and screenshots are available as the workflow artifact `forge-browser-verification`.

Keep Settings > Pages > Source set to **GitHub Actions**. The `Core validation` workflow also checks pull requests without publishing.

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

GitHub's custom workflow documentation: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
