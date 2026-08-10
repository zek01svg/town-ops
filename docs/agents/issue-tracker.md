# Issue tracker: Linear

Issues and PRDs for this repo live in Linear's [`town-ops`](https://linear.app/zekkkv/project/town-ops-213e0e7eec93) project in the `Personal` team. Use the connected Linear MCP tools.

## Conventions

- Create or update issues with `linear_save_issue`.
- Read issues with `linear_get_issue`.
- List issues with `linear_list_issues`; search with `linear_search`.
- Add comments with `linear_save_comment`.
- Read statuses with `linear_list_issue_statuses`.
- Read or manage labels with `linear_list_issue_labels` and `linear_create_issue_label`.

When a skill says to publish to the issue tracker, create a Linear issue in the `Personal` team and associate it with the `town-ops` project. When it says to fetch a relevant ticket, use its Linear identifier with `linear_get_issue`.

GitHub PRs remain code-review artifacts and are not included in the Linear triage queue.
