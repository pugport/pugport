# Verdict whitespace is presentation, not a new decision

Date: 2026-11-21
Issue: https://github.com/pugport/pugport/issues/24
Owner ruling: Delegated by the owner to the maintainer's coding agent on 2026-11-21; this change records the ruling.
Decision: whitespace such as spaces and tabs before and after the verdict is accepted on the first non-empty line, for example
`  PASS @ <sha>` or a tab-indented `FAIL @ <sha>` with trailing spaces; blank lines before it stay accepted. Anything
else around the verdict, including Markdown emphasis, backticks, quote or list markers or lowercase words, and any
SHA that does not match the reviewed head, stays INVALID, and the bot still reads only the first non-empty line and
still needs one unambiguous verdict for the reviewed head.

Reason: leading whitespace is presentation, not a different decision, while wider formatting would make the contract
ambiguous.

Scope: the first-line verdict parser of the maintainer bot only.

Replaces: none.
