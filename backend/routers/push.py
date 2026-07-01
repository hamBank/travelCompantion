"""Web Push subscription management.

/push/vapid-public-key is public (no PII, needed before login to register the
service worker's PushManager). Subscribe/unsubscribe require auth: a
subscription is always tied to the authenticated user's email, and can only be
removed by its owner.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..database import get_session
from ..auth import get_current_user
from ..models import PushSubscription, PushSubscriptionCreate
from ..push import get_vapid_public_key

router = APIRouter()


@router.get("/push/vapid-public-key")
def vapid_public_key():
    key = get_vapid_public_key()
    if not key:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    return {"key": key}


@router.post("/push/subscribe")
def subscribe(
    body: PushSubscriptionCreate,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    email = user["email"].lower()
    existing = session.exec(
        select(PushSubscription).where(PushSubscription.endpoint == body.endpoint)
    ).first()
    if existing:
        existing.user_email = email
        existing.p256dh = body.p256dh
        existing.auth = body.auth
        existing.device_label = body.device_label
        session.add(existing)
    else:
        session.add(PushSubscription(
            user_email=email, endpoint=body.endpoint,
            p256dh=body.p256dh, auth=body.auth, device_label=body.device_label,
        ))
    session.commit()
    return {"ok": True}


@router.delete("/push/subscribe")
def unsubscribe(
    endpoint: str,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    email = user["email"].lower()
    sub = session.exec(
        select(PushSubscription)
        .where(PushSubscription.endpoint == endpoint)
        .where(PushSubscription.user_email == email)
    ).first()
    if sub:
        session.delete(sub)
        session.commit()
    return {"ok": True}
