#!/usr/bin/env python3
"""Generate a VAPID keypair for Web Push and print .env lines to paste in.

Run once per environment (keys are per-deployment, not per-device):
    python scripts/gen_vapid_keys.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.push import generate_vapid_keypair  # noqa: E402

if __name__ == "__main__":
    private_b64, public_b64 = generate_vapid_keypair()
    print("# Add to .env — keep VAPID_PRIVATE_KEY secret, VAPID_PUBLIC_KEY is exposed to clients")
    print(f"VAPID_PRIVATE_KEY={private_b64}")
    print(f"VAPID_PUBLIC_KEY={public_b64}")
    print("# VAPID_CONTACT_EMAIL=admin@tripplan.hups.club  # optional, used in push claims")
