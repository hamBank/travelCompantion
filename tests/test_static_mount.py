"""backend/static/ is gitignored build output, so a fresh checkout has none until
the first frontend build. The backend must still start and serve the API, and
answer 404 (not 500) for frontend paths, rather than skipping the static mount
and never serving the frontend until a restart."""
import os

from backend import main


def test_static_directory_exists_after_import():
    assert os.path.isdir(main._static)


def test_unknown_frontend_path_is_404_not_500(client):
    assert client.get("/definitely-missing.js").status_code == 404


def test_api_works_regardless_of_the_frontend_build(client):
    assert client.get("/health").status_code == 200
