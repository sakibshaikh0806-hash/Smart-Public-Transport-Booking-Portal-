# SmartTransport backend

## Run

```powershell
npm start
```

Open http://localhost:3000 in the browser. The backend serves the frontend and stores records in `database.json`.

## API endpoints

- `GET /api/health` - service status and booking count
- `GET /api/stats` - totals, revenue, users, and transport breakdown
- `GET /api/bookings` - list bookings with `search`, `status`, `transport`, `date`, `page`, and `limit` filters
- `GET /api/bookings/:id` - find a booking by ID or PNR
- `POST /api/bookings` - validate and create a booking
- `PATCH /api/bookings/:id` - confirm or cancel a booking
- `GET /api/users` - list saved display profiles
- `POST /api/users` - create or retrieve a display profile

The database also keeps a capped audit log for booking creation and status changes. No passwords or payment credentials are stored.
