# Travel Companion — Specification

## Overview

A web-based travel itinerary tracker. A FastAPI backend with SQLite stores trips, stops, and
itinerary items. A React frontend (compiled into `backend/static/`) is served by the same
server — no separate frontend process needed in production.

---

## Architecture

```
travelCompantion/
├── backend/          Python package — FastAPI + SQLModel
│   ├── main.py       App entrypoint; mounts routers and serves static files
│   ├── database.py   SQLite engine, session dependency, schema migrations
│   ├── models.py     SQLModel table + schema definitions
│   ├── importer.py   Seeds DB from Google Sheets CSV format
│   ├── sheets.py     Google Sheets OAuth fetch
│   ├── routers/
│   │   ├── trips.py         Trip CRUD + timeline
│   │   ├── stops.py         Stop CRUD + reorder
│   │   ├── items.py         ItineraryItem CRUD
│   │   └── sheets_import.py POST /import/sheets endpoint
│   └── static/       Compiled React bundle (git-committed, no Node needed to run)
├── frontend/         React + Vite + Tailwind source
│   └── src/
│       ├── api.js            Fetch wrapper + all API calls
│       ├── App.jsx           Root: trips list ↔ trip view ↔ edit mode
│       └── components/
│           ├── TripList.jsx          Trip list + Sheets import
│           ├── TripTimeline.jsx      Read-only timeline with progress
│           ├── StopCard.jsx          Expandable stop (read mode)
│           ├── ItemRow.jsx           Single item with status toggle
│           ├── EditTrip.jsx          Edit trip name + dates + stops
│           ├── EditStopCard.jsx      Editable stop form
│           └── EditItemsSection.jsx  Add/edit/delete items per stop
├── tests/            pytest suite for the backend API
└── SPEC.md           This file
```

**Run the app:**
```bash
pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --reload
# → http://localhost:8000
```

**Rebuild the frontend** (requires Node, only needed when changing frontend source):
```bash
cd frontend && npm install && npm run build
```

---

## Data Model

### Trip

| Field        | Type      | Description                        |
| ------------ | --------- | ---------------------------------- |
| `id`         | int PK    | Auto-increment                     |
| `name`       | str       | Display name                       |
| `start_date` | datetime? | Overall trip start date            |
| `end_date`   | datetime? | Overall trip end date              |
| `created_at` | datetime  | Record creation timestamp (server) |

### Stop

One leg of a trip. Ordered by `sort_order`, then `arrive`.

| Field                  | Type        | Description                          |
| ---------------------- | ----------- | ------------------------------------ |
| `id`                   | int PK      |                                      |
| `trip_id`              | int FK      | → Trip (cascade delete)              |
| `location`             | str         | City / place name                    |
| `country`              | str         |                                      |
| `arrive`               | datetime?   |                                      |
| `depart`               | datetime?   |                                      |
| `accommodation`        | str         |                                      |
| `accommodation_link`   | str         | Booking URL                          |
| `accommodation_notes`  | str         |                                      |
| `check_in`             | str         | Free text e.g. "14:00"               |
| `check_out`            | str         |                                      |
| `timezone`             | str         | UTC offset e.g. "+1"                 |
| `lat` / `lng`          | str         | Decimal degrees                      |
| `sort_order`           | int         | Explicit display ordering            |
| `status`               | StopStatus  | `planned \| confirmed \| completed \| cancelled` |

### ItineraryItem

Activity, restaurant, or note attached to a stop.

| Field          | Type        | Description                              |
| -------------- | ----------- | ---------------------------------------- |
| `id`           | int PK      |                                          |
| `stop_id`      | int FK      | → Stop (cascade delete)                  |
| `kind`         | ItemKind    | `activity \| restaurant \| note`         |
| `name`         | str         |                                          |
| `scheduled_at` | datetime?   | Scheduled time                           |
| `link`         | str         | URL                                      |
| `cost`         | str         | Free text e.g. "€20"                     |
| `notes`        | str         | Time prefix, cuisine type, walk time etc.|
| `status`       | ItemStatus  | `pending \| done \| skipped`             |

---

## API Reference

### Trips

| Method   | Path                      | Description                              |
| -------- | ------------------------- | ---------------------------------------- |
| `GET`    | `/trips/`                 | List all trips                           |
| `POST`   | `/trips/`                 | Create trip (`name`, optional `start_date`, `end_date`) |
| `GET`    | `/trips/{id}`             | Get trip                                 |
| `PATCH`  | `/trips/{id}`             | Update trip fields (all optional)        |
| `DELETE` | `/trips/{id}`             | Delete trip, its stops, and all items    |
| `GET`    | `/trips/{id}/timeline`    | Trip + ordered stops + items per stop    |

### Stops

| Method   | Path                        | Description                            |
| -------- | --------------------------- | -------------------------------------- |
| `GET`    | `/trips/{trip_id}/stops`    | List stops ordered by sort_order/arrive|
| `POST`   | `/trips/{trip_id}/stops`    | Create stop                            |
| `GET`    | `/stops/{id}`               | Get stop                               |
| `PATCH`  | `/stops/{id}`               | Update stop fields                     |
| `DELETE` | `/stops/{id}`               | Delete stop and its items              |
| `PATCH`  | `/stops/{id}/reorder`       | Set `sort_order` `{"sort_order": int}` |

### Items

| Method   | Path                        | Description              |
| -------- | --------------------------- | ------------------------ |
| `GET`    | `/stops/{stop_id}/items`    | List items               |
| `POST`   | `/stops/{stop_id}/items`    | Create item              |
| `GET`    | `/items/{id}`               | Get item                 |
| `PATCH`  | `/items/{id}`               | Update item fields       |
| `DELETE` | `/items/{id}`               | Delete item              |

### Import

| Method | Path              | Body                        | Description                        |
| ------ | ----------------- | --------------------------- | ---------------------------------- |
| `POST` | `/import/sheets`  | `{"trip_name": "..."}` | Fetch Google Sheets, seed new Trip |

---

## UI Screens

### Trips list (`/`)
- Lists trips; shows name and date range (`start_date → end_date`) or creation date as fallback
- Import panel: enter trip name → calls `POST /import/sheets`; browser opens for OAuth on first run
- Delete button (hover to reveal) → `DELETE /trips/{id}`

### Trip timeline
- Progress bar: completed stops / total stops
- Expandable `StopCard` per stop: accommodation, activities (with links/cost), restaurants
- Click stop status badge to cycle `planned → confirmed → completed`
- Click item `○` to cycle `pending → done → skipped`

### Edit trip (toggle via "Edit" button in header)
- **Trip panel**: name input, start date picker, end date picker — auto-saves on blur
- **Stop cards**: expand to edit all stop fields; explicit "Save stop" button per card
- **Items section**: inline edit per item (save on blur); `+ Add` row for new items; `✕` to delete
- **Add stop**: dashed button appends a blank stop

---

## Running Tests

```bash
# Backend (from repo root)
pip install -r backend/requirements.txt
pytest tests/ -v

# Frontend (from frontend/)
npm install
npm test
```
