#!/usr/bin/env python3
"""Apply the explicit proxy setting to the selected live release before building.
The source release remains unchanged apart from this reviewed deployment adapter.
"""
from pathlib import Path
p = Path('backend/src/app.ts')
s = p.read_text()
if "app.set('trust proxy'" not in s:
    anchor = 'const app = express();'
    assert s.count(anchor) == 1, 'Unexpected app entry point; review required'
    s = s.replace(anchor, anchor + "\n\n// Trust only the configured reverse proxy address.\nif (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);", 1)
    p.write_text(s)
