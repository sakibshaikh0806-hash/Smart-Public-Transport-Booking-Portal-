const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATABASE_FILE = path.join(ROOT, "database.json");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const DEFAULT_DATABASE = { bookings: [], users: [], payments: [], auditLog: [] };
const BOOKING_STATUSES = new Set(["Confirmed", "Cancelled"]);

function readDatabase() {
  try {
    const database = JSON.parse(fs.readFileSync(DATABASE_FILE, "utf8"));
    return { ...DEFAULT_DATABASE, ...database };
  } catch (error) {
    return structuredClone(DEFAULT_DATABASE);
  }
}

function writeDatabase(database) {
  const temporaryFile = `${DATABASE_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2));
  fs.renameSync(temporaryFile, DATABASE_FILE);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function sendError(response, status, message, details = []) {
  return sendJson(response, status, { error: message, details });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy(new Error("Request body too large"));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function validateBooking(booking) {
  const required = ["id", "pnr", "transport", "source", "destination", "date", "people", "tier", "amount"];
  const missing = required.filter(field => booking[field] === undefined || booking[field] === null || booking[field] === "");
  if (missing.length) return { valid: false, details: missing.map(field => `${field} is required`) };
  if (!Number.isInteger(booking.people) || booking.people < 1 || booking.people > 10) {
    return { valid: false, details: ["people must be an integer between 1 and 10"] };
  }
  if (!Number.isFinite(booking.amount) || booking.amount < 0) {
    return { valid: false, details: ["amount must be a non-negative number"] };
  }
  if (booking.status && !BOOKING_STATUSES.has(booking.status)) {
    return { valid: false, details: ["status must be Confirmed or Cancelled"] };
  }
  return { valid: true, details: [] };
}

function matchesBooking(booking, url) {
  const search = (url.searchParams.get("search") || "").toLowerCase();
  const status = url.searchParams.get("status");
  const transport = url.searchParams.get("transport");
  const date = url.searchParams.get("date");
  return (!search || [booking.pnr, booking.source, booking.destination, booking.transport].some(value => String(value).toLowerCase().includes(search)))
    && (!status || booking.status === status)
    && (!transport || booking.transport === transport)
    && (!date || booking.date === date);
}

function addAudit(database, action, bookingId, request) {
  database.auditLog.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action, bookingId, created: new Date().toISOString(), ip: request.socket.remoteAddress || "unknown" });
  database.auditLog = database.auditLog.slice(0, 500);
}

function serveStatic(request, response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT + path.sep)) return sendJson(response, 403, { error: "Forbidden" });
  fs.readFile(file, (error, content) => {
    if (error) return sendJson(response, 404, { error: "File not found" });
    response.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(file)] || "application/octet-stream" });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] !== "api") {
    if (request.method !== "GET") return sendError(response, 404, "Route not found");
    return serveStatic(request, response, url.pathname);
  }

  if (parts[1] === "health" && request.method === "GET") {
    const database = readDatabase();
    return sendJson(response, 200, { ok: true, service: "smarttransport", version: "2.0", bookings: database.bookings.length, time: new Date().toISOString() });
  }

  const database = readDatabase();
  if (parts[1] === "stats" && request.method === "GET") {
    const confirmed = database.bookings.filter(booking => booking.status === "Confirmed");
    const byTransport = confirmed.reduce((result, booking) => { result[booking.transport] = (result[booking.transport] || 0) + 1; return result; }, {});
    return sendJson(response, 200, { total: database.bookings.length, confirmed: confirmed.length, cancelled: database.bookings.length - confirmed.length, revenue: confirmed.reduce((total, booking) => total + Number(booking.amount || 0), 0), byTransport, users: database.users.length });
  }

  if (parts[1] === "bookings") {
    if (request.method === "GET" && parts.length === 2) {
      const filtered = database.bookings.filter(booking => matchesBooking(booking, url));
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
      const start = (page - 1) * limit;
      return sendJson(response, 200, { bookings: filtered.slice(start, start + limit), pagination: { page, limit, total: filtered.length, pages: Math.ceil(filtered.length / limit) } });
    }
    if (request.method === "GET" && parts.length === 3) {
      const booking = database.bookings.find(item => item.id === parts[2] || item.pnr === parts[2]);
      return booking ? sendJson(response, 200, { booking }) : sendError(response, 404, "Booking not found");
    }
    if (request.method === "POST" && parts.length === 2) {
      try {
        const booking = await readBody(request);
        const validation = validateBooking(booking);
        if (!validation.valid) return sendError(response, 400, "Booking validation failed", validation.details);
        if (database.bookings.some(item => item.id === booking.id || item.pnr === booking.pnr)) return sendError(response, 409, "A booking with this ID or PNR already exists");
        const record = { ...booking, status: booking.status || "Confirmed", created: booking.created || new Date().toISOString(), updated: new Date().toISOString() };
        database.bookings.unshift(record);
        addAudit(database, "booking.created", record.id, request);
        writeDatabase(database);
        return sendJson(response, 201, { booking: record });
      } catch (error) {
        return sendError(response, 400, error.message);
      }
    }
    if (request.method === "PATCH" && parts.length === 3) {
      try {
        const booking = database.bookings.find(item => item.id === parts[2] || item.pnr === parts[2]);
        if (!booking) return sendError(response, 404, "Booking not found");
        const changes = await readBody(request);
        if (!BOOKING_STATUSES.has(changes.status)) return sendError(response, 400, "Only Confirmed or Cancelled status is allowed");
        booking.status = changes.status;
        booking.cancelled = changes.status === "Cancelled" ? (changes.cancelled || new Date().toISOString()) : undefined;
        booking.updated = new Date().toISOString();
        addAudit(database, `booking.${changes.status.toLowerCase()}`, booking.id, request);
        writeDatabase(database);
        return sendJson(response, 200, { booking });
      } catch (error) {
        return sendError(response, 400, error.message);
      }
    }
  }

  if (parts[1] === "users") {
    if (request.method === "GET" && parts.length === 2) return sendJson(response, 200, { users: database.users });
    if (request.method === "POST" && parts.length === 2) {
      try {
        const user = await readBody(request);
        if (!user.email || !user.name) return sendError(response, 400, "name and email are required");
        const email = String(user.email).trim().toLowerCase();
        const existing = database.users.find(item => item.email === email);
        if (existing) return sendJson(response, 200, { user: existing, created: false });
        const record = { id: `user-${Date.now()}`, name: String(user.name).trim(), email, created: new Date().toISOString() };
        database.users.push(record);
        writeDatabase(database);
        return sendJson(response, 201, { user: record, created: true });
      } catch (error) {
        return sendError(response, 400, error.message);
      }
    }
  }

  return sendError(response, 404, "API route not found");
});

server.listen(PORT, () => {
  console.log(`SmartTransport running at http://localhost:${PORT}`);
});
