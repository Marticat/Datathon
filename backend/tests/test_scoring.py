from decimal import Decimal

import pytest

from app.seed import DEFAULT_CHECKLIST
from app.services.scoring import CriterionSpec, ScoringError, calculate_score, normalize_answer


def spec_from(d):
    return CriterionSpec(
        criterion_id=d["criterion_id"], weight=Decimal(d["weight"]), scoring_type=d["scoring_type"],
        allowed_values=tuple(d["allowed_values"]), na_allowed=d.get("na_allowed", False),
        is_gross_error=d.get("is_gross_error", False), section=d.get("section"),
    )


CHECKLIST = [spec_from(c) for c in DEFAULT_CHECKLIST["criteria"]]
ALL_YES = {"C01": "Yes", "C02": "Yes", "C03": "Yes", "C04": "20", "C05": "Yes", "C06": "10", "C07": "Yes", "C08": "No"}
ALL_NO = {"C01": "No", "C02": "No", "C03": "No", "C04": "0", "C05": "No", "C06": "0", "C07": "No", "C08": "No"}


def test_all_yes_is_100():
    r = calculate_score(ALL_YES, CHECKLIST)
    assert r.score == Decimal("100.00")
    assert r.applicable_weight == 100
    assert r.gross_error is False


def test_all_no_is_0():
    assert calculate_score(ALL_NO, CHECKLIST).score == Decimal("0.00")


def test_scaled_proportional():
    # C04 15/20 of 20 = 15, C06 7/10 of 15 = 10.5 -> 100 - 5 - 4.5 = 90.5
    r = calculate_score(ALL_YES | {"C04": "15", "C06": "7"}, CHECKLIST)
    assert r.score == Decimal("90.50")
    c06 = next(c for c in r.criteria if c.criterion_id == "C06")
    assert c06.points == Decimal("10.5")


def test_scaled_numeric_input_normalized():
    r = calculate_score(ALL_YES | {"C04": 10, "C06": "4.0"}, CHECKLIST)
    assert next(c for c in r.criteria if c.criterion_id == "C04").answer == "10"
    # 100 - 10 - 15*0.6=9 -> 81
    assert r.score == Decimal("81.00")


def test_single_na_redistribution():
    # C03 (20) N/A, C01 No (10): earned 70 of 80 -> 87.5
    r = calculate_score(ALL_YES | {"C03": "N/A", "C01": "No"}, CHECKLIST)
    assert r.applicable_weight == Decimal(80)
    assert r.score == Decimal("87.50")
    eff = {c.criterion_id: c.effective_weight for c in r.criteria if c.counts_toward_score}
    assert sum(eff.values()) == Decimal("100.00")
    assert eff["C02"] == Decimal("18.75")


def test_multiple_na():
    # C02,C03,C04,C07 N/A -> applicable C01 10 + C05 15 + C06 15 = 40 ; C06=7 -> 10+15+10.5 = 35.5/40
    r = calculate_score(ALL_YES | {"C02": "N/A", "C03": "N/A", "C04": "N/A", "C07": "N/A", "C06": "7"}, CHECKLIST)
    assert r.applicable_weight == Decimal(40)
    assert r.score == Decimal("88.75")


def test_all_na_not_calculable():
    specs = [CriterionSpec("A", Decimal(50), na_allowed=True), CriterionSpec("B", Decimal(50), na_allowed=True)]
    r = calculate_score({"A": "N/A", "B": "N/A"}, specs)
    assert r.score is None and not r.is_calculable
    assert r.applicable_weight == 0


def test_gross_error_separate_from_score():
    r = calculate_score(ALL_YES | {"C08": "Yes"}, CHECKLIST)
    assert r.gross_error is True
    assert r.score == Decimal("100.00")


def test_rounding_half_up_two_decimals():
    specs = [CriterionSpec("A", Decimal(1)), CriterionSpec("B", Decimal(1)), CriterionSpec("C", Decimal(1))]
    assert calculate_score({"A": "Yes", "B": "No", "C": "No"}, specs).score == Decimal("33.33")
    assert calculate_score({"A": "Yes", "B": "Yes", "C": "No"}, specs).score == Decimal("66.67")
    specs8 = [CriterionSpec(str(i), Decimal(1)) for i in range(8)]
    # 1/8 = 12.5 exactly; 0.125 *100 -> check half-up on 3rd decimal with 1/16
    specs16 = [CriterionSpec(str(i), Decimal(1)) for i in range(16)]
    assert calculate_score({str(i): "Yes" if i < 1 else "No" for i in range(16)}, specs16).score == Decimal("6.25")
    assert calculate_score({str(i): "Yes" if i < 1 else "No" for i in range(8)}, specs8).score == Decimal("12.50")
    s = [CriterionSpec("A", Decimal(1)), CriterionSpec("B", Decimal(7))]  # 1/8 * 100 = 12.5
    assert calculate_score({"A": "Yes", "B": "No"}, s).score == Decimal("12.50")
    s = [CriterionSpec("A", Decimal("0.005")), CriterionSpec("B", Decimal("99.995"))]  # 0.005 -> 0.01 half up
    assert calculate_score({"A": "Yes", "B": "No"}, s).score == Decimal("0.01")


def test_sections():
    r = calculate_score(ALL_YES | {"C01": "No"}, CHECKLIST)
    s1 = r.sections["Начало и понимание запроса"]
    assert s1["score"] == Decimal("60.00")  # 15 of 25
    assert "Грубые нарушения" not in r.sections


def test_inactive_criteria_ignored():
    specs = [CriterionSpec("A", Decimal(100)), CriterionSpec("B", Decimal(50), is_active=False)]
    assert calculate_score({"A": "Yes"}, specs).score == Decimal("100.00")


@pytest.mark.parametrize("bad", [
    {k: v for k, v in ALL_YES.items() if k != "C05"},       # missing
    ALL_YES | {"C99": "Yes"},                                # unknown
    ALL_YES | {"C01": "Maybe"},                              # invalid binary
    ALL_YES | {"C04": "12"},                                 # not a scale step
    ALL_YES | {"C01": "N/A"},                                # N/A forbidden
])
def test_invalid_inputs_raise(bad):
    with pytest.raises(ScoringError):
        calculate_score(bad, CHECKLIST)


def test_answer_aliases():
    c01 = CHECKLIST[0]
    assert normalize_answer("да", c01) == "Yes"
    assert normalize_answer(" no ", c01) == "No"
    assert normalize_answer("иә", c01) == "Yes"
    assert normalize_answer("n/a", CHECKLIST[1]) == "N/A"
    with pytest.raises(ScoringError):
        normalize_answer(True, c01)


def test_works_with_orm_rows(db):
    from app.services import checklist_service
    v = checklist_service.get_active(db)
    assert calculate_score(ALL_YES, v.criteria).score == Decimal("100.00")
