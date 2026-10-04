import unittest
from benchmark import normalize, score_text, score_fields, edit_distance

class AccuracyTests(unittest.TestCase):
    def test_phone_digit_errors_are_not_hidden(self):
        self.assertEqual(normalize('０９０ １２３４\n５６７８'), '09012345678')
        self.assertFalse(score_fields('{"phone":"09012345679"}', {'fields': {'phone': '09012345678'}})['field_comparisons']['phone']['exact_match'])

    def test_correct_value_in_wrong_field_is_not_correct(self):
        result = score_fields('{"amount":980,"unitPrice":1960}', {'fields': {'amount': 1960, 'unitPrice': 980}})
        self.assertEqual(result['correct_fields'], 0)

    def test_missing_and_invalid_fields(self):
        self.assertFalse(score_fields('no JSON', {'fields': {'amount': 1960}})['structured_parse_ok'])
        result = score_fields('```json\n{"quantity":null}\n```', {'fields': {'quantity': 2}})
        self.assertEqual(result['correct_fields'], 0)

    def test_full_text_errors_and_number_types(self):
        self.assertEqual(edit_distance('1234', '1235'), 1)
        self.assertEqual(score_text('1235', {'text': '1234'})['character_error_rate'], .25)
        self.assertTrue(score_fields('{"quantity":2}', {'fields': {'quantity': '2'}})['field_comparisons']['quantity']['exact_match'])

if __name__ == '__main__':
    unittest.main()
