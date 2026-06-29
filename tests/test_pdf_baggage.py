"""Tests for baggage parsing and aggregation in the PDF export."""
import pytest
from backend.pdf_export import _parse_baggage, _aggregate_baggage


# ── _parse_baggage ─────────────────────────────────────────────────────────────

class TestParseBaggage:
    def test_simple_kg(self):
        bags, kg, carry = _parse_baggage("23kg")
        assert bags == 1 and kg == 23.0 and carry is False

    def test_kg_with_space(self):
        bags, kg, carry = _parse_baggage("23 kg")
        assert bags == 1 and kg == 23.0 and carry is False

    def test_airline_K_shorthand(self):
        bags, kg, carry = _parse_baggage("40K")
        assert bags == 1 and kg == 40.0 and carry is False

    def test_multiplied_bags_K(self):
        bags, kg, carry = _parse_baggage("2 x 23K")
        assert bags == 2 and kg == 23.0 and carry is False

    def test_multiplied_bags_kg(self):
        bags, kg, carry = _parse_baggage("2 x 23kg")
        assert bags == 2 and kg == 23.0 and carry is False

    def test_multiplied_unicode_times(self):
        bags, kg, carry = _parse_baggage("2 × 23kg")
        assert bags == 2 and kg == 23.0 and carry is False

    def test_iata_pc_no_weight(self):
        bags, kg, carry = _parse_baggage("2PC")
        assert bags == 2 and kg is None and carry is False

    def test_iata_pc_with_kg(self):
        bags, kg, carry = _parse_baggage("2PC 32kg")
        assert bags == 2 and kg == 32.0 and carry is False

    def test_iata_pc_with_K(self):
        bags, kg, carry = _parse_baggage("2PC 32K")
        assert bags == 2 and kg == 32.0 and carry is False

    def test_bags_no_weight(self):
        bags, kg, carry = _parse_baggage("2 bags")
        assert bags == 2 and kg is None and carry is False

    def test_pieces_with_weight(self):
        bags, kg, carry = _parse_baggage("1 piece 23kg")
        assert bags == 1 and kg == 23.0 and carry is False

    def test_qualifier_text_ignored(self):
        # "40kg international Business (Non FF/Bronze)"
        bags, kg, carry = _parse_baggage("40kg international Business (Non FF/Bronze)")
        assert bags == 1 and kg == 40.0 and carry is False

    def test_carry_on_only(self):
        bags, kg, carry = _parse_baggage("carry-on")
        assert bags == 0 and carry is True

    def test_cabin_bag(self):
        bags, kg, carry = _parse_baggage("cabin bag")
        assert bags == 0 and carry is True

    def test_empty(self):
        bags, kg, carry = _parse_baggage("")
        assert bags == 0 and kg is None and carry is False

    def test_none(self):
        bags, kg, carry = _parse_baggage(None)
        assert bags == 0 and kg is None and carry is False


# ── _aggregate_baggage ─────────────────────────────────────────────────────────

class TestAggregateBaggage:
    def test_two_passengers_same_allowance(self):
        pax = [
            {"name": "Mr A", "baggage": "23kg"},
            {"name": "Mrs B", "baggage": "23kg"},
        ]
        hold, carry = _aggregate_baggage(pax)
        assert hold == "2 bags (46kg)"
        assert carry is False

    def test_two_passengers_multiplied_format(self):
        pax = [
            {"name": "Mr A", "baggage": "2 x 23kg"},
            {"name": "Mrs B", "baggage": "2 x 23kg"},
        ]
        hold, carry = _aggregate_baggage(pax)
        assert hold == "4 bags (92kg)"
        assert carry is False

    def test_no_weight_sum(self):
        pax = [{"name": "Mr A", "baggage": "2 bags"}, {"name": "Mrs B", "baggage": "2 bags"}]
        hold, carry = _aggregate_baggage(pax)
        assert hold == "4 bags"
        assert carry is False

    def test_carry_on_not_added_to_hold(self):
        pax = [
            {"name": "Mr A", "baggage": "23kg"},
            {"name": "Mrs B", "baggage": "carry-on"},
        ]
        hold, carry = _aggregate_baggage(pax)
        assert hold == "1 bag (23kg)"
        assert carry is True

    def test_all_carry_on(self):
        pax = [{"name": "Mr A", "baggage": "carry-on"}, {"name": "Mrs B", "baggage": "cabin bag"}]
        hold, carry = _aggregate_baggage(pax)
        assert hold is None
        assert carry is True

    def test_no_baggage_field(self):
        pax = [{"name": "Mr A", "seat": "12A"}, {"name": "Mrs B"}]
        hold, carry = _aggregate_baggage(pax)
        assert hold is None and carry is False

    def test_empty_list(self):
        hold, carry = _aggregate_baggage([])
        assert hold is None and carry is False

    def test_single_bag(self):
        pax = [{"name": "Mr A", "baggage": "23kg"}]
        hold, carry = _aggregate_baggage(pax)
        assert hold == "1 bag (23kg)"

    def test_legacy_string_passengers_ignored(self):
        # When passengers is a string (legacy), aggregate returns None
        hold, carry = _aggregate_baggage("Mr A, Mrs B")
        assert hold is None and carry is False
