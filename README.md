# PR Agent Runner

AI-powered PR review automation built on [OpenCodeReview (OCR)](https://open-codereview.ai/) and a small TypeScript CLI that posts reviews and answers `@mention` commands on GitHub.

- **On PR open** — runs OCR on the PR diff and posts an inline review.
- **On `@mention`** — supports:
  - `@bot review` — re-run the review and post an updated review.
  - `@bot fix` — auto-apply critical/high findings with suggestions via a new fix PR.
  - any other text — chat about the PR (answers using the PR diff as context).

The whole flow is packaged as a **reusable composite action**, so any repository can opt in with a single `uses:` step.

## Requirements

### 1. GitHub App

Create a GitHub App (or reuse one) with the following permissions:

| Permission | Access |
|---|---|
| Pull requests | Read & write |
| Contents | Read & write |
| Issues | Read & write |

Install it on every repository that should be reviewed. The App token is used for all API calls (reviews, comments, fix branches/PRs), so it must have the permissions above on the target repos.

> **Fork PRs**: to run `@bot` commands on PRs from forks, the App must also be installed on the fork repositories (a pre-existing limitation).

### 2. Repository variables and secrets

Configure these on each target repository (or at organization level):

| Kind | Name | Description |
|---|---|---|
| Secret | `APP_PRIVATE_KEY` | GitHub App private key (PEM) |
| Variable | `APP_ID` | GitHub App ID |
| Secret | `OCR_LLM_AUTH_TOKEN` | LLM API token for OCR |
| Variable | `OCR_LLM_URL` | LLM endpoint URL |
| Variable | `OCR_LLM_MODEL` | LLM model name |
| Variable | `OCR_LLM_MAX_TOKENS` | *(optional)* LLM max tokens |
| Variable | `OCR_LLM_USE_ANTHROPIC` | *(optional)* `"true"` to use the Anthropic protocol |
| Variable | `OCR_LLM_PROTOCOL` | *(optional)* `anthropic` or `openai` (overrides `OCR_LLM_USE_ANTHROPIC`) |
| Variable | `OCR_LANGUAGE` | *(optional)* Review language, e.g. `English` or `日本語` |
| Variable | `COMPOSE_PR` | *(optional)* `"true"` to compose/update the PR title and body |
| Variable | `BOT_MENTION` | *(optional)* Bot mention trigger, e.g. `@my-bot` (default: `@opencode-review`) |

## Usage

Add a workflow to your repository (see [`examples/review-runner.yml`](examples/review-runner.yml)):

```yaml
name: PR Agent Runner

on:
  pull_request:
    types: [opened]
  issue_comment:
    types: [created]

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    concurrency:
      group: opencode-review-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: true
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - uses: makinosp/pr-agent-runner/actions/review@v1
        with:
          app-client-id: ${{ vars.APP_ID }}
          app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
          ocr-llm-url: ${{ vars.OCR_LLM_URL }}
          ocr-llm-token: ${{ secrets.OCR_LLM_AUTH_TOKEN }}
          ocr-llm-model: ${{ vars.OCR_LLM_MODEL }}
          # Optional inputs (defaults shown):
          # ocr-llm-max-tokens: ${{ vars.OCR_LLM_MAX_TOKENS }}
          # ocr-use-anthropic: ${{ vars.OCR_LLM_USE_ANTHROPIC }}
          # ocr-llm-protocol: ${{ vars.OCR_LLM_PROTOCOL }}
          # ocr-language: ${{ vars.OCR_LANGUAGE }}
          # compose-pr: ${{ vars.COMPOSE_PR }}
          # bot-mention: ${{ vars.BOT_MENTION }}
```

## Bot commands

With the default mention `@opencode-review` (customize via the `bot-mention` input / `BOT_MENTION` variable):

| Comment | Behavior |
|---|---|
| `@opencode-review review` | Re-run the review and post an updated review |
| `@opencode-review fix` | Apply critical/high findings with suggestions on a `fix/<bot>-<PR#>` branch and open a fix PR |
| `@opencode-review <question>` | Chat about the PR and reply in the thread |

## Action inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `app-client-id` | ✅ | — | GitHub App client ID |
| `app-private-key` | ✅ | — | GitHub App private key |
| `ocr-llm-url` | ✅ | — | LLM endpoint URL |
| `ocr-llm-token` | ✅ | — | LLM API token |
| `ocr-llm-model` | ✅ | — | LLM model name |
| `ocr-llm-max-tokens` | — | *(unset)* | LLM max tokens |
| `ocr-use-anthropic` | — | *(unset)* | `"true"` for Anthropic protocol |
| `ocr-llm-protocol` | — | *(unset)* | `anthropic` \| `openai` |
| `ocr-language` | — | `English` | Review language |
| `bot-mention` | — | `@opencode-review` | Mention trigger for comments |
| `compose-pr` | — | `false` | `"true"` to compose/update PR title and body |
| `ocr-version` | — | `1.7.16` | OCR CLI version |
| `runner-repository` | — | `makinosp/pr-agent-runner` | Repo hosting the runner CLI |
| `runner-ref` | — | `main` | Ref of the runner repo used for the CLI |
| `node-version` | — | `24` | Node.js version |
| `pnpm-version` | — | `11` | pnpm version |
| `fetch-depth` | — | `0` | Consumer repo checkout depth |

## Limitations

- The workflow triggers only on PR **`opened`** (not on new commits pushed later) and on created comments.
- `@bot` commands on fork PRs require the GitHub App to be installed on the fork.
- The `runner-ref` input pins which version of the runner CLI is used; pin to a release tag for stability.
