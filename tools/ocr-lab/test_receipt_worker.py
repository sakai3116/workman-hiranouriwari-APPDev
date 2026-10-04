import unittest
from recognize_receipt import clean_fields

class FieldValidationTests(unittest.TestCase):
    def test_invalid_digits_dates_and_amounts_do_not_reach_form(self):
        fields = clean_fields({'phone': '0905678', 'productNumber': '1234', 'receivedDate': '2026-02-30', 'amount': '9.80', 'quantity': 0, 'depositAmount': True})
        self.assertEqual(fields, {})

    def test_valid_phone_format_and_zero_deposit(self):
        fields = clean_fields({'phone': '090 (1234) 5678', 'productNumber': '22505', 'branchNumber': '14', 'amount': 1960, 'quantity': 2, 'depositAmount': 0})
        self.assertEqual(fields['phone'], '09012345678')
        self.assertEqual(fields['depositAmount'], 0)
        self.assertEqual(fields['branchNumber'], '14')

if __name__ == '__main__':
    unittest.main()
