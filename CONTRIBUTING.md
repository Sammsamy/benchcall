# Contributing to benchcall

Thanks for wanting to help! Two ground rules keep this project sustainable:

## 1. Contributor License Agreement (CLA)

By submitting a pull request, you agree that:

- You wrote the contribution (or have the right to submit it), and
- You grant **Fuzlullah Syed** a perpetual, worldwide, irrevocable, royalty-free license to use, modify, distribute, and **re-license** your contribution as part of this project or derivative works, under any license.

This is the standard open-core arrangement: it keeps the project able to offer commercial licenses and evolve its licensing without tracking down every past contributor. If you can't agree to this, please open an issue describing your change instead of a PR — issues and ideas are always welcome without any agreement.

Sign-off: include `Signed-off-by: Your Name <email>` in your commit message (`git commit -s`). A sign-off on a PR to this repository constitutes agreement to the above.

## 2. What makes a good PR here

- **Adapters** for new voice platforms are the most valuable contribution. Implement `VoicePlatformAdapter` (see `runner/src/adapters/types.ts`), verify endpoint shapes against the platform's live docs, and include mocked-fetch tests like `runner/test/vapi.test.ts`.
- Tests required; `npm test` must stay green.
- Every LLM call must have timeout, retry, and cost logging — see `runner/src/llm/retry.ts`.
- Keep the privacy invariant: **call transcripts never leave the operator's environment** in any code path that syncs data.

## Not accepted in this repo

The hosted generation service, meta-prompts, and template packs are proprietary and not in this repository — PRs reimplementing "generation" here will be declined so the project stays sustainable (that's the part that pays for maintenance).
