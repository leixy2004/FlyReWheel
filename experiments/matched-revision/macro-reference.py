"""Independent exact/Decimal arithmetic references; no experiment or model run."""
from decimal import Decimal, localcontext
from fractions import Fraction
import json

with localcontext() as ctx:
    ctx.prec = 60
    h = (Decimal(2) * Decimal(40).ln() / Decimal(200)).sqrt()
    result = {
        "scope": "authored arithmetic references, not empirical intervals",
        "extreme_alpha_binary64_min_n2_half_width": str((Decimal(2).ln() - (Decimal(2) ** -1074).ln()).sqrt()),
        "family_equal_weight": str((Fraction(9, 10) + 0) / 2),
        "repository_equal_weight": str(((Fraction(1) + 0) / 2 + 1) / 2),
        "nested_repetition_episode_family": str((((Fraction(-1) + 0) / 2 + 1) / 2 + Fraction(-1, 2)) / 2),
        "hoeffding_n200_alpha_0_05_center_0_25": {
            "halfWidth": str(h),
            "lower": str(Decimal(".25") - h),
            "upper": str(Decimal(".25") + h),
        },
    }
print(json.dumps(result, indent=2))
