import unittest
from hybrid_benchmark import numeric_consensus, parse_numeric

class ConsensusTests(unittest.TestCase):
    def test_missing_or_wrong_phone_digit_is_rejected(self):
        self.assertIsNone(parse_numeric('0905678', 'phone'))
        self.assertIsNone(numeric_consensus('09012345678', '09012345679', 'phone'))
        self.assertEqual(numeric_consensus('090 (1234) 5678', '０９０１２３４５６７８', 'phone'), ('09012345678',))

    def test_no_guessing_currency_digits(self):
        self.assertIsNone(parse_numeric('(,960', 'integer'))
        self.assertIsNone(parse_numeric('9.80', 'integer'))
        self.assertEqual(parse_numeric('1,960', 'integer'), (1960,))

    def test_preserve_branch_and_do_not_discard_negative_payment(self):
        self.assertEqual(parse_numeric('22505-14', 'product'), ('22505', '14'))
        self.assertIsNone(numeric_consensus('22505-14', '22505-1', 'product'))
        self.assertEqual(numeric_consensus('—0-', '→0←', 'deposit'), (0,))
        self.assertIsNone(parse_numeric('-100', 'deposit'))

if __name__ == '__main__':
    unittest.main()
