"""Check release boundaries without any AWS environment definitions or values."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import release


class ReleaseTests(unittest.TestCase):
    def manifest(self, environment='dev'):
        return {
            'environment': environment,
            'branch': 'develop' if environment == 'dev' else 'master',
            'repository': 'github.com/topcoder-platform/files-api-v6',
            'cluster': 'files-api-v6', 'service': 'files-api-v6',
            'taskFamily': 'files-api-v6', 'images': {'files-api-v6': 'files-api-v6'},
        }

    def test_manifest_only_exists_temporarily_and_is_private(self):
        manifest = self.manifest()
        observed = []

        def execute(command, check):
            path = Path(command[command.index('--manifest') + 1])
            self.assertEqual(json.loads(path.read_text()), manifest)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertTrue(check)
            observed.append(path)

        with patch.dict(os.environ, {'DEPLOY_ENV': 'dev', 'CIRCLE_BRANCH': 'develop',
                                    'FILES_DEPLOY_MANIFEST': json.dumps(manifest)}, clear=True), \
                patch('release.subprocess.run', side_effect=execute):
            release.main()
        self.assertFalse(observed[0].exists())

    def test_rejects_wrong_branch_tag_environment_and_destination(self):
        for override in [{'CIRCLE_BRANCH': 'feature'}, {'CIRCLE_TAG': 'release'},
                         {'FILES_DEPLOY_MANIFEST': json.dumps(self.manifest('prod'))},
                         {'FILES_DEPLOY_MANIFEST': json.dumps({**self.manifest(), 'service': 'other'})}]:
            with self.subTest(override=list(override)), patch.dict(os.environ, {
                'DEPLOY_ENV': 'dev', 'CIRCLE_BRANCH': 'develop',
                'FILES_DEPLOY_MANIFEST': json.dumps(self.manifest()), **override,
            }, clear=True), patch('release.subprocess.run') as execute:
                with self.assertRaises(ValueError):
                    release.main()
                execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
