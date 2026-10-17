# Contributing to MediaServer CLI

Thank you for your interest in contributing to MediaServer CLI! We welcome contributions from the community.

## Code of Conduct
Please be polite, respectful, and collaborative.

## Getting Started
1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run tests to ensure everything is working:
   ```bash
   npm test
   ```

## Development Workflow
- Follow modern ES Modules (ESM) syntax.
- Maintain compatibility with Node.js >= 18.
- Ensure audio files are handled with proper metadata (ID3, Vorbis Comments, SYLT/USLT lyrics, high-res covers).
- Before submitting a pull request, run `npm test` and verify all test suites pass.

## License
By contributing to this project, you agree that your contributions will be licensed under the **GNU General Public License v3.0 (GPL-3.0)**.
