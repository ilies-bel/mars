# Cost per completed Arc

The headline frugality KPI: cache-weighted tokens summed across an Arc, divided by the count of Arcs that reached done over the window — an outcome-denominated cost, so failed work is not amortised away into a flattering average. Chosen over raw tokens-per-task because tasks differ in size and the field rejects size normalisation (lines-changed is gameable and weakly correlates with difficulty); anchoring the denominator to completed Arcs is the accepted framing (cf. SWE-bench 'cost per resolved issue'). Per-Arc token spend is also reported as a distribution (median and p90), never a bare mean, because the variance from task size lives in the distribution: a regressing p90 is signal, a regressing mean may just be bigger legitimate work.

_Avoid_: tokens per task, tokens per arc, average cost, mean token spend
