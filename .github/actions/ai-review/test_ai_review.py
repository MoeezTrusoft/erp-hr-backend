import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('review', pathlib.Path(__file__).with_name('ai_review.py'))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ReviewIntegrityTests(unittest.TestCase):
    def test_invalid_provider_schemas_are_not_clean_reviews(self):
        for response in ['[]', '{}', '{"summary":"ok","findings":{}}', '{"summary":"ok","findings":[{"severity":"severe"}]}']:
            self.assertIsNone(review.parse_findings(response)[0])

    def test_empty_findings_need_an_explicit_valid_schema(self):
        self.assertEqual(review.parse_findings('{"summary":"Checked","findings":[]}'), ([], 'Checked'))

    def test_blocking_mode_fails_when_credentials_are_missing(self):
        with patch.object(review, 'API_KEY', ''), patch.object(review, 'BLOCKING', True):
            self.assertEqual(review.main(), 1)

    def test_truncation_is_visible_and_blocks_when_requested(self):
        published = []
        with patch.multiple(review, API_KEY='test-placeholder', BLOCKING=True, MAX_DIFF=5), patch.object(review, 'get_diff', return_value='a'*20), patch.object(review, 'call_model', return_value='{"summary":"Checked","findings":[]}'), patch.object(review, 'publish', side_effect=published.append):
            self.assertEqual(review.main(), 1)
        self.assertIn('Incomplete coverage', published[0])

    def test_human_comment_with_marker_is_never_overwritten(self):
        calls = []
        def gh(method, path, data=None):
            calls.append((method, path, data))
            if method == 'GET':
                return json.dumps([{'id':1,'user':{'login':'human'},'body':review.MARKER}, {'id':2,'user':{'login':'github-actions[bot]'},'body':review.MARKER}])
            return '{}'
        with patch.object(review, 'HEAD_SHA', ''), patch.object(review, 'gh', side_effect=gh):
            self.assertTrue(review.publish('result'))
        self.assertEqual(calls[-1][0], 'PATCH')
        self.assertTrue(calls[-1][1].endswith('/comments/2'))

    def test_stale_commit_never_posts(self):
        with patch.object(review, 'HEAD_SHA', 'old'), patch.object(review, 'gh', return_value='{"head":{"sha":"new"}}') as gh:
            self.assertFalse(review.publish('result'))
            self.assertEqual(gh.call_count, 1)


if __name__ == '__main__':
    unittest.main()
