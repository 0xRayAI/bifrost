# collector/

These files are committed. They are the feed modules plus `upstream/fetch_feed.py`.

A Docker build copies this directory. It does not run an assemble step. The image refuses to build when `upstream/fetch_feed.py` or `live_mesh.py` is missing.
