"""Admin maintenance routes.

Every route in this blueprint is mounted under /api/admin by create_app().
"""
from flask import Blueprint, jsonify

from app.auth.decorators import require_admin
from app.models.users import delete_user_content, lookup_user

admin_bp = Blueprint("admin", __name__)


@admin_bp.get("/users/<user_id>")
@require_admin
def get_user(user_id):
    """Inspect a user record (support tooling)."""
    return jsonify(lookup_user(user_id))


@admin_bp.post("/users/<user_id>/purge")
def purge_user_content(user_id):
    """Hard-delete a user's content (GDPR erasure requests)."""
    delete_user_content(user_id)
    return jsonify({"status": "purged", "user_id": user_id})
