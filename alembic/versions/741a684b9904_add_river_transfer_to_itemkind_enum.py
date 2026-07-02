"""add river_transfer to itemkind enum

Revision ID: 741a684b9904
Revises: 69bae137ef49
Create Date: 2026-07-02 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '741a684b9904'
down_revision: Union[str, Sequence[str], None] = '69bae137ef49'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_VALUES = ('activity', 'restaurant', 'note', 'accommodation', 'flight', 'cycling',
               'rail', 'walk', 'transfer', 'tour', 'food', 'purchase', 'show', 'hire')
_NEW_VALUES = _OLD_VALUES + ('river_transfer',)


def upgrade() -> None:
    """Add 'river_transfer' as a new value of the 'itemkind' enum.

    On Postgres this is a real native ENUM type, and ALTER TYPE ... ADD VALUE
    cannot run inside a transaction block — Alembic wraps migrations in a
    transaction by default, hence the autocommit_block.

    SQLite has no native enum type: SQLModel/SQLAlchemy renders `kind` as a
    plain VARCHAR sized to the longest member (VARCHAR(13) in the baseline
    migration, since "accommodation" was the longest at 13 chars). SQLite
    doesn't actually enforce that length, but tests/test_alembic_drift.py
    compares the introspected column type against the live Python Enum, and
    "river_transfer" (14 chars) is now longer — so the column needs widening
    there too, via batch_alter_table (SQLite requires table-recreate for
    column type changes), or the drift guard fails even though the migration
    doesn't error.
    """
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute("ALTER TYPE itemkind ADD VALUE IF NOT EXISTS 'river_transfer'")
        return

    new_enum = sa.Enum(*_NEW_VALUES, name='itemkind')
    with op.batch_alter_table('itineraryitem', schema=None) as batch_op:
        batch_op.alter_column('kind', existing_type=sa.VARCHAR(length=13),
                               type_=new_enum, existing_nullable=False)
    with op.batch_alter_table('pendingchange', schema=None) as batch_op:
        batch_op.alter_column('kind', existing_type=sa.VARCHAR(length=13),
                               type_=new_enum, existing_nullable=False)


def downgrade() -> None:
    """Postgres has no clean way to remove a single value from an enum type
    (it would require rebuilding the type and every column/constraint that
    uses it) — a deliberate no-op there. Rolling back on Postgres would
    require re-kinding or deleting any river_transfer rows and rebuilding the
    enum type by hand; out of scope for an automated downgrade.

    On SQLite the column width can be cleanly reverted, so it is.
    """
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        return

    old_enum = sa.Enum(*_OLD_VALUES, name='itemkind')
    with op.batch_alter_table('itineraryitem', schema=None) as batch_op:
        batch_op.alter_column('kind', existing_type=sa.VARCHAR(length=14),
                               type_=old_enum, existing_nullable=False)
    with op.batch_alter_table('pendingchange', schema=None) as batch_op:
        batch_op.alter_column('kind', existing_type=sa.VARCHAR(length=14),
                               type_=old_enum, existing_nullable=False)
