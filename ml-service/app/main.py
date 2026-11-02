"""ASGI entry point: `uvicorn app.main:app --port 8001` (run from ml-service/)."""
from app.api.app import create_app

app = create_app()
