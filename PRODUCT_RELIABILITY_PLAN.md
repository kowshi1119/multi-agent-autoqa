# Product reliability continuation - 2026-09-22

1. Preserve existing discovery and cancellation work; reproduce remaining failures on synthetic local content.
2. Fix discovery: verify usable unique locators, reject unchanged login pages, remove URL query/fragment data, suppress credential-bearing logs, bound/cancel the session, and prevent stale profile results.
3. Guide setup before Start while retaining server checks. Test discovery, confirmation and auth-only through the real UI with fake credentials.
4. Verify fixture completion/evidence and Stop, cancellation and scoring regressions. Add one no-key local verification command and run types/build/full tests/corpus checks.
5. Update existing acceptance/setup documents with actual results. Ajeer has saved conditions but no successful AutoQA authentication evidence; never infer coverage from discovery.
6. Sync reviewed source/tests/sanitized docs under the existing GitHub authorization; retain private configuration and unrelated files locally.
