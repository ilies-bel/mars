# Completion report

Machine-parseable fenced block a Coder must emit as its final message: one done/partial/blocked line per done-criterion with evidence (file:line, commit sha, test name). Parsed by the completeness verify gate; absent or unsubstantiated reports fail verification.

_Avoid_: self-report, summary, final report
