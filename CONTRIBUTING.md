# Contributing

## Read This First

We are accepting focused contributions, especially small bug fixes, reliability fixes, performance improvements, and maintenance work.

You can open an issue or PR, but please do so knowing that Forkara is still early and we are keeping scope, quality, and direction tight.

Large, unfocused, or direction-changing PRs may still be closed quickly.

PRs are automatically labeled with a `vouch:*` trust status and a `size:*` diff size based on changed lines.

If you are an external contributor, expect `vouch:unvouched` until we explicitly add you to [.github/VOUCHED.td](.github/VOUCHED.td).

## What We Are Most Likely To Accept

Small, focused bug fixes.

Small reliability fixes.

Small performance improvements.

Tightly scoped maintenance work that clearly improves the project without changing its direction.

## What We Are Least Likely To Accept

Large PRs.

Drive-by feature work.

Opinionated rewrites.

Anything that expands product scope without us asking for it first.

If you open a 1,000+ line PR full of new features, we will probably close it quickly and remember that you ignored the clearly written instructions.

## If You Still Want To Open A PR

Keep it small.

Explain exactly what changed.

Explain exactly why the change should exist.

Do not mix unrelated fixes together.

If the PR makes anything resembling a UI change, include clear before/after images.

If the change depends on motion, timing, transitions, or interaction details, include a short video.

If we have to guess what changed, we are much less likely to review it.

## Issues First

If you are thinking about a non-trivial change, open an issue first.

That gives you a chance to check whether the direction fits before spending time on a larger patch.

## Testing

Run the full workspace test suite from the repository root with:

```bash
bun run test
```

For focused web tests, pass paths relative to `apps/web` through the dedicated root command:

```bash
bun run test:web:focused src/path/to/example.test.ts
```

## Be Realistic

Opening a PR does not create an obligation on our side.

We may close it. We may ignore it. We may ask you to shrink it. We may reimplement the idea ourselves later.

If you are fine with that, proceed.
