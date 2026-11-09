#!/usr/bin/env python3
"""Deploy using a manifest supplied by the protected environment context."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    environment = os.environ['DEPLOY_ENV']
    branch = {'dev': 'develop', 'prod': 'master'}[environment]
    manifest = json.loads(os.environ['FILES_DEPLOY_MANIFEST'])
    expected = {
        'environment': environment,
        'branch': branch,
        'repository': 'github.com/topcoder-platform/files-api-v6',
        'cluster': 'files-api-v6',
        'service': 'files-api-v6',
        'taskFamily': 'files-api-v6',
        'images': {'files-api-v6': 'files-api-v6'},
    }
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError('Deployment manifest does not match this service and environment.')
    if os.environ.get('CIRCLE_BRANCH') != branch or os.environ.get('CIRCLE_TAG'):
        raise ValueError('Deploy only the protected environment branch, never a tag.')
    with tempfile.TemporaryDirectory(prefix='files-release-') as directory:
        path = Path(directory) / 'manifest.json'
        path.write_text(json.dumps(manifest))
        path.chmod(0o600)
        subprocess.run([
            sys.executable, '-I', '/tmp/tc-deploy-scripts/tcdeploy.py',
            'deploy', '--manifest', str(path),
            '--image', 'files-api-v6=files-api-v6:candidate',
        ], check=True)


if __name__ == '__main__':
    main()
