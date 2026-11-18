# CloseProof for Jira

**Evidence-checked month-end close for finance teams, inside Jira.** A controller sees which account reconciliations are really done, and which only look done.

Close checklists in Jira already exist. CloseProof adds the checks a controller or auditor otherwise does by hand:

- the numbers tie out to the last cent;
- last month's closing balance rolls forward into this month;
- the person who prepared a reconciliation is not the person who reviewed it;
- the supporting evidence has not been changed, replaced or deleted since it was attached;
- nothing was edited after sign-off.

All data stays on Atlassian (Forge storage, no external calls), so the app is eligible for *Runs on Atlassian*.

## What you get

| Surface | What it does |
|---|---|
| **Month-end close** (Jira project page) | Period picker, progress bar, one row per account reconciliation with status, unexplained difference and exceptions. *Verify evidence* re-downloads every evidence file and re-hashes it. *Issue close certificate* is enabled only when every reconciliation is reviewed and clean. |
| **Reconciliation** (Jira issue panel) | Enter GL balance, source balance (bank or sub-ledger), opening balance and reconciling items. Pick supporting documents from the issue's attachments; CloseProof stores each file's SHA-256. Sign as preparer, then a different person signs as reviewer. Full history. |
| **Close Controller** (Rovo agent) | Answers "What is blocking this month's close?", explains a reconciliation's exceptions and drafts the close memo from verified facts. The agent only explains; every rule is checked by deterministic code. |
| **CloseProof MCP tools** | The same four read-only tools (`get-close-status`, `list-close-exceptions`, `explain-reconciliation`, `draft-close-memo`) for MCP clients connected to your Atlassian site. |

Everything except the agent works without Rovo.

## Controls

| ID | Control | Exception when |
|---|---|---|
| C1 | Tie-out | GL − source − reconciling items ≠ 0 (blocker above materiality, warning below) |
| C2 | Roll-forward | Prior period not reviewed, or opening balance ≠ prior period's reviewed GL closing balance |
| C3 | Segregation of duties | Reviewer is the preparer, review without preparation, or review dated before preparation |
| C4 | Evidence present | No supporting document attached |
| C5 | Evidence intact | An evidence file was deleted, replaced by another file with the same name, or its SHA-256 changed |
| C6 | Changed after sign-off | The record's content hash differs from the hash taken at preparation or review |
| C7 | Stale items | A reconciling item is older than the stale-item limit (default 60 days) at period end |

Amounts are stored as integer minor units (never floating point). Sign-off hashes are SHA-256 over a canonical JSON of the record's accounting content. The close certificate is one SHA-256 over every reviewed reconciliation of the period, so anyone can recompute it.

## Try it in two minutes

1. Install the app on a Jira Cloud site and open any project you can edit.
2. Open **Apps → Month-end close** in the project sidebar.
3. Click **Load demo close**. CloseProof creates eight reconciliation issues with CSV statements attached, with one planted problem per control.
4. Watch the exceptions appear, click **Verify evidence**, then open an issue and use the **Reconciliation** panel.
5. If your site has Rovo, ask the **Close Controller** agent: *"What is blocking this month's close?"*

User guide: [docs/index.html](docs/index.html). Privacy: [docs/privacy.html](docs/privacy.html). Support: [docs/support.html](docs/support.html).

## Permissions

| Scope | Why |
|---|---|
| `read:jira-work` | Read issues and download evidence attachments to hash them |
| `write:jira-work` | Create the demo issues and upload their demo statements (only when you click *Load demo close*) |
| `storage:app` | Store reconciliations, sign-offs and certificates in Forge storage |

All Jira calls run as the signed-in user (`asUser()`), and every resolver and Rovo action first checks the user's own Jira project permissions (Browse projects to read, Edit issues to write).

## Development

Requirements: Node.js 24 and the [Forge CLI](https://developer.atlassian.com/platform/forge/set-up-forge/).

```sh
npm install
node --test "test/*.test.js"     # unit tests for the controls, money and period helpers
forge lint
forge deploy -e development
forge install --site <your-site>.atlassian.net --product jira -e development
```

Code map:

- `src/lib/controls.js`: the seven controls as pure functions (unit tested)
- `src/service.js`: business operations shared by the UI resolvers and the Rovo actions
- `src/store.js`: Forge KVS data model
- `src/jira.js`: Jira REST calls (asUser)
- `src/frontend/`: UI Kit project page and issue panel
- `src/actions.js`, `prompts/`, `skills/`: Rovo agent, actions and skill

## License

MIT
