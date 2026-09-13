# Third-Party Notices

The bookmarklet runtime bundles the library below into `dist/site` at build time.
Nothing is loaded from a runtime CDN, and the website makes no third-party network
requests.

## fflate

- Version: `0.8.3` (exact-pinned in `package.json` as `"fflate": "0.8.3"`).
- License: MIT.
- Source: https://github.com/101arrowz/fflate (npm: https://www.npmjs.com/package/fflate)
- Verified package: `sha512-tbZNuJrLwGUp3zshBtdy4W+ORxZuIh8a5ilyIEQDC5rY1f3U20JMry0Ll3WBzU58EZKsEuJFXhb5gwv8CsPvgA==`, shasum `bc27d8eb30343d4d512abb03480202ce65d825fc`, no install or postinstall script.
- Copyright: Copyright (c) 2026 Arjun Barrett
- Used for: ZIP Store worker, bundled; no runtime CDN.
- Files used: `Zip` and `ZipPassThrough` from the package's ESM build, imported by
  `src/bookmarklet/archive-worker.js`.

```
MIT License

Copyright (c) 2026 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
